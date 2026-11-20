# @marianmeres/kv — Agent Guide

Machine-friendly reference for AI agents working with this codebase.

## Quick Reference

- **Stack**: TypeScript (erasable-only), Node LTS (`.node-version`), pnpm, `node:test`, Biome.
- **Install**: `pnpm install` | **Test**: `pnpm test` (needs Postgres + Redis; SQLite and PGlite run in memory;
  test files run one at a time) |
  **Check all**: `pnpm run ci` | **Build**: `pnpm run build`
- **Published**: npm (`dist/`, built by `tsc`)

## Purpose

Key-value storage abstraction layer providing a unified Redis-inspired API across multiple storage backends.

## Project Structure

```
src/
├── index.ts            — The only entry point (package.json "exports")
├── kv.ts               — Factory function and all exports
├── adapter/
│   ├── abstract.ts     — Base class + shared types
│   ├── memory.ts       — In-memory adapter
│   ├── redis.ts        — Redis adapter
│   ├── postgres.ts     — PostgreSQL adapter
│   └── sqlite.ts       — SQLite adapter (`node:sqlite`)
└── utils/
    ├── driver.ts       — `toPgDriver()`: the postgres adapter's `db` as a sqlkit `Driver`
    └── sleep.ts        — Sleep utility function

tests/
├── kv.test.ts          — Main test file (node:test); every test runs against all adapters,
│                         and the postgres adapter on PGlite too
├── driver.test.ts      — The postgres adapter on a pool, a client and a sqlkit Driver
│                         (over node-postgres and over PGlite)
├── _tests-runner.ts    — Test harness: builds one client per adapter per test
├── _redis.ts           — Redis test helper
├── _pg.ts              — PostgreSQL test helper
├── _pglite.ts          — PGlite test helper (one in-memory PGlite per test file, as a sqlkit Driver)
├── _sqlite.ts          — SQLite test helper (fresh `:memory:` database per test)
└── _no-destroy-child.ts — child process: an adapter left running must not hold it open

docs/
└── backlog.md          — Open work, ranked, not scheduled (the open copy)

dist/                   — `tsc -p tsconfig.build.json` output; gitignored; the npm payload
```

## Critical Conventions

1. **Runtime policy** — Node at the keyboard and in production, npm as the registry. No
   `Deno.*`, `Bun.*`, `bun:*`, `jsr:` or `npm:` specifiers. Web standards first; `node:*`
   where they don't reach. Nothing is built, tested or documented for Bun or Deno.
   Published to npm only; 3.1.1 was the last version on JSR. `engines.node` is
   `@marianmeres/sqlkit`'s (`^24.20.0 || >=26.6.0`): kv installs it, so kv's floor is
   never below it (convention 24).
2. **Erasable TypeScript** — no `enum`, `namespace`, constructor parameter properties;
   `import type` for types; explicit `.ts` import extensions (rewritten to `.js` on emit).
   Node strips types and never checks them: `pnpm run typecheck` is the only type gate.
3. **Formatting & lint** — tabs, 4 wide, 90 columns, double quotes (`biome.json`);
   manifests at 2 spaces. `pnpm run format` before committing. `noExplicitAny` is off
   because stored values are arbitrary JSON and `any` is public API; `noNonNullAssertion`
   is off for the `db: null!` option defaults and `Map#get` after `has()`.
4. Namespace must end with `:` or be empty string. Validated in the `AdapterAbstract`
   constructor; adapters pass it via `super(namespace)`.
5. Adapters re-declare `options` with a field initializer and merge user options again in
   their own constructor (the field replaces what the base constructor set).
6. Values are JSON-stringified internally.
7. TTL is in seconds; stored as absolute `Date` internally.
8. Pattern matching: Redis-style (`*` = any chars, `?` = single char). All other characters — including `.`, `(`, `[`, `%`, `_` — are matched **literally**.
9. TTL resolution: `options.ttl ?? defaultTtl`; `0` or negative disables expiration for that call (explicitly overrides `defaultTtl`).
10. Shared helpers live in `abstract.ts` — use `_globToRegex()`, `_resolveTtl()`, `_normalizePairs()`; do not re-implement per-adapter. The SQL adapters keep their own pattern escaping next to the SQL that uses it: Postgres `#likePattern` (LIKE, `ESCAPE '\'`), SQLite `#globPattern` (GLOB — case-sensitive, unlike SQLite's LIKE; `[` → `[[]`). Both escape the namespace as a literal prefix.
11. Postgres `transaction()` is `this.#db.savepoint()`. Outside a transaction that is the
    driver's `transaction()`: it pins the connection (or, on one `pg.Client`, holds every
    other caller back), checks the `COMMIT` and rolls back. Inside a transaction the host
    opened on the same `Driver` it is a savepoint of it, so a failed unit is undone alone
    and the host's transaction goes on, as on SQLite (convention 19). Nothing in the
    adapter sends `BEGIN`, `COMMIT`, `ROLLBACK` or `SAVEPOINT`. Pass the callback's `tx`
    to the `…On` helpers.
12. Redis adapter owns the connection iff `initialize()` opened it (`#weOpened` flag). The Postgres and SQLite adapters never close the `db` they were given; the Postgres adapter never calls `close()` on a driver, its own or the host's (it would end the host's pool or client).
13. Key validation lives in `_withNs()` — enforced when `options.validateKeys !== false`. Reject empty strings, keys with `\0`, and total `namespace + key` length > 512.
14. `ttl()` returns `TtlResult = { state: "missing" | "no-ttl" | "expires"; at? }` — discriminated union, not `Date | null | false`.
15. `incr`/`decr`/`getSet`/`cas`/`setIfAbsent` must be atomic: Redis = Lua or NX; Postgres = UPSERT/UPDATE with RETURNING; SQLite = a single UPSERT/UPDATE (`setIfAbsent`, `cas`) or a read-modify-write inside `#atomic()` (`getSet`, `incr`/`decr`); Memory = plain read-modify-write (single-threaded).
16. Non-numeric `incr`/`decr` target throws `TypeError("KV value is not a number")`. In Postgres, the upsert's `DO UPDATE` has a `WHERE` that skips a live value that is not a JSON number, so the statement returns no row and raises nothing (a transaction the host opened on the same `Driver` is not aborted); no row is the `TypeError`, and the `22P02` catch on the sqlkit `SqlError`'s `code` is a backstop for a delta PostgreSQL cannot cast. SQLite checks `typeof` in JS, like Memory. No other database error is caught, wrapped or translated: the caller gets sqlkit's `SqlError`.
17. `keysIter` in both SQL adapters pages by keyset, 500 keys a page, so nothing stays open between yields and an early consumer break leaves nothing to release. It is not one snapshot. SQLite pages with `key > last`. Postgres pages in byte order on the `text_pattern_ops` prefix index (`key ~>~ $2`, `ORDER BY key USING ~<~`); a plain `key > $2 ORDER BY key` would walk the primary key across every namespace. Postgres `keys()` has no SQL `ORDER BY` for the same reason: it sorts in JS.
18. SQLite: `src/` imports `node:sqlite` **type-only** — the caller passes the `DatabaseSync`. A runtime import would make every consumer of the package load `node:sqlite`.
19. SQLite multi-statement operations go through `#atomic()`: `BEGIN IMMEDIATE`, or a savepoint when `db.isTransaction` (the caller's transaction on the same handle). The callback must stay synchronous — an `await` inside would let other work join the transaction.
20. SQLite stores `value` as JSON text and `expires_at` as epoch ms (INTEGER), compared against a bound `Date.now()` — never SQLite's own clock. Read counts/integers through `Number()` (a handle opened with `readBigInts` returns bigints).
21. TTL cleanup timers are `unref()`ed (`unref?.()`: browser and worker timers are plain numbers), so a client nobody destroyed cannot hold the process open; `destroy()` still clears them. Postgres's tick awaits its query, so it re-checks `_initialized` before re-arming, and `destroy()` clears `_initialized` before its first `await`. SQLite stops the cleanup (one error log) when it finds `db.isOpen` false.
22. Postgres talks to the database only through `src/utils/driver.ts`: `toPgDriver(db)`,
    called once in the constructor, turns a `pg.Pool` or `pg.Client` into a sqlkit
    `Driver` (one per object, in a `WeakMap`: `createPgDriver` adds an `error` listener on
    every call, and several adapters on one pool is normal), and uses a host's `Driver` as
    it is. A `Driver` of another dialect is a `TypeError`, and so is one without
    `savepoint()` (built by a sqlkit older than 0.3.0). `options.db` stays what the host
    passed; every statement goes through `this.#db`, with its text and `$n` parameters.
    Nothing in `src/` imports `pg` (it is a dev dependency); `@marianmeres/sqlkit/pg` is
    imported statically, so the package root loads `node:async_hooks`. A kv call issued
    inside a transaction the host opened on the same `Driver` joins it, by design.
23. The SQLite adapter takes only a `DatabaseSync`: its constructor refuses a sqlkit
    `Driver` with a `TypeError`.
24. A sqlkit minor is a kv minor. sqlkit is on `0.x`, so each minor is a caret range of
    its own: a consumer whose own sqlkit is on another minor gets two copies. Since 0.3.0
    two copies know each other's `SqlError` (a mark `instanceof` reads; a copy of 0.2.0
    or older has none, so its `instanceof SqlError` misses the errors of the driver kv
    built). A minor can still change the `Driver` type the PostgreSQL adapter takes, as
    0.3.0 did with `savepoint`. Moving kv's range across a sqlkit minor therefore takes,
    together: `engines.node` to sqlkit's, the README's "Requires Node" and the `^0.x.0`
    in its notes and in `API.md`, and a "Changes in" section in the README telling
    consumers to move their own sqlkit.
25. PGlite is a tested target of the postgres adapter, not an adapter of its own.
    `tests/_tests-runner.ts` builds a fifth client, `pglite`: the postgres adapter on a
    sqlkit `Driver` over the test file's one in-memory PGlite (`tests/_pglite.ts`). Its
    `info().type` is `"postgres"`, so a test that needs a client's adapter type reads
    `client.info().type`, never the key in `clients`. `@electric-sql/pglite` is a dev
    dependency; nothing in `src/` imports it.

## Before Making Changes

- [ ] Check existing patterns in adapter implementations
- [ ] Add or extend a test in `tests/kv.test.ts` (or in `tests/driver.test.ts` for what only
      the postgres adapter's `db` decides), then run `pnpm run ci`
- [ ] Verify adapter limitations are documented (README feature matrix, API.md)

## Supported Adapters

| Adapter    | Type String  | Required Options                                                      | Limitations                                                                                               |
| ---------- | ------------ | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Memory     | `"memory"`   | None                                                                  | Not persisted                                                                                             |
| Redis      | `"redis"`    | `db` (Redis client)                                                   | Namespace required; `keys()`/`clear()` unavailable in cluster mode                                        |
| PostgreSQL | `"postgres"` | `db` (`pg.Pool`, `pg.Client` or a sqlkit `Driver`, PGlite's included) | `tableName` limited to `[A-Za-z0-9_]` + optional `schema.` prefix                                         |
| SQLite     | `"sqlite"`   | `db` (`DatabaseSync`)                                                 | `tableName` limited to `[A-Za-z0-9_]`, no schema prefix; synchronous driver; a sqlkit `Driver` is refused |

## Core API

### Factory

```typescript
createKVClient(namespace?: string, type?: AdapterType, options?: AdapterOptions): Adapter
```

### Client Methods

```
// lifecycle
initialize(): Promise<void>
destroy(hard?: boolean): Promise<void>
info(): AdapterInfo

// single-key
set(key, value, options?): Promise<boolean>
setIfAbsent(key, value, options?): Promise<boolean>        // atomic
getSet(key, value, options?): Promise<any>                 // returns previous
incr(key, by?=1, options?): Promise<number>                // atomic
decr(key, by?=1, options?): Promise<number>                // atomic
cas(key, expected, next, options?): Promise<boolean>       // atomic
get(key): Promise<any>
delete(key): Promise<boolean>
exists(key): Promise<boolean>

// patterns
keys(pattern): Promise<string[]>                           // sorted
keysIter(pattern): AsyncIterable<string>                   // streaming
clear(pattern): Promise<number>

// batch
setMultiple(entries: SetMultipleEntry[], options?): Promise<boolean[]>
getMultiple(keys): Promise<Record<string, any>>
transaction(operations: Operation[]): Promise<any[]>

// TTL
expire(key, ttl): Promise<boolean>
ttl(key): Promise<TtlResult>
```

## Key Types

```typescript
interface SetOptions {
	ttl: number;
}
interface AdapterInfo {
	type: string;
}
interface AdapterAbstractOptions {
	defaultTtl: number;
	logger?: Logger;
	validateKeys?: boolean;
}
interface Operation {
	type: "set" | "get" | "delete";
	key: string;
	value?: any;
	options?: SetOptions;
}

type SetMultipleEntry = [string, any] | { key: string; value: any; ttl?: number };

// the postgres adapter's `db`; sqlkit's structural types, so `src/` never imports `pg`
type PostgresDb = PgPoolLike | PgStandaloneClientLike | Driver;

type TtlResult =
	| { state: "missing" }
	| { state: "no-ttl" }
	| { state: "expires"; at: Date };
```

## Commands

```bash
pnpm test              # node --test over tests/**/*.test.ts, one file at a time
                       # (--test-concurrency=1: they share `__kv` and one Redis DB), loads .env
pnpm run test:watch
pnpm run typecheck     # tsc --noEmit
pnpm run lint          # biome check . (read-only); `pnpm run format` writes
pnpm run ci            # typecheck + lint + test — what CI runs
pnpm run build         # tsc -p tsconfig.build.json → dist/
```

Releasing is a human action: `pnpm run rp` / `rpm` (patch / minor), or
`pnpm run release major --before-push "pnpm publish"`. `release` runs `pnpm run ci` before
it writes anything (`--before-bump`), and the publish runs between the tag and the push
(`--before-push`): a failing gate changes nothing, and a failed publish leaves no tag on
the remote.

## Test Environment Variables

Every test in `tests/kv.test.ts` runs against all four adapters, and against the postgres
adapter on PGlite (in memory, in the test process: it needs nothing), so tests need a live
Postgres and Redis (SQLite uses a fresh `:memory:` database per test and needs nothing).
`tests/driver.test.ts` needs Postgres only. Put
these in `.env` (see `.env.example`); CI provides them via service containers
(`.github/workflows/ci.yml`). The harness deletes **every key** in the Redis DB before each
test — use a scratch DB.

```
TEST_PG_HOST=localhost
TEST_PG_PORT=5432
TEST_PG_DATABASE=<required>
TEST_PG_USER=<required>
TEST_PG_PASSWORD=<required>
TEST_REDIS_URL=redis://localhost:6379/13
```

## Extending

To add a new adapter:

1. Create `src/adapter/<name>.ts`
2. Extend `AdapterAbstract`; call `super(namespace)` and re-merge `options` (convention 5)
3. Implement all abstract/interface methods
4. Add to `KnownTypes` in `src/kv.ts`
5. Add case in `createKVClient` factory
6. Export from `src/kv.ts`
7. Add a client for it in `tests/_tests-runner.ts`; it must run on Node

## Documentation Index

- [API Reference](./API.md) — Complete API documentation
- [README](./README.md) — Quick start, feature matrix, breaking changes, development
- [Backlog](./docs/backlog.md) — Open work after 4.0.0, with each row's trigger
