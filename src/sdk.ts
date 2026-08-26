// The composition: one pool, one transaction discipline, the kits wired to it.
//
// Everything here was 146 lines in one application. Moving it into a versioned
// package is what lets a dashboard add a kit by writing configuration rather
// than writing engineering — and what makes a bug in the composition fixable by
// publishing a version rather than by a pull-request campaign across every
// repository that copied it.
//
// The one property the whole family rests on: every kit takes a `SqlExecutor`
// rather than a connection, so all of them share a single pool and a single
// transaction. A pool per kit is four transaction disciplines that cannot see
// each other's work, and the kits stop composing at all.

import { createRequire } from 'node:module';
import { optional, required } from './env.js';
import { assertIsolationEnforced, type OnExempt } from './isolation.js';
import { lazy } from './lazy.js';
import {
  type KitName,
  type MigrateResult,
  type MigrationStep,
  migrate,
  migrationPlan,
  ORDER,
  validateKits,
} from './migrate.js';

/** The narrow database dependency every kit in the family takes. */
export interface SqlExecutor {
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]>;
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

/** A `pg.Pool`, structurally — so this package does not import `pg` and force it
 *  on an app that supplies its own driver. */
export interface Pool {
  query<R = unknown>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
  connect(): Promise<PoolClient>;
  end(): Promise<void>;
}

export interface PoolClient {
  query<R = unknown>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
  release(): void;
}

export interface SdkOptions {
  /**
   * Which kits are on.
   *
   * The dashboard writes this. A kit that is not listed is not constructed and
   * its migrations are not applied — and reaching for it throws a message saying
   * how to turn it on, rather than returning undefined and failing somewhere
   * else entirely.
   */
  kits: readonly KitName[];
  /** Supplied by the app. Built from `DATABASE_URL` when omitted. */
  pool?: Pool;
  /**
   * What to do when row-level security does not apply to the connecting role.
   *
   * Defaults to `throw` in production and `warn` everywhere else — because every
   * developer running homebrew Postgres is a superuser, and an SDK that refuses
   * to start on a laptop is one that gets ripped out on day one. The safe
   * setting is the one nobody has to remember.
   */
  onExempt?: OnExempt;
  /** For tests, and for a host that routes logs somewhere. */
  log?: (message: string) => void;
}

export class KitNotEnabled extends Error {
  constructor(readonly kit: KitName) {
    super(
      `${kit}-kit is not enabled. Add '${kit}' to the kits list in your QuxKit config — ` +
        `and make sure @quxkit/${kit}-kit is installed, since the SDK composes what you have ` +
        `rather than bundling everything.`,
    );
    this.name = 'KitNotEnabled';
  }
}

/** One pool per process, across hot reloads.
 *
 *  A framework that reloads modules per route in development creates a pool per
 *  edit otherwise, and the connection limit is reached by lunchtime. Keyed on a
 *  global rather than a module variable precisely because the module is what
 *  gets reloaded. */
declare global {
  var __quxkitPool: Pool | undefined;
}

export interface Sdk {
  readonly pool: Pool;
  /** Which kits this instance was told about. */
  readonly kits: readonly KitName[];
  /** True once the pool has actually been constructed. */
  readonly warm: boolean;

  /** The files that would be applied, in order, without applying them. An
   *  installer writing to somebody else's database had better be able to show
   *  the plan first. */
  migrationPlan(): MigrationStep[];
  migrate(onStep?: (step: MigrationStep) => void): Promise<MigrateResult>;

  /** Throws `KitNotEnabled` unless the kit is on. For an app to guard a route
   *  that only makes sense with a kit present. */
  require(kit: KitName): void;
  has(kit: KitName): boolean;
}

export function createSdk(options: SdkOptions): Sdk {
  const kits = [...new Set(options.kits)];
  const enabled = new Set<KitName>(kits);
  const log = options.log ?? ((message: string) => console.warn(message));
  const onExempt: OnExempt =
    options.onExempt ?? (process.env.NODE_ENV === 'production' ? 'throw' : 'warn');

  // Validated at construction, not on first query. A configuration naming a kit
  // that does not exist should say so while somebody is looking at the config.
  // The canonical list lives with the schemas. Keeping a second copy here is
  // how the two drift, and a name this list is missing gets rejected as unknown
  // even though the kit is wired.
  const known: readonly KitName[] = ORDER;

  for (const kit of kits) {
    if (!known.includes(kit)) {
      throw new Error(`Unknown kit "${kit}". Known kits: ${known.join(', ')}.`);
    }
  }
  // The rules, not the paths. Fails here rather than in the middle of a
  // migration run against a real database — but without resolving any kit's
  // package, so an app that enabled four does not need all eight installed just
  // to construct.
  validateKits(kits);

  let built = false;

  const pool: Pool =
    options.pool ??
    lazy<Pool>(() => {
      if (globalThis.__quxkitPool) {
        built = true;
        return globalThis.__quxkitPool;
      }
      // Loaded here rather than at module scope so an app supplying its own
      // pool never needs `pg` installed at all.
      //
      // `createRequire` rather than a bare `require`: this package builds to ESM
      // as well as CJS, and in the ESM output `require` is not defined — the
      // failure is a ReferenceError on the first query, a long way from the
      // import that caused it.
      const load = createRequire(import.meta.url);
      const { Pool: PgPool } = load('pg') as {
        Pool: new (config: { connectionString: string }) => Pool;
      };
      const created = new PgPool({
        connectionString: required('DATABASE_URL', 'Every kit shares one connection.'),
      });
      globalThis.__quxkitPool = created;
      built = true;

      // Checked at the moment the connection exists rather than at boot: this is
      // when there is something to ask, and a boot-time check in a framework
      // that compiles for several runtimes will run somewhere with no sockets.
      void assertIsolationEnforced(created, onExempt, log).catch((error: unknown) => {
        if (onExempt === 'throw') throw error;
        log(`[quxkit] isolation check failed: ${error instanceof Error ? error.message : error}`);
      });
      return created;
    });

  return {
    pool,
    kits,
    get warm() {
      return built || options.pool !== undefined;
    },
    migrationPlan: () => migrationPlan(kits),
    migrate: (onStep) => migrate({ query: (text) => pool.query(text) }, kits, onStep),
    has: (kit) => enabled.has(kit),
    require: (kit) => {
      if (!enabled.has(kit)) throw new KitNotEnabled(kit);
    },
  };
}

export type { KitName, MigrateResult, MigrationStep, OnExempt };
export { assertIsolationEnforced, lazy, optional, required };
