// Refuse to serve traffic with tenant isolation silently switched off.
//
// A PostgreSQL superuser, or any role with BYPASSRLS, ignores row-level
// security. `FORCE ROW LEVEL SECURITY` does not change that. So an app
// connecting as `postgres` — or as your own account on a laptop, which homebrew
// makes a superuser — has no isolation at all, while `\d projects` still shows
// the policy enabled and every test that only checks its own rows still passes.
//
// This is the failure mode that ships to production and is discovered by a
// customer. It fails open, so it gets a guard rather than a comment.

export interface IsolationVerdict {
  role: string;
  /** True when row-level security does not apply to this role. */
  exempt: boolean;
}

export type Queryable = {
  query<R>(text: string): Promise<{ rows: R[] }>;
};

export async function checkIsolation(pool: Queryable): Promise<IsolationVerdict | null> {
  const { rows } = await pool.query<{ rolname: string; exempt: boolean }>(
    `SELECT rolname, (rolsuper OR rolbypassrls) AS exempt
       FROM pg_roles WHERE rolname = current_user`,
  );
  const role = rows[0];
  return role ? { role: role.rolname, exempt: role.exempt } : null;
}

export type OnExempt = 'throw' | 'warn' | 'ignore';

/**
 * Check, and react the way the app asked.
 *
 * `warn` is the default rather than `throw`, and the reason is honest: every
 * developer on macOS with homebrew Postgres is a superuser, and an SDK that
 * refuses to start on a laptop is an SDK people rip out on day one. In
 * production the right setting is `throw`, and `createSdk` selects it
 * automatically when `NODE_ENV` says production — so the safe default is the
 * one nobody has to remember.
 */
export async function assertIsolationEnforced(
  pool: Queryable,
  onExempt: OnExempt = 'warn',
  log: (message: string) => void = (m) => console.warn(m),
): Promise<IsolationVerdict | null> {
  if (onExempt === 'ignore') return null;

  const verdict = await checkIsolation(pool);
  if (!verdict?.exempt) return verdict;

  const message =
    `Row-level security does not apply to "${verdict.role}" — it is a superuser or has BYPASSRLS. ` +
    `Every tenancy policy in this database is being ignored, and nothing else will say so: ` +
    `the tables still report their policies as enabled and tests that read their own rows still pass. ` +
    `Connect as an unprivileged role.`;

  if (onExempt === 'throw') throw new Error(message);
  log(`[quxkit] ${message}`);
  return verdict;
}
