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

**Example:**

```typescript
await client.set("user:123", { name: "John" });
await client.set("session:abc", { token: "xyz" }, { ttl: 3600 }); // expires in 1 hour
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

Gets the expiration time of a key.

```typescript
ttl(key: string): Promise<Date | null | false>
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `key` | `string` | The key to check. |

**Returns:**
- `Date` - The expiration date if TTL is set
- `null` - If the key exists but has no expiration
- `false` - If the key doesn't exist or has expired

> **Note:** Deno KV always returns `null` (TTL query not supported).

**Example:**

```typescript
const expiry = await client.ttl("session:abc");
if (expiry instanceof Date) {
  console.log(`Expires at: ${expiry.toISOString()}`);
} else if (expiry === null) {
  console.log("No expiration set");
} else {
  console.log("Key does not exist");
}
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

#### `setMultiple(keyValuePairs, options?)`

Stores multiple key-value pairs in a single batch operation.

```typescript
setMultiple(keyValuePairs: [string, any][], options?: Partial<SetOptions>): Promise<boolean[]>
```

More efficient than multiple individual `set` calls, especially for Redis and PostgreSQL.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `keyValuePairs` | `[string, any][]` | Array of `[key, value]` tuples to store. |
| `options` | `Partial<SetOptions>` | Optional settings applied to all pairs (e.g., TTL). |

**Returns:** `Promise<boolean[]>` - Array of boolean results for each operation.

**Example:**

```typescript
await client.setMultiple([
  ["user:1", { name: "Alice" }],
  ["user:2", { name: "Bob" }],
], { ttl: 3600 });
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

**Returns:** `Promise<Record<string, any>>` - Object mapping keys to their values. Missing or expired keys will have a value of `null`.

**Example:**

```typescript
const users = await client.getMultiple(["user:1", "user:2", "user:3"]);
// { "user:1": { name: "Alice" }, "user:2": null, "user:3": { name: "Charlie" } }
```

---

### Transactions

#### `transaction(operations)`

Executes multiple operations within a single transaction.

```typescript
transaction(operations: Operation[]): Promise<any[]>
```

For adapters that support it (Redis, PostgreSQL), operations are atomic. For memory and Deno KV, operations are executed sequentially.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `operations` | `Operation[]` | Array of operations to execute. |

**Returns:** `Promise<any[]>` - Array of results for each operation.

**Example:**

```typescript
const results = await client.transaction([
  { type: "set", key: "counter", value: 1 },
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
}
```

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

---

### `AdapterPostgresOptions`

```typescript
interface AdapterPostgresOptions extends AdapterAbstractOptions {
  /** PostgreSQL connection instance - either `pg.Pool` or `pg.Client`. */
  db: pg.Pool | pg.Client;
  /**
   * Name of the table to use for storing key-value pairs.
   * The table will be created automatically if it doesn't exist.
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
}
```

**Limitations:**
- Only works in Deno runtime
- `delete()` always returns `true` (Deno.Kv limitation)
- `expire()` is not supported (always returns `false`)
- `ttl()` is not supported (always returns `null`)
- TTL can be set during `set()` but cannot be queried afterward

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
