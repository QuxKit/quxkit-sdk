# @quxkit/sdk

**QuxKit** · the composition layer

One SDK for the whole QuxKit family. Pick the kits your app needs, hand them
one configuration, and the SDK gives every kit a shared database connection,
runs every migration in the right order, and verifies your tenant isolation is
actually enforced — the wiring every QuxKit app needs, maintained once and
versioned, instead of copied into each app.

```ts
import { createSdk } from '@quxkit/sdk';

export const sdk = createSdk({
  kits: ['identity', 'tenant', 'billing'],
});

await sdk.migrate();       // every enabled kit's schema, in dependency order
sdk.has('billing');        // true
sdk.require('tenant');     // guard a route: throws a clear error if not enabled
sdk.pool;                  // the one pg.Pool every kit shares
```

That is the whole integration. Add a kit by adding its name to the list and
running `migrate()` again — migrations are idempotent, so re-running the full
set is always safe.

## What you get

- **One connection pool, every kit.** Each kit takes the same `SqlExecutor`,
  so they share one pool and one transaction discipline and compose cleanly —
  a billing write and a tenant check can happen in the same transaction.
- **Migrations in dependency order.** Each kit ships its SQL inside its
  package; the SDK knows the order, within a kit and across kits.
  `sdk.migrationPlan()` shows exactly which files will run before you apply
  them — useful for review, required for writing to a database you operate for
  someone else.
- **Build-safe by design.** Nothing connects until the first query. `next
  build` (or any tool that imports your routes on a machine with no database)
  just works, and in dev the pool survives hot reloads instead of leaking one
  per edit.
- **Isolation, verified.** Row-level security silently does not apply to
  superuser or `BYPASSRLS` connections. The SDK checks the actual connection
  and tells you — a warning in development (where local Postgres is usually a
  superuser and everything is fine), a hard stop in production (where it is
  not fine). Your tenancy policies are enforced, and you know it rather than
  assume it.
- **Only what you enable.** The kits are optional peer dependencies: install
  the ones you use, and the SDK never requires the rest. A kit that is not
  enabled fails fast with a message saying how to turn it on.

## The kits

Eleven kits, one list:

| kit | what it adds | needs |
| --- | --- | --- |
| `identity` | accounts, sessions, MFA, passkeys, API keys, OIDC | — |
| `tenant` | teams, roles, invitations, row-level isolation | — |
| `billing` | metering, subscriptions, invoices, wallets, dunning | — |
| `crypto` | offers, trades, custody records | — |
| `mail` | transactional email, suppression, quotas, search | — |
| `comm` | conversations, bridge channels, transcripts | — |
| `integration` | provider connections, canonical capabilities | — |
| `content` | typed content models with a publishing lifecycle | `tenant` |
| `translation` | app copy served from Postgres, no rebuilds | — |
| `domain` | customer custom domains, DNS + certificates | `tenant` |
| `host` | hosted instances: provisioning, metering, lifecycle | `tenant` |

`needs` is enforced at construction: enabling `content` without `tenant` is a
clear error while you are looking at the config, not a broken policy at
runtime. The declared migration lists are verified against each kit's own
`sql/` directory by the test suite, so the SDK and the kits cannot drift.

Two packages sit outside the list on purpose: `@quxkit/rag-kit` (needs an
inference provider as well as a database — planned, once the SDK models that
kind of configuration) and `@quxkit/ui-kit` (components copied into your repo
at build time; there is nothing for a runtime SDK to construct).

## Configuration

`DATABASE_URL` is the only required environment. Supply your own pool instead
with `createSdk({ kits, pool })` — then the SDK creates no connections at all
and `pg` need not even be installed.

```ts
import { required, optional } from '@quxkit/sdk';

const url = required('DATABASE_URL', 'Every kit shares one connection.');
const region = optional('REGION') ?? 'nyc';
```

## Licence

Apache-2.0.
