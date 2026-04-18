# @marianmeres/kv API Reference

Complete API documentation for the key-value storage abstraction layer.

## Table of Contents

- [Factory Function](#factory-function)
- [Client Methods](#client-methods)
- [Types and Interfaces](#types-and-interfaces)
- [Adapter-Specific Options](#adapter-specific-options)
- [Utility Functions](#utility-functions)

---

## Factory Function

### `createKVClient<T>(namespace?, type?, options?)`

Creates and returns a KV client configured for the specified storage backend.

```typescript
function createKVClient<T extends keyof KnownTypes>(
  namespace: string = "",
  type: T = "memory",
  options: Partial<KnownTypes[T]["options"]> = {}
): KnownTypes[T]["adapter"]
```

**Type Parameters:**
- `T` - The adapter type (inferred from the `type` parameter)

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `namespace` | `string` | `""` | Key prefix applied to all operations. Must end with `:` or be empty. |
| `type` | `"memory" \| "redis" \| "postgres" \| "deno-kv"` | `"memory"` | The storage backend to use. |
| `options` | `Partial<AdapterOptions>` | `{}` | Adapter-specific configuration options. |

**Returns:** A configured adapter instance. Call `initialize()` before use.

**Throws:**
- `TypeError` - If namespace doesn't end with `:` (and is not empty)
- `TypeError` - If an unsupported adapter type is specified
- `Error` - If `"deno-kv"` is used outside the Deno runtime
- `Error` - If required options (like `db`) are missing for the adapter

**Example:**

```typescript
import { createKVClient } from "@marianmeres/kv";

// In-memory storage (great for testing)
const memoryClient = createKVClient("test:", "memory");
await memoryClient.initialize();

// Redis storage
import { createClient } from "redis";
const redisClient = createClient();
const redis = createKVClient("myapp:", "redis", { db: redisClient });
await redis.initialize();

// PostgreSQL storage
import pg from "pg";
const pool = new pg.Pool({ connectionString: "..." });
const postgres = createKVClient("myapp:", "postgres", { db: pool });
await postgres.initialize();

// Deno KV (Deno runtime only)
const kv = await Deno.openKv();
const denoKv = createKVClient("myapp:", "deno-kv", { db: kv });
await denoKv.initialize();
```

---

## Client Methods

All adapter instances implement the following methods:

### Lifecycle Methods

#### `initialize()`

Initializes the adapter and connects to the underlying storage.

```typescript
initialize(): Promise<void>
```

Must be called before any other operations. For some adapters (like memory), this is a no-op, but should always be called for consistency.

**Throws:** `Error` - If connection fails.

---

#### `destroy(hard?)`

Destroys the adapter and releases all resources.

```typescript
destroy(hard?: boolean): Promise<void>
```

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `hard` | `boolean` | `false` | If `true`, performs a hard cleanup (e.g., drops tables in PostgreSQL). |

---

#### `info()`

Returns information about the current adapter instance.

```typescript
info(): AdapterInfo
```

**Returns:** `{ type: string }` - Object containing adapter metadata.

```typescript
const info = client.info();
console.log(info.type); // "redis", "postgres", "memory", or "deno-kv"
```

---

### Single Key Operations

#### `set(key, value, options?)`

Stores a key-value pair in the storage.

```typescript
set(key: string, value: any, options?: Partial<SetOptions>): Promise<boolean>
```

Values are automatically serialized to JSON. If the key already exists, it will be overwritten.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `key` | `string` | The key to store the value under. |
| `value` | `any` | The value to store. Can be any JSON-serializable value. `undefined` is stored as `null`. |
| `options` | `Partial<SetOptions>` | Optional settings including TTL. |

**Returns:** `Promise<boolean>` - `true` if the operation was successful.

**TTL resolution:**

- If `options.ttl` is omitted, the adapter's `defaultTtl` is used.
- If `options.ttl` is a positive number, it overrides `defaultTtl` for this call.
- If `options.ttl` is `0` or negative, **no expiration** is applied — this explicitly overrides a non-zero `defaultTtl`.

**Example:**

```typescript
await client.set("user:123", { name: "John" });
await client.set("session:abc", { token: "xyz" }, { ttl: 3600 }); // expires in 1 hour
await client.set("pinned", 1, { ttl: 0 }); // never expires, even if defaultTtl > 0
```

---

#### `setIfAbsent(key, value, options?)`

Stores a value only if the key does not already exist. Atomic.

```typescript
setIfAbsent(key: string, value: any, options?: Partial<SetOptions>): Promise<boolean>
```

**Returns:** `true` if the value was stored, `false` if the key existed. Expired keys are treated as missing — `setIfAbsent` succeeds on them.

**Example** (lock pattern):

```typescript
if (await client.setIfAbsent("lock:job:42", { by: "worker-1" }, { ttl: 30 })) {
  // we got the lock
}
```

---

#### `getSet(key, value, options?)`

Atomically replaces the stored value and returns the previous one.

```typescript
getSet(key: string, value: any, options?: Partial<SetOptions>): Promise<any>
```

**Returns:** the previous value, or `null` if the key did not exist.

Stored falsy values (`false`, `0`, `""`, `null`) round-trip correctly.

---

#### `incr(key, by?, options?)` / `decr(key, by?, options?)`

Atomically increments (or decrements) a numeric value.

```typescript
incr(key: string, by?: number, options?: Partial<SetOptions>): Promise<number>
decr(key: string, by?: number, options?: Partial<SetOptions>): Promise<number>
```

**Parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `key` | `string` | — | The key to increment |
| `by` | `number` | `1` | Amount to add (or subtract for `decr`) |
| `options` | `Partial<SetOptions>` | — | TTL only applies on key creation — existing keys keep their TTL |

**Returns:** the new value after the operation.

**Errors:** throws `TypeError("KV value is not a number")` when the stored value is not a JSON number. On Deno KV under heavy contention, may throw `KvRaceError` after `atomicRetryAttempts` (default 20) failed CAS attempts.

**Example:**

```typescript
await client.incr("views");           // creates "views" = 1
await client.incr("views", 10);       // now 11
await client.decr("views", 3);        // now 8

// Sliding window: TTL only applied on first hit
await client.incr("rate:user:1", 1, { ttl: 60 });
```

---

#### `cas(key, expected, next, options?)`

Atomic compare-and-set — replaces the stored value only when the current value deep-equals `expected`.

```typescript
cas(key: string, expected: any, next: any, options?: Partial<SetOptions>): Promise<boolean>
```

**Returns:** `true` if the swap happened, `false` otherwise (mismatch or missing key).

> Missing keys never match, even when `expected` is `null`.

When `options.ttl` is supplied, the stored expiration is updated on success. When it is omitted, the existing TTL is preserved (Deno KV: best-effort — see the Deno KV section).

**Example** (optimistic update):

```typescript
const current = await client.get("counter");
const swapped = await client.cas("counter", current, current + 1);
if (!swapped) { /* retry or reconcile */ }
```

---

#### `get(key)`

Retrieves a value by its key.

```typescript
get(key: string): Promise<any>
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `key` | `string` | The key to retrieve. |

**Returns:** `Promise<any>` - The stored value, or `null` if the key doesn't exist or has expired.

**Example:**

```typescript
const user = await client.get("user:123");
if (user) {
  console.log(user.name);
}
```

---

#### `delete(key)`

Deletes a key from the storage.

```typescript
delete(key: string): Promise<boolean>
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `key` | `string` | The key to delete. |

**Returns:** `Promise<boolean>` - `true` if the key existed and was deleted, `false` if it didn't exist.

> **Note:** Deno KV always returns `true`, even for non-existent keys.

---

#### `exists(key)`

Checks if a key exists in the storage.

```typescript
exists(key: string): Promise<boolean>
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `key` | `string` | The key to check. |

**Returns:** `Promise<boolean>` - `true` if the key exists and hasn't expired.

> A key with a stored value of `null` is considered to exist. `exists()` only returns `false` when the key is missing or has expired.

---

#### `expire(key, ttl)`

Sets a new expiration time on an existing key.

```typescript
expire(key: string, ttl: number): Promise<boolean>
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `key` | `string` | The key to set expiration on. |
| `ttl` | `number` | Time-to-live in seconds from now. |

**Returns:** `Promise<boolean>` - `true` if the expiration was set, `false` if the key doesn't exist.

> **Note:** Not supported in Deno KV (always returns `false`).

**Example:**

```typescript
await client.set("session:abc", { user: "john" });
await client.expire("session:abc", 1800); // Expire in 30 minutes
```

---

#### `ttl(key)`

Gets the expiration state of a key as a discriminated union.

```typescript
ttl(key: string): Promise<TtlResult>

type TtlResult =
  | { state: "missing" }
  | { state: "no-ttl" }
  | { state: "expires"; at: Date };
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `key` | `string` | The key to check. |

**Returns:** A `TtlResult`. Switch on `.state`:
- `"missing"` — key doesn't exist (or has expired)
- `"no-ttl"` — key exists with no expiration
- `"expires"` — key exists and will expire at `.at`

> **Note:** Deno KV cannot query TTL — existing keys always return `{ state: "no-ttl" }`; absent keys return `{ state: "missing" }`.

**Example:**

```typescript
const t = await client.ttl("session:abc");
switch (t.state) {
  case "expires": console.log(`Expires at ${t.at.toISOString()}`); break;
  case "no-ttl":  console.log("No expiration set"); break;
  case "missing": console.log("Key does not exist"); break;
}
```

**Migrating from pre-3.0** (`Date | null | false`):

```typescript
// old
const t = await client.ttl(k);
if (t instanceof Date) use(t);
else if (t === null) // no ttl
else // missing

// new (equivalent)
const t = await client.ttl(k);
if (t.state === "expires") use(t.at);
else if (t.state === "no-ttl") // no ttl
else // missing
```

---

### Pattern-Based Operations

#### `keys(pattern)`

Lists all keys matching a pattern.

```typescript
keys(pattern: string): Promise<string[]>
```

Uses Redis-style wildcard patterns:
- `*` matches any number of characters
- `?` matches exactly one character
- **Every other character is a literal match**, including regex metacharacters (`.`, `(`, `[`, `+`, `^`, `$`, `|`) and SQL LIKE metacharacters (`%`, `_`, `\`).

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `pattern` | `string` | The pattern to match keys against (e.g., `"user:*"`, `"session:???"`). |

**Returns:** `Promise<string[]>` - Array of matching keys (without namespace prefix), sorted alphabetically.

**Throws:** `Error` - In Redis cluster mode.

**Example:**

```typescript
const userKeys = await client.keys("user:*");
const allKeys = await client.keys("*");

// literal dot, not "any char"
const dotted = await client.keys("config.yaml"); // matches ONLY "config.yaml"
```

---

#### `keysIter(pattern)`

Iterates matching keys without materializing the full list. Prefer this over `keys()` for unbounded or unknown-sized scans.

```typescript
keysIter(pattern: string): AsyncIterable<string>
```

Ordering is not guaranteed across adapters — use `keys()` if you need sorted output.

**Per-adapter behavior:**
- Redis: wraps `SCAN` (non-blocking).
- PostgreSQL: uses a server-side cursor (`DECLARE CURSOR`) inside a short transaction. Early break releases the cursor and commits.
- Deno KV: direct `db.list()` pass-through.
- Memory: yields from the internal `Map`.

**Example:**

```typescript
for await (const k of client.keysIter("user:*")) {
  if (someCondition(k)) break; // safe — cursor is released
}
```

---

#### `clear(pattern)`

Deletes all keys matching a pattern.

```typescript
clear(pattern: string): Promise<number>
```

Uses the same pattern syntax as `keys()`.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `pattern` | `string` | The pattern to match keys against. |

**Returns:** `Promise<number>` - The number of keys deleted.

**Throws:** `Error` - In Redis cluster mode.

**Example:**

```typescript
const deleted = await client.clear("session:*"); // Clear all sessions
const clearedAll = await client.clear("*"); // Clear everything
```

---

### Batch Operations

#### `setMultiple(entries, options?)`

Stores multiple key-value pairs in a single batch operation.

```typescript
setMultiple(
  entries: [string, any][] | { key: string; value: any; ttl?: number }[],
  options?: Partial<SetOptions>
): Promise<boolean[]>
```

Accepts either the legacy tuple shape or an object shape that allows a **per-pair `ttl`** overriding `options.ttl`.

More efficient than multiple individual `set` calls, especially for Redis, PostgreSQL, and Deno KV (the latter commits atomically).

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `entries` | `[string, any][]` or `{ key, value, ttl? }[]` | Pairs to store. |
| `options` | `Partial<SetOptions>` | Fallback TTL used when a pair has no explicit `ttl`. |

**Returns:** `Promise<boolean[]>` — one per entry.

**Example:**

```typescript
await client.setMultiple(
  [
    ["user:1", { name: "Alice" }],           // uses options.ttl
    { key: "user:2", value: { name: "Bob" }, ttl: 60 }, // overrides to 60s
  ],
  { ttl: 3600 }
);
```

---

#### `getMultiple(keys)`

Retrieves multiple values in a single batch operation.

```typescript
getMultiple(keys: string[]): Promise<Record<string, any>>
```

More efficient than multiple individual `get` calls.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `keys` | `string[]` | Array of keys to retrieve. |

**Returns:** `Promise<Record<string, any>>` - Object mapping keys to their values. Only **missing** or expired keys are reported as `null`; stored falsy values (`false`, `0`, `""`, `null`) are returned verbatim.

**Example:**

```typescript
await client.set("flag", false);
await client.set("count", 0);

const got = await client.getMultiple(["flag", "count", "missing"]);
// { flag: false, count: 0, missing: null }
```

---

### Transactions

#### `transaction(operations)`

Executes multiple operations within a single transaction.

```typescript
transaction(operations: Operation[]): Promise<any[]>
```

Atomicity per adapter:

| Adapter | Atomic | Notes |
|---------|:-:|---|
| Memory | ✓ | Single-threaded by nature |
| Redis | ✓ | Uses `MULTI`/`EXEC` |
| PostgreSQL | ✓ | Pins a single connection for `BEGIN`/…/`COMMIT`, even on a `pg.Pool` |
| Deno KV | Conditional | Atomic via `Deno.Kv.atomic()` when the transaction contains **no** `get` ops; falls back to sequential (non-atomic) when a `get` is present (Deno.Kv has no atomic-read) |

Per-operation `options.ttl` is honored by **all** adapters (Redis, PostgreSQL, Memory, Deno KV).

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `operations` | `Operation[]` | Array of operations to execute. |

**Returns:** `Promise<any[]>` - Array of results for each operation.

**Example:**

```typescript
const results = await client.transaction([
  { type: "set", key: "counter", value: 1, options: { ttl: 60 } },
  { type: "get", key: "counter" },
  { type: "delete", key: "old:key" },
]);
// [true, 1, true]
```

---

## Types and Interfaces

### `SetOptions`

Options for the `set` operation.

```typescript
interface SetOptions {
  /** Time-to-live in seconds. After this time, the key will expire. */
  ttl: number;
}
```

---

### `AdapterInfo`

Information about the adapter instance.

```typescript
interface AdapterInfo {
  /** The adapter type identifier. */
  type: string; // "redis" | "postgres" | "memory" | "deno-kv"
}
```

---

### `AdapterAbstractOptions`

Base options shared by all adapter implementations.

```typescript
interface AdapterAbstractOptions {
  /** Default TTL in seconds applied to all set operations when not explicitly specified. Set to 0 to disable. */
  defaultTtl: number;
  /** Optional logger instance for debugging and error logging. */
  logger?: Logger;
  /**
   * When true (default), keys are validated on every operation:
   * - non-empty string
   * - no `\0` characters
   * - total `namespace + key` length ≤ 512
   * Set to false to opt out.
   */
  validateKeys?: boolean;
}
```

---

### `TtlResult`

```typescript
type TtlResult =
  | { state: "missing" }
  | { state: "no-ttl" }
  | { state: "expires"; at: Date };
```

Return shape of `ttl(key)`. See the `ttl()` method above.

---

### `SetMultipleEntry`

```typescript
type SetMultipleEntry =
  | [string, any]
  | { key: string; value: any; ttl?: number };
```

Input shape accepted by `setMultiple()`.

---

### `KvRaceError`

```typescript
class KvRaceError extends Error { /* ... */ }
```

Thrown by Deno KV-backed CAS primitives (`incr`, `decr`, `getSet`, `cas`) when the retry budget is exhausted due to contention. Configurable via the adapter's `atomicRetryAttempts` option.

---

### `Operation`

Represents a single operation within a transaction.

```typescript
interface Operation {
  /** The type of operation to perform. */
  type: "set" | "get" | "delete";
  /** The key to operate on. */
  key: string;
  /** The value to set (only used for "set" operations). */
  value?: any;
  /** Optional settings for the operation (only used for "set" operations). */
  options?: Partial<SetOptions>;
}
```

---

## Adapter-Specific Options

### `AdapterMemoryOptions`

```typescript
interface AdapterMemoryOptions extends AdapterAbstractOptions {
  /**
   * Interval in seconds for automatic cleanup of expired keys.
   * Set to 0 to disable automatic cleanup (expired keys will still be
   * lazily removed on access).
   */
  ttlCleanupIntervalSec: number;
}
```

---

### `AdapterRedisOptions`

```typescript
interface AdapterRedisOptions extends AdapterAbstractOptions {
  /**
   * Redis client instance created via `createClient()` or `createClientPool()`.
   * Pool support is experimental and not fully tested.
   */
  db: ReturnType<typeof createClient> | ReturnType<typeof createClientPool>;
  /**
   * Set to `true` if connecting to a Redis Cluster.
   * Note: `keys()` and `clear()` operations are not supported in cluster mode.
   */
  isCluster: boolean;
}
```

**Important:** Namespace is required for Redis adapter (cannot be empty string).

**Connection ownership:**

- If the client passed via `db` is **not yet open** when `initialize()` runs, the adapter connects it **and** will close it on `destroy()`.
- If the client is **already open** when `initialize()` runs, the adapter leaves the connection untouched on `destroy()` — the caller owns the lifecycle. This is the path for sharing one client across multiple adapters with different namespaces.
- `initialize()` is idempotent — repeated calls do not stack `error` listeners.

---

### `AdapterPostgresOptions`

```typescript
interface AdapterPostgresOptions extends AdapterAbstractOptions {
  /** PostgreSQL connection instance - either `pg.Pool` or `pg.Client`. */
  db: pg.Pool | pg.Client;
  /**
   * Name of the table to use for storing key-value pairs.
   * The table will be created automatically if it doesn't exist.
   * May be prefixed with a schema, e.g. "public.kv".
   * Must match `^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$`
   * (word characters, optionally with one `schema.` prefix).
   * @default "__kv"
   */
  tableName: string;
  /**
   * Interval in seconds for automatic cleanup of expired keys.
   * Set to 0 to disable automatic cleanup.
   */
  ttlCleanupIntervalSec: number;
}
```

**Transactions on a Pool:**
`transaction()` checks out a single client from the pool (via `pool.connect()`) for the entire `BEGIN`/`COMMIT`/`ROLLBACK` block, so atomicity holds even when multiple transactions run concurrently against the same `pg.Pool`. On a `pg.Client`, no checkout happens.

**Table Schema:**
- `key` (VARCHAR 512) - Primary key
- `value` (JSONB) - Stored value
- `expires_at` (TIMESTAMP WITH TIME ZONE) - Expiration time
- `created_at` (TIMESTAMP WITH TIME ZONE) - Creation time
- `updated_at` (TIMESTAMP WITH TIME ZONE) - Last update time

---

### `AdapterDenoKvOptions`

```typescript
interface AdapterDenoKvOptions extends AdapterAbstractOptions {
  /**
   * Deno.Kv instance obtained via `Deno.openKv()`.
   */
  db: Deno.Kv;

  /**
   * When true, `delete()` pre-checks the key's existence and returns the
   * real "did it exist?" flag — at the cost of one extra round-trip.
   * Default false preserves the Deno.Kv native always-true behavior.
   */
  strictDeleteResult?: boolean;

  /**
   * Max retry attempts for CAS-based primitives (incr/decr/getSet/cas)
   * before throwing KvRaceError. Each retry adds exponential-with-jitter
   * backoff capped at 50ms.
   * @default 20
   */
  atomicRetryAttempts?: number;
}
```

**Limitations:**
- Only works in Deno runtime
- `delete()` always returns `true` by default (Deno.Kv limitation) — opt-in to strict behavior via `strictDeleteResult: true`
- `expire()` is not supported (always returns `false`)
- `ttl()` returns `{ state: "no-ttl" }` for any existing key and `{ state: "missing" }` for absent ones — Deno.Kv cannot report the actual expiration
- TTL can be set during `set()` but cannot be queried afterward
- `transaction()` is atomic (via `Deno.Kv.atomic()`) **only** when the transaction contains no `get` operations — a mixed transaction falls back to sequential, non-atomic execution
- `cas()` without `options.ttl` is best-effort TTL-preserving: Deno.Kv cannot read the current expiration, so any existing `expireIn` is cleared when the swap succeeds. Supply `options.ttl` explicitly if the key should remain bounded.

---

## Utility Functions

### `sleep(timeout, __timeout_ref__?)`

Delays execution for the specified number of milliseconds.

```typescript
function sleep(
  timeout: number,
  __timeout_ref__?: { id: number }
): Promise<void>
```

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `timeout` | `number` | - | The delay in milliseconds. |
| `__timeout_ref__` | `{ id: number }` | `{ id: -1 }` | Optional reference object to capture the timeout ID for cleanup. |

**Example:**

```typescript
import { sleep } from "@marianmeres/kv";

await sleep(1000); // Wait 1 second

// With timeout reference for cleanup
const ref = { id: -1 };
const sleepPromise = sleep(5000, ref);
// Later: clearTimeout(ref.id);
```
