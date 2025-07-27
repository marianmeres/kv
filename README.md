# @marianmeres/kv

Key-value storage abstraction layer with support of multiple backend adapters:
- redis 
- postgresql
- memory

TODO: Deno KV adapter

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

const client = createKVClient(
    "my-app-namespace", 
    type: 'redis' | 'postgres' | 'memory' = 'memory', 
    db: ..., // redisClient (for redis) or pg.Pool/pg.Client (for postgres)...
    options, // adapter specific options
);

//
await client.set('my:foo:key', { my: "value" })
await client.get('my:foo:key'); // { my: "value" }
await client.keys('my:*'); // ['my:foo:key']
```

## Api

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