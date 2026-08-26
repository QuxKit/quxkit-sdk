// Every schema the enabled kits need, in the order the kits require.
//
// The kits ship their SQL inside their packages rather than asking anyone to
// copy it, so this resolves each one through `require.resolve` and applies named
// files. What is worth having in a package rather than in an app is the ORDER —
// six of tenant-kit's six, three of identity-kit's eight, and some of those must
// follow others. That sequence is knowledge, and it was held in one app.
//
// Every statement in every one of these files is guarded, so re-running the
// whole list is a no-op. That is a property of the kits, not of this file, and
// it is why an installer can run migrations on a schedule without a lock table.

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

export type KitName =
  | 'identity'
  | 'tenant'
  | 'billing'
  | 'crypto'
  | 'mail'
  | 'comm'
  | 'integration'
  | 'content'
  | 'translation'
  | 'domain';

interface KitSchema {
  package: string;
  /**
   * The files to apply, in order.
   *
   * A kit's whole schema, named explicitly rather than globbed — a list you can
   * read and review, and one a stray file in a package cannot quietly join.
   * `test/schema.test.ts` asserts each list against the kit's own `sql/`, which
   * is the only thing that keeps an explicit list honest: the first version of
   * this table was hand-written and five of eight entries were wrong, one of
   * them naming a file that has never existed.
   */
  files: string[];
  /** Applied only when this other kit is also on. */
  requires?: KitName[];
}

const SCHEMAS: Record<KitName, KitSchema> = {
  identity: {
    package: '@quxkit/identity-kit',
    // All eight. An earlier version applied three — core, hardening, events —
    // on the reasoning that MFA, API keys, OIDC, passkeys and magic links are
    // opt-in. They are opt-in *features*, but this SDK is the surface a kit is
    // turned on through, so the cost of omitting them is `identity.passkeys`
    // failing on a missing table at runtime, and the cost of applying them is
    // four empty tables. Take the empty tables.
    files: [
      '001_identity.sql',
      '002_mfa.sql',
      '003_apikeys.sql',
      '004_oidc.sql',
      '005_hardening.sql',
      '006_events.sql',
      '007_passkeys.sql',
      '008_magic.sql',
    ],
  },
  tenant: {
    package: '@quxkit/tenant-kit',
    // 002_rls installs the isolation machinery without protecting anything —
    // calling `tenancy.protect()` on a table is a separate, deliberate act, and
    // doing it here would make every unscoped query on the app's own tables
    // silently return nothing.
    files: [
      '001_core.sql',
      '002_rls.sql',
      '003_invitations.sql',
      '004_roles.sql',
      '005_events.sql',
      '006_settings.sql',
    ],
  },
  billing: {
    package: '@quxkit/billing-kit',
    // Not contiguous: the kit numbers by concern (0xx core, 01x metering, 02x
    // subscriptions, 03x settlement, 09x policy) and 090_rls must land after
    // every table it protects.
    files: [
      '001_core.sql',
      '010_metering.sql',
      '011_partitions.sql',
      '012_meter_batch.sql',
      '013_runs.sql',
      '020_subscriptions.sql',
      '030_provider_events.sql',
      '031_invoices.sql',
      '032_plan_changes.sql',
      '033_tax_lines.sql',
      '034_dunning.sql',
      '090_rls.sql',
    ],
  },
  crypto: {
    package: '@quxkit/crypto-kit',
    files: ['001_crypto.sql', '002_hardening.sql'],
  },
  mail: {
    package: '@quxkit/mail-kit',
    files: [
      '001_mail.sql',
      '002_hardening.sql',
      '003_unsubscribe.sql',
      '004_search.sql',
      '005_quotas.sql',
    ],
  },
  comm: {
    package: '@quxkit/comm-kit',
    files: ['001_comm.sql', '002_bridge_guards.sql', '003_operability.sql'],
  },
  integration: {
    package: '@quxkit/integration-kit',
    // 003 creates the least-privileged role the app should connect as. It is a
    // role, not a table, so it needs the migration connection to be an owner —
    // which the installer already is, and an app that never switches roles is
    // no worse off for the role existing unused.
    files: ['001_integration.sql', '002_hardening.sql', '003_app_role.sql'],
  },
  content: {
    package: '@quxkit/content-kit',
    // content-kit's 002 delegates to tenant-kit's `tenancy.protect`, so it
    // cannot be applied before tenant-kit's 002 has installed the function it
    // calls — hence both the ordering below and `requires`.
    files: ['001_content.sql', '002_isolation.sql'],
    requires: ['tenant'],
  },
  translation: {
    package: '@quxkit/translation-kit',
    files: ['001_translation.sql'],
  },
  domain: {
    package: '@quxkit/domain-kit',
    files: ['001_domains.sql', '002_isolation.sql'],
    requires: ['tenant'],
  },
};

/**
 * The order kits must be migrated in.
 *
 * tenant-kit before anything that delegates isolation to it, identity before
 * anything that references a user. Stated as a list rather than derived from
 * `requires`, because the list is short, the ordering is a fact somebody has to
 * be able to read, and a topological sort of ten items is more machinery than
 * the problem deserves.
 *
 * This is also the canonical set of kit names: `createSdk` checks against it
 * rather than against a second list of its own.
 */
export const ORDER: KitName[] = [
  'identity',
  'tenant',
  'billing',
  'crypto',
  'mail',
  'comm',
  'integration',
  'content',
  'translation',
  'domain',
];

export interface MigrationStep {
  kit: KitName;
  file: string;
  path: string;
}

/** Where a kit's `sql/` actually lives, wherever the installer put it. */
const sqlDir = (pkg: string): string =>
  join(dirname(require.resolve(`${pkg}/package.json`)), 'sql');

/**
 * Check a set of kits against the rules, without touching the filesystem.
 *
 * Split from `migrationPlan` because construction validates and only migration
 * needs paths. Folding them together meant creating an SDK resolved every kit's
 * package — so an app that enabled four kits could not build unless all eight
 * were installed, and the error named a `package.json` rather than the config.
 */
export function validateKits(kits: readonly KitName[]): void {
  const enabled = new Set(kits);
  for (const kit of kits) {
    for (const need of SCHEMAS[kit]?.requires ?? []) {
      if (!enabled.has(need)) {
        throw new Error(
          `${kit}-kit needs ${need}-kit: its schema calls into a function ${need}-kit installs. ` +
            `Enable ${need}, or drop ${kit}.`,
        );
      }
    }
  }
}

/**
 * The files to apply, resolved and ordered, for a set of enabled kits.
 *
 * Separated from applying them so a caller can show the plan before running it —
 * which an installer writing to somebody else's database had better do. Resolves
 * each kit's package, so every enabled kit must be installed by the time this is
 * called.
 */
export function migrationPlan(kits: readonly KitName[]): MigrationStep[] {
  validateKits(kits);
  const enabled = new Set(kits);
  const steps: MigrationStep[] = [];

  for (const kit of ORDER) {
    if (!enabled.has(kit)) continue;
    const schema = SCHEMAS[kit];

    const dir = sqlDir(schema.package);
    // Isolation files sort last within a kit, which is where they belong: a
    // policy that calls `tenancy.protect` needs the tables it protects. They
    // used to be held in a separate conditional table, applied only if tenant
    // were enabled — dead machinery, since every kit that has one also declares
    // `requires: ['tenant']`, so the condition could not be false.
    for (const file of schema.files) steps.push({ kit, file, path: join(dir, file) });
  }

  return steps;
}

export interface Migrator {
  query(text: string): Promise<unknown>;
}

export interface MigrateResult {
  applied: MigrationStep[];
}

/**
 * Apply the plan.
 *
 * Sequential and unwrapped by a transaction, deliberately: several of these
 * files contain statements Postgres refuses inside one — `CREATE INDEX
 * CONCURRENTLY`, and extension creation on some managed providers — and every
 * statement is already guarded, so a failure halfway leaves a database that the
 * next run continues from rather than one that has to be repaired.
 */
export async function migrate(
  db: Migrator,
  kits: readonly KitName[],
  onStep?: (step: MigrationStep) => void,
): Promise<MigrateResult> {
  const plan = migrationPlan(kits);
  const applied: MigrationStep[] = [];

  for (const step of plan) {
    const ddl = await readFile(step.path, 'utf8');
    await db.query(ddl);
    applied.push(step);
    onStep?.(step);
  }

  return { applied };
}

export { SCHEMAS };
