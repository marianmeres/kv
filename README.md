# @marianmeres/kv

[![NPM version](https://img.shields.io/npm/v/@marianmeres/kv.svg)](https://www.npmjs.com/package/@marianmeres/kv)
[![JSR version](https://jsr.io/badges/@marianmeres/kv)](https://jsr.io/@marianmeres/kv)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Key-value storage abstraction layer with support for multiple backend adapters:
- redis
- postgresql
- memory

The API is inspired by the Redis API.

## Installation

```sh
npm install @marianmeres/kv    # or pnpm add
deno add jsr:@marianmeres/kv   # Deno
```

The `redis` and `postgres` adapters take a client you create yourself (`redis`, `pg`).
Requires Node >= 24.12.

## Usage

```typescript
import { createKVClient } from '@marianmeres/kv';

// Basic usage with memory adapter (default)
const client = createKVClient("my-app-namespace:");

// Or specify a different adapter type
const redisClient = createKVClient(
    "my-app-namespace:",
    'redis', // 'redis' | 'postgres' | 'memory'
    { db: myRedisClient } // adapter-specific options
);

// Use the client
await client.set('my:foo:key', { my: "value" });
await client.get('my:foo:key'); // { my: "value" }
await client.keys('my:*'); // ['my:foo:key']
```

**Important**: Namespace must end with a colon (`:`) or be an empty string.

## API

```typescript
// single-key ops
client.set(key: string, value: any, options?): Promise<boolean>
client.setIfAbsent(key: string, value: any, options?): Promise<boolean>
client.get(key: string): Promise<any>
client.getSet(key: string, value: any, options?): Promise<any>  // returns previous value
client.delete(key: string): Promise<boolean>
client.exists(key: string): Promise<boolean>

// atomic primitives
client.incr(key: string, by?: number, options?): Promise<number>
client.decr(key: string, by?: number, options?): Promise<number>
client.cas(key: string, expected: any, next: any, options?): Promise<boolean>

// patterns & iteration
client.keys(pattern: string): Promise<string[]>
client.keysIter(pattern: string): AsyncIterable<string>
client.clear(pattern: string): Promise<number>

// batch
client.setMultiple(
  entries: [string, any][] | { key: string; value: any; ttl?: number }[],
  options?
): Promise<boolean[]>
client.getMultiple(keys: string[]): Promise<Record<string, any>>
client.transaction(operations: Operation[]): Promise<any[]>

// TTL
client.expire(key: string, ttl: number): Promise<boolean>
client.ttl(key: string): Promise<TtlResult>
```

### `TtlResult`

```typescript
type TtlResult =
  | { state: "missing" }
  | { state: "no-ttl" }
  | { state: "expires"; at: Date };
```

## Pattern Syntax

`keys()` and `clear()` use Redis-style glob patterns:

- `*` — match any number of characters
- `?` — match exactly one character
- all other characters (including `.`, `%`, `_`, `(`, `)`, `[`, `]`) are treated **literally**

## Adapter Feature Matrix

| Feature | Memory | Redis | PostgreSQL |
|---|:-:|:-:|:-:|
| Persistent | ✗ | ✓ | ✓ |
| TTL on `set()` | ✓ | ✓ | ✓ |
| `ttl()` → `expires`/`no-ttl`/`missing` | ✓ | ✓ | ✓ |
| `expire()` | ✓ | ✓ | ✓ |
| Atomic `setIfAbsent` / `incr` / `decr` / `cas` / `getSet` | ✓ | ✓ (Lua) | ✓ (UPSERT) |
| Sorted `keys()` | ✓ | ✓ | ✓ |
| Streaming `keysIter()` | ✓ | ✓ (SCAN) | ✓ (cursor) |
| Per-pair TTL in `setMultiple` | ✓ | ✓ | ✓ |
| Atomic `transaction()` | ✓ (single-threaded) | ✓ (MULTI) | ✓ (BEGIN/COMMIT) |
| `delete()` returns real existed-flag | ✓ | ✓ | ✓ |
| Background TTL cleanup | optional | native (Redis does it) | optional |
| `keys()` / `clear()` | ✓ | ✓ (non-cluster only) | ✓ |

## Adapter-Specific Limitations

### Redis
- **`keys()` and `clear()`**: Not supported in cluster mode (throws error)
- **Namespace**: Required (cannot be empty string)
- **Connection ownership**: If you pass a not-yet-open client to the adapter, `initialize()` opens it and `destroy()` closes it. If you pass an already-open client, the adapter leaves the connection lifecycle to you — safe to share a single client across adapters with different namespaces.

### PostgreSQL
- Creates a table (default: `__kv`) in your database.
- `tableName` must match `^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$` (word chars plus an optional `schema.` prefix).
- `transaction()` pins a single connection from the Pool for the whole BEGIN/…/COMMIT block — safe to call against a `pg.Pool`.
- Supports optional TTL cleanup via `ttlCleanupIntervalSec` option.

### Memory
- Data is not persisted (in-memory only).
- Supports optional TTL cleanup via `ttlCleanupIntervalSec` option.

## Breaking Changes (3.0.0)

- **The Deno KV adapter is removed.** `"deno-kv"` is no longer an adapter type, and
  `AdapterDenoKv`, `AdapterDenoKvOptions` and `KvRaceError` (only Deno KV threw it) are no
  longer exported. Deno KV has no equivalent outside the Deno runtime. Stay on 2.x if you
  depend on it, or move to the `redis`, `postgres` or `memory` adapter.
- The npm package now declares **Node >= 24.12** (`engines`). The memory, Redis and
  PostgreSQL adapters behave exactly as in 2.4.
- The JSR package now resolves `@marianmeres/clog`, `pg` and `redis` from npm instead of
  JSR.

## Changes in 2.2.0

Shipped as a minor release, although the first two items are breaking:

**Breaking:**
- **`ttl(key)` now returns a discriminated `TtlResult`** — `{ state: "missing" | "no-ttl" | "expires", at? }` — instead of `Date | null | false`. Migration:
  ```ts
  // before
  const t = await client.ttl(k);
  if (t instanceof Date) use(t);
  else if (t === null) /* no ttl */
  else /* missing */

  // after
  const t = await client.ttl(k);
  switch (t.state) {
    case "expires": use(t.at); break;
    case "no-ttl": /* … */; break;
    case "missing": /* … */; break;
  }
  ```
- **Key validation is on by default.** Non-empty strings, no `\0`, total `namespace + key` length ≤ 512. Set `validateKeys: false` on the adapter options to opt out. Previous behavior silently accepted empty/overlong keys and let the backend error cryptically.

**Additive:**
- New methods `setIfAbsent`, `incr`, `decr`, `getSet`, `cas`, `keysIter` on every adapter.
- `setMultiple` accepts `{ key, value, ttl? }[]` entries in addition to the legacy `[key, value][]` tuples. Per-pair `ttl` overrides batch `options.ttl`.
- Deno KV: new `strictDeleteResult: true` option pre-checks existence so `delete()` returns the real did-it-exist flag (default stays `true` for BC).
- Deno KV: new `atomicRetryAttempts` option (default 20) for CAS-based primitives under contention.
- Default `clear()` in Deno KV now batches into atomic commits (500 at a time).

## Breaking Changes (2.0.0)

This release fixes several correctness bugs. Most fixes are behavior-preserving,
but a few change semantics in ways that could affect existing code:

- **`set(key, value, { ttl: 0 })` now explicitly disables expiration for the
  call, overriding any non-zero `defaultTtl`.** Before: `ttl: 0` was silently
  ignored and `defaultTtl` was used. If you relied on the old behavior, omit
  the `ttl` option instead of passing `0`.
- **Redis adapter: `destroy()` now closes connections that `initialize()` opened.**
  Connections that were already open when you passed them to the adapter remain
  under your control (unchanged). If your test harness used to close the
  underlying client twice, remove the redundant close.
- **Redis adapter: `__debug_dump()` is scoped to the adapter's namespace.**
  Before: it dumped every key in the selected DB (across tenants). After:
  only keys under this adapter's namespace.
- **`getMultiple()` preserves stored falsy values (`false`, `0`, `""`, `null`).**
  Before: all of these were coerced to `null`, indistinguishable from "key
  missing". After: stored falsy values round-trip; only missing keys map to
  `null`.
- **Deno KV: `exists(key)` returns `true` when the stored value is `null`.**
  Before: `null` values were reported as non-existent.
- **Deno KV: `keys()` is sorted.**
- **`keys()` and `clear()` now treat non-wildcard regex/LIKE metacharacters
  as literals.** Before: Memory/Deno KV adapters leaked `.`/`(`/`[` through to
  regex, and the PostgreSQL adapter leaked `%`/`_` through to LIKE. After:
  only `*` and `?` are wildcards; everything else matches literally.
- **PostgreSQL: `tableName` is validated.** Invalid names (anything outside
  `[A-Za-z0-9_.]`) now throw in the constructor instead of producing confusing
  SQL errors at runtime.

## Full API Reference

For complete API documentation including all methods, types, and adapter-specific options, see [API.md](API.md).

## Development

Node LTS (`.node-version`), pnpm, Biome, `node:test`. The source is erasable-only
TypeScript that Node runs directly; `dist/` is built only for publishing.

Every test runs against all three adapters, so `pnpm test` needs a running PostgreSQL and
Redis. Copy `.env.example` to `.env` and fill in the connection details. Redis keys in the
target database are deleted before each test, so point it at a scratch database (the
default is `/13`).

| Command                             | Does                                               |
| ----------------------------------- | -------------------------------------------------- |
| `pnpm install`                      | installs dependencies and dev tooling              |
| `pnpm test` / `pnpm run test:watch` | `node --test` over `tests/**/*.test.ts`            |
| `pnpm run typecheck`                | `tsc --noEmit` over `src` and `tests`              |
| `pnpm run lint` / `pnpm run format` | `biome check .` read-only / with `--write`         |
| `pnpm run ci`                       | typecheck + lint + test, what CI runs              |
| `pnpm run build`                    | `tsc -p tsconfig.build.json` → `dist/`             |
| `pnpm run rp` / `pnpm run rpm`      | patch / minor release, then publish to npm and JSR |

## License

[MIT](LICENSE)
