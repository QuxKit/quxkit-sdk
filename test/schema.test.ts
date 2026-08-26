// The declared migration lists, checked against the kits themselves.
//
// `SCHEMAS` names files explicitly, which is worth having — a list you can read
// in review, and one a stray file in a published package cannot quietly join.
// The cost is drift, and it was not hypothetical: the first version of that
// table was written by hand and five of its eight entries were wrong. `billing`
// named `001_billing.sql`, a file that has never existed in billing-kit, so
// `migrate()` on a billing app died on ENOENT. `identity` applied three of
// eight, `mail` one of five, `integration` two of three — each one a set of
// tables the kit's own code queries and the migration never created.
//
// So: explicit lists, and a test that reads the kits' `sql/` directories and
// insists the two agree. A kit that is not installed here is skipped rather
// than failed — this package depends on none of them, by design.

import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { ORDER, SCHEMAS } from '../src/migrate.ts';

const require = createRequire(import.meta.url);

/**
 * A kit's `sql/`, or null when the kit cannot be found from here.
 *
 * Two ways, because this package depends on no kit and so resolution usually
 * fails: `require.resolve` wherever the kits are installed — an app, CI with the
 * family published — and failing that a sibling checkout, which is how the
 * family is laid out on a machine that develops it. Without the second the test
 * skips every case in the one place the drift is actually introduced.
 */
function sqlFiles(pkg: string): string[] | null {
  const name = pkg.replace('@quxkit/', '');
  const candidates: string[] = [];
  try {
    candidates.push(join(dirname(require.resolve(`${pkg}/package.json`)), 'sql'));
  } catch {
    // not installed; the sibling checkout may still be there
  }
  candidates.push(join(import.meta.dirname, '..', '..', name, 'sql'));

  for (const dir of candidates) {
    try {
      const files = readdirSync(dir).filter((f) => /^\d{3}_.+\.sql$/.test(f));
      if (files.length > 0) return files;
    } catch {
      // try the next
    }
  }
  return null;
}

describe('the declared schema matches the kits', () => {
  for (const kit of ORDER) {
    it(`${kit}-kit: every file it ships is applied, and every file applied exists`, (t) => {
      const actual = sqlFiles(SCHEMAS[kit].package);
      if (actual === null) {
        t.skip(`${SCHEMAS[kit].package} is neither installed nor checked out alongside`);
        return;
      }
      const declared = SCHEMAS[kit].files;

      const ghost = declared.filter((f) => !actual.includes(f));
      assert.deepEqual(ghost, [], `declared but absent from the package: ${ghost.join(', ')}`);

      const unapplied = actual.filter((f) => !declared.includes(f));
      assert.deepEqual(
        unapplied,
        [],
        `${kit}-kit ships these and the migration never runs them: ${unapplied.join(', ')}`,
      );
    });
  }

  it('applies each kit in its own numeric order', () => {
    // The kits number by concern rather than contiguously — billing goes 001,
    // 010…013, 020, 030…034, 090 — but within a kit the number IS the order,
    // and 090_rls has to land after the tables it protects.
    for (const kit of ORDER) {
      const files = SCHEMAS[kit].files;
      assert.deepEqual(files, [...files].sort(), `${kit}-kit's files are out of numeric order`);
    }
  });

  it('covers every kit in the family that takes a SqlExecutor', () => {
    // Named here rather than discovered, so adding a kit to the family and not
    // to the SDK is a failing test rather than a silent omission. rag-kit is
    // absent deliberately: see the note in README.
    assert.deepEqual([...ORDER].sort(), [
      'billing',
      'comm',
      'content',
      'crypto',
      'domain',
      'identity',
      'integration',
      'mail',
      'tenant',
      'translation',
    ]);
  });
});
