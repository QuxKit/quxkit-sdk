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
  | 'mail'
  | 'comm'
  | 'integration'
  | 'content'
  | 'domain';

interface KitSchema {
  package: string;
  /**
   * The files to apply, in order.
   *
   * Named explicitly rather than globbed. A kit's `sql/` holds opt-in modules
   * alongside its core — identity-kit ships eight files and an app needs three
   * of them — so a glob would apply schema nobody asked for, and alphabetical
   * order is not dependency order.
   */
  files: string[];
  /** Applied only when this other kit is also on. */
  requires?: KitName[];
}

const SCHEMAS: Record<KitName, KitSchema> = {
  identity: {
    package: '@quxkit/identity-kit',
    files: ['001_identity.sql', '005_hardening.sql', '006_events.sql'],
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
    files: ['001_billing.sql'],
  },
  mail: {
    package: '@quxkit/mail-kit',
    files: ['001_mail.sql'],
  },
  comm: {
    package: '@quxkit/comm-kit',
    files: ['001_comm.sql', '002_bridge_guards.sql', '003_operability.sql'],
  },
  integration: {
    package: '@quxkit/integration-kit',
    files: ['001_integration.sql', '002_hardening.sql'],
  },
  content: {
    package: '@quxkit/content-kit',
    files: ['001_content.sql'],
    // content-kit's isolation delegates to tenant-kit's `tenancy.protect`, so
    // its 002 cannot be applied before tenant-kit's 002 has installed the
    // function it calls.
    requires: ['tenant'],
  },
  domain: {
    package: '@quxkit/domain-kit',
    files: ['001_domains.sql'],
    requires: ['tenant'],
  },
};

/** Isolation files, applied only when tenant-kit is on. */
const ISOLATION: Partial<Record<KitName, string>> = {
  content: '002_isolation.sql',
  domain: '002_isolation.sql',
};

/**
 * The order kits must be migrated in.
 *
 * tenant-kit before anything that delegates isolation to it, identity before
 * anything that references a user. Stated as a list rather than derived from
 * `requires`, because the list is short, the ordering is a fact somebody has to
 * be able to read, and a topological sort of eight items is more machinery than
 * the problem deserves.
 */
const ORDER: KitName[] = [
  'identity',
  'tenant',
  'billing',
  'mail',
  'comm',
  'integration',
  'content',
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
    for (const file of schema.files) steps.push({ kit, file, path: join(dir, file) });

    // Isolation last for this kit, and only when tenancy is present to delegate
    // to. Applying it without tenant-kit installs a policy calling a function
    // that does not exist, and the table then answers nothing at all.
    const isolation = ISOLATION[kit];
    if (isolation && enabled.has('tenant')) {
      steps.push({ kit, file: isolation, path: join(dir, isolation) });
    }
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

export { ORDER, SCHEMAS };
