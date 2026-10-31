# @marianmeres/kv — Agent Guide

Machine-friendly reference for AI agents working with this codebase.

## Quick Reference

- **Stack**: TypeScript (erasable-only), Node LTS (`.node-version`), pnpm, `node:test`, Biome.
- **Install**: `pnpm install` | **Test**: `pnpm test` (needs Postgres + Redis, see below) |
  **Check all**: `pnpm run ci` | **Build**: `pnpm run build`
- **Published**: npm (`dist/`, built by `tsc`) and JSR (`src/` via `jsr.json`, for Deno consumers)

## Purpose

Key-value storage abstraction layer providing a unified Redis-inspired API across multiple storage backends.

## Project Structure

```
src/
├── index.ts            — The only entry point (package.json "exports", jsr.json "exports")
├── kv.ts               — Factory function and all exports
├── adapter/
│   ├── abstract.ts     — Base class + shared types
│   ├── memory.ts       — In-memory adapter
│   ├── redis.ts        — Redis adapter
│   └── postgres.ts     — PostgreSQL adapter
└── utils/
    └── sleep.ts        — Sleep utility function

tests/
├── kv.test.ts          — Main test file (node:test); every test runs against all adapters
├── _tests-runner.ts    — Test harness: builds one client per adapter per test
├── _redis.ts           — Redis test helper
└── _pg.ts              — PostgreSQL test helper

dist/                   — `tsc -p tsconfig.build.json` output; gitignored; the npm payload
```

## Critical Conventions

1. **Runtime policy** — Node at the keyboard and in production, npm as the registry. No
   `Deno.*`, `Bun.*`, `bun:*`, `jsr:` or `npm:` specifiers. Web standards first; `node:*`
   where they don't reach. Nothing is built, tested or documented for Bun or Deno; JSR is
   published only while Deno consumers exist (`publish:jsr` runs `test:deno` first).
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
10. All pattern-to-regex / pattern-to-LIKE conversion lives in `abstract.ts` — use `_globToRegex()`, `_resolveTtl()`, `_normalizePairs()`; do not re-implement per-adapter.
11. Postgres `transaction()` must pin a single connection via `pool.connect()`; every nested query uses that client, not `this.options.db`.
12. Redis adapter owns the connection iff `initialize()` opened it (`#weOpened` flag).
13. Key validation lives in `_withNs()` — enforced when `options.validateKeys !== false`. Reject empty strings, keys with `\0`, and total `namespace + key` length > 512.
14. `ttl()` returns `TtlResult = { state: "missing" | "no-ttl" | "expires"; at? }` — discriminated union, not `Date | null | false`.
15. `incr`/`decr`/`getSet`/`cas`/`setIfAbsent` must be atomic: Redis = Lua or NX; Postgres = UPSERT/UPDATE with RETURNING; Memory = plain read-modify-write (single-threaded).
16. Non-numeric `incr`/`decr` target throws `TypeError("KV value is not a number")`. In Postgres, detect via error code `22P02`.
17. `keysIter` must clean up on early consumer break — PG releases its server-side cursor in the generator's `finally`.

## Before Making Changes

- [ ] Check existing patterns in adapter implementations
- [ ] Add or extend a test in `tests/kv.test.ts`, then run `pnpm run ci`
- [ ] Verify adapter limitations are documented (README feature matrix, API.md)

## Supported Adapters

| Adapter    | Type String  | Required Options      | Limitations                                                        |
| ---------- | ------------ | --------------------- | ------------------------------------------------------------------ |
| Memory     | `"memory"`   | None                  | Not persisted                                                      |
| Redis      | `"redis"`    | `db` (Redis client)   | Namespace required; `keys()`/`clear()` unavailable in cluster mode |
| PostgreSQL | `"postgres"` | `db` (pg.Pool/Client) | `tableName` limited to `[A-Za-z0-9_]` + optional `schema.` prefix  |

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

type TtlResult =
	| { state: "missing" }
	| { state: "no-ttl" }
	| { state: "expires"; at: Date };
```

## Commands

```bash
pnpm test              # node --test over tests/**/*.test.ts, loads .env if present
pnpm run test:watch
pnpm run typecheck     # tsc --noEmit
pnpm run lint          # biome check . (read-only); `pnpm run format` writes
pnpm run ci            # typecheck + lint + test — what CI runs
pnpm run build         # tsc -p tsconfig.build.json → dist/
pnpm run test:deno     # the same suite on Deno; only gates publish:jsr
```

Releasing (`pnpm run rp` / `rpm`, or `pnpm run release major` + `pnpm run publish:all`) is a
human action.

## Test Environment Variables

Every test runs against all three adapters, so tests need a live Postgres and Redis. Put
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
