# @marianmeres/kv

[![NPM version](https://img.shields.io/npm/v/@marianmeres/kv.svg)](https://www.npmjs.com/package/@marianmeres/kv)
[![JSR version](https://jsr.io/badges/@marianmeres/kv)](https://jsr.io/@marianmeres/kv)

Key-value storage abstraction layer with support of multiple backend adapters:
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

## Adapter-Specific Limitations

### Deno KV
- **`delete()`**: Always returns `true`, even for non-existent keys (Deno.Kv limitation)
- **`expire()`**: Not supported - always returns `false`
- **`ttl()`**: Not supported - always returns `null`
- **Note**: TTL can be set during `set()` operation, but cannot be queried or modified after

### Redis
- **`keys()` and `clear()`**: Not supported in cluster mode (throws error)
- **Namespace**: Required (cannot be empty string)

### PostgreSQL
- Creates a table (default: `__kv`) in your database
- Supports optional TTL cleanup via `ttlCleanupIntervalSec` option

### Memory
- Data is not persisted (in-memory only)
- Supports optional TTL cleanup via `ttlCleanupIntervalSec` option

## Package Identity

- **Name:** @marianmeres/kv
- **Author:** Marian Meres
- **Repository:** https://github.com/marianmeres/kv
- **License:** MIT