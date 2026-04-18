# @marianmeres/kv

[![NPM version](https://img.shields.io/npm/v/@marianmeres/kv.svg)](https://www.npmjs.com/package/@marianmeres/kv)
[![JSR version](https://jsr.io/badges/@marianmeres/kv)](https://jsr.io/@marianmeres/kv)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Key-value storage abstraction layer with support for multiple backend adapters:
- redis 
- postgresql
- memory
- Deno KV (only in Deno runtime)

The API is inspired by the Redis API.

## Installation

```shell
deno add jsr:@marianmeres/kv
```

```shell
npm i @marianmeres/kv
```

## Usage

```typescript
import { createKVClient } from '@marianmeres/kv';

// Basic usage with memory adapter (default)
const client = createKVClient("my-app-namespace:");

// Or specify a different adapter type
const redisClient = createKVClient(
    "my-app-namespace:",
    'redis', // 'redis' | 'postgres' | 'deno-kv' | 'memory'
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
client.set(key: string, value: any, options?): Promise<boolean>
client.get(key: string): Promise<any>
client.delete(key: string): Promise<boolean>
client.exists(key: string): Promise<boolean>
client.keys(pattern: string): Promise<string[]>
client.clear(pattern: string): Promise<number>
client.setMultiple(keyValuePairs: [string, any][], options?): Promise<any[]>
client.getMultiple(keys: string[]): Promise<Record<string, any>>
client.transaction(operations: Operation[]): Promise<any[]>
client.expire(key: string, ttl: number): Promise<boolean>
client.ttl(key: string): Promise<Date | null | false>
```

## Pattern Syntax

`keys()` and `clear()` use Redis-style glob patterns:

- `*` — match any number of characters
- `?` — match exactly one character
- all other characters (including `.`, `%`, `_`, `(`, `)`, `[`, `]`) are treated **literally**

## Adapter Feature Matrix

| Feature | Memory | Redis | PostgreSQL | Deno KV |
|---|:-:|:-:|:-:|:-:|
| Persistent | ✗ | ✓ | ✓ | ✓ |
| TTL on `set()` | ✓ | ✓ | ✓ | ✓ |
| `ttl()` query | ✓ | ✓ | ✓ | always `null` |
| `expire()` | ✓ | ✓ | ✓ | always `false` |
| Sorted `keys()` | ✓ | ✓ | ✓ | ✓ |
| Atomic `transaction()` | ✓ (single-threaded) | ✓ (MULTI) | ✓ (BEGIN/COMMIT) | ✓ when no `get` ops |
| `delete()` returns real existed-flag | ✓ | ✓ | ✓ | always `true` |
| Background TTL cleanup | optional | native (Redis does it) | optional | native (Deno.Kv does it) |
| `keys()` / `clear()` | ✓ | ✓ (non-cluster only) | ✓ | ✓ |

## Adapter-Specific Limitations

### Deno KV
- **`delete()`**: Always returns `true`, even for non-existent keys (Deno.Kv limitation)
- **`expire()`**: Not supported — always returns `false`
- **`ttl()`**: Not supported — always returns `null`
- **`transaction()`**: Atomic via `Deno.Kv.atomic()` **only** when the transaction contains no `get` operations. A transaction that mixes `get` with `set`/`delete` falls back to sequential (non-atomic) execution.
- **Note**: TTL can be set during `set()`, but cannot be queried or modified after.

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

## License

[MIT](LICENSE)
