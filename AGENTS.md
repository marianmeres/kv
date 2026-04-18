# @marianmeres/kv — Agent Guide

Machine-friendly reference for AI agents working with this codebase.

## Quick Reference

- **Stack**: TypeScript, Deno (primary), Node.js (via npm build)
- **Run**: `deno task test` | **Build**: `deno task npm:build`
- **Version**: 2.1.0

## Purpose

Key-value storage abstraction layer providing a unified Redis-inspired API across multiple storage backends.

## Project Structure

```
src/
├── mod.ts              — Main entry point (re-exports kv.ts)
├── kv.ts               — Factory function and all exports
├── adapter/
│   ├── abstract.ts     — Base class + shared types
│   ├── memory.ts       — In-memory adapter
│   ├── redis.ts        — Redis adapter
│   ├── postgres.ts     — PostgreSQL adapter
│   └── deno-kv.ts      — Deno KV adapter
└── utils/
    └── sleep.ts        — Sleep utility function

tests/
├── kv.test.ts          — Main test file
├── _tests-runner.ts    — Test harness
├── _redis.ts           — Redis test helper
└── _pg.ts              — PostgreSQL test helper
```

## Critical Conventions

1. Namespace must end with `:` or be empty string.
2. Values are JSON-stringified internally.
3. TTL is in seconds; stored as absolute `Date` internally.
4. Pattern matching: Redis-style (`*` = any chars, `?` = single char). All other characters — including `.`, `(`, `[`, `%`, `_` — are matched **literally**.
5. TTL resolution: `options.ttl ?? defaultTtl`; `0` or negative disables expiration for that call (explicitly overrides `defaultTtl`).
6. All pattern-to-regex / pattern-to-LIKE conversion lives in `abstract.ts` — use `_globToRegex()`, `_resolveTtl()`, `_normalizePairs()`; do not re-implement per-adapter.
7. Postgres `transaction()` must pin a single connection via `pool.connect()`; every nested query uses that client, not `this.options.db`.
8. Redis adapter owns the connection iff `initialize()` opened it (`#weOpened` flag).
9. Key validation lives in `_withNs()` — enforced when `options.validateKeys !== false`. Reject empty strings, keys with `\0`, and total `namespace + key` length > 512.
10. `ttl()` returns `TtlResult = { state: "missing" | "no-ttl" | "expires"; at? }` — discriminated union, not `Date | null | false`.
11. `incr`/`decr`/`getSet`/`cas`/`setIfAbsent` must be atomic: Redis = Lua or NX; Postgres = UPSERT/UPDATE with RETURNING; Deno KV = `#atomicUpdate` CAS retry loop; Memory = plain read-modify-write (single-threaded).
12. Non-numeric `incr`/`decr` target throws `TypeError("KV value is not a number")`. In Postgres, detect via error code `22P02`.
13. Deno KV atomic retries exhausted → throw `KvRaceError` (imported from `abstract.ts`).
14. `keysIter` must clean up on early consumer break — PG releases its server-side cursor in the generator's `finally`.

## Before Making Changes

- [ ] Check existing patterns in adapter implementations
- [ ] Run tests: `deno test --unstable-kv -A --env-file`
- [ ] Verify adapter limitations are documented

## Supported Adapters

| Adapter | Type String | Required Options | Limitations |
|---------|-------------|------------------|-------------|
| Memory | `"memory"` | None | Not persisted |
| Redis | `"redis"` | `db` (Redis client) | Namespace required; `keys()`/`clear()` unavailable in cluster mode |
| PostgreSQL | `"postgres"` | `db` (pg.Pool/Client) | `tableName` limited to `[A-Za-z0-9_]` + optional `schema.` prefix |
| Deno KV | `"deno-kv"` | `db` (Deno.Kv) | Deno runtime only; `delete()` always `true`; `expire()`/`ttl()` unsupported; `transaction()` atomic only when no `get` ops |

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
interface SetOptions { ttl: number }
interface AdapterInfo { type: string }
interface AdapterAbstractOptions { defaultTtl: number; logger?: Logger; validateKeys?: boolean }
interface Operation { type: "set" | "get" | "delete"; key: string; value?: any; options?: SetOptions }

type SetMultipleEntry =
  | [string, any]
  | { key: string; value: any; ttl?: number };

type TtlResult =
  | { state: "missing" }
  | { state: "no-ttl" }
  | { state: "expires"; at: Date };

class KvRaceError extends Error {}  // Deno KV CAS retry-exhaustion
```

## Commands

```bash
# Run tests (requires --unstable-kv for Deno KV)
deno test --unstable-kv -A --env-file

# Run tests with watch mode
deno test --unstable-kv -A --env-file --watch

# Build npm package
deno run -A scripts/build-npm.ts
```

## Test Environment Variables

```
TEST_PG_HOST=localhost
TEST_PG_PORT=5432
TEST_PG_DATABASE=<required>
TEST_PG_USER=<required>
TEST_PG_PASSWORD=<required>
TEST_REDIS_URL=redis://localhost:6379
```

## Extending

To add a new adapter:
1. Create `src/adapter/<name>.ts`
2. Extend `AdapterAbstract`
3. Implement all abstract/interface methods
4. Add to `KnownTypes` in `src/kv.ts`
5. Add case in `createKVClient` factory
6. Export from `src/kv.ts`

## Documentation Index

- [API Reference](./API.md) — Complete API documentation
- [README](./README.md) — Quick start and installation
