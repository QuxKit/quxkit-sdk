# @quxkit/sdk

**QuxKit** · the composition

One pool, one transaction discipline, the kits wired to it — versioned, so a bug
in the wiring is fixed by publishing a version rather than by a pull-request
campaign across every repository that copied it.

```ts
import { createSdk } from '@quxkit/sdk';

export const sdk = createSdk({
  kits: ['identity', 'tenant', 'billing'],
});

await sdk.migrate();       // every schema, in the order the kits require
sdk.require('tenant');     // throws with instructions if it is not enabled
```

## What this is for

Composing the QuxKit family in a real application takes about 150 lines that are
not boilerplate — they are three bugs somebody already had, and one guard against
a fourth. Those lines lived in one app. Every other app that composed the family
copied them, and a bug in them was fixed once per copy.

| | Why it is not boilerplate |
|---|---|
| **One `pg.Pool`** shared by every kit | Every kit takes a `SqlExecutor`, not a connection. A pool per kit is four transaction disciplines that cannot see each other's work, and the kits stop composing. |
| **A lazy `Proxy`** around every instance | `next build` imports every route to collect metadata, on a machine with no database. Anything constructed at module scope runs there. |
| **`globalThis`** for the pool | A framework that reloads modules per route in development creates a pool per edit otherwise, and the connection limit arrives by lunchtime. |
| **An isolation guard** | A superuser or `BYPASSRLS` connection ignores every row-level-security policy while `\d` still reports them enabled. It fails **open**, so it gets a check rather than a comment. |

## The isolation guard

The one that matters most, because nothing else will tell you:

```
[quxkit] Row-level security does not apply to "postgres" — it is a superuser or
has BYPASSRLS. Every tenancy policy in this database is being ignored, and
nothing else will say so.
```

It **warns** by default and **throws** in production, and that asymmetry is
deliberate: every developer running homebrew Postgres is a superuser, and an SDK
that refuses to start on a laptop is one that gets ripped out on day one. The
safe setting is the one nobody has to remember.

## Migrations

The kits ship their SQL inside their packages. What is worth having in a package
rather than in an app is the **order** — within a kit and between them, and some
files must follow others in a different kit entirely.

```ts
sdk.migrationPlan();   // the files, in order, without applying them
await sdk.migrate();
```

The plan is separate from applying it because anything writing to somebody
else's database had better be able to show what it will do first.

Files are named explicitly, never globbed — a list you can read in review, and
one a stray file in a published package cannot quietly join. `test/schema.test.ts`
reads the kits' own `sql/` directories and fails if the two disagree, which is
the only thing that keeps an explicit list honest.

## Which kits

| kit | schema | needs |
| --- | --- | --- |
| `identity` | 8 files | — |
| `tenant` | 6 | — |
| `billing` | 12 | — |
| `crypto` | 2 | — |
| `mail` | 5 | — |
| `comm` | 3 | — |
| `integration` | 3 | — |
| `content` | 2 | `tenant` |
| `translation` | 1 | — |
| `domain` | 2 | `tenant` |
| `host` | 2 | `tenant` |

Every kit in the family that takes a `SqlExecutor` and ships a schema, with two
deliberate absences:

- **`@quxkit/rag-kit`** takes a `SqlExecutor` and belongs here, but it also needs
  an inference provider, and a provider is a credential and a budget rather than
  a row in a table. Adding it means the SDK grows a second kind of configuration.
  Worth doing; not done.
- **`@quxkit/ui-kit`** never will. It is components copied into a repo at build
  time — there is no runtime object for a composition root to hand a pool to.
  The same goes for the `-adapters` packages and the MCP servers, which are
  surfaces onto kits rather than kits.

## The kits are optional peers

This package composes what you installed. It does not redistribute eight
packages to an app that wanted two, and a kit that is not enabled is not
constructed — reaching for it throws a message saying how to turn it on, rather
than returning `undefined` and failing somewhere else entirely.

## Licence

Apache-2.0.
