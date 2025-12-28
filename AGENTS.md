# @marianmeres/kv - Agent Reference

Machine-friendly reference for AI agents working with this codebase.

## Package Identity

- **Name**: `@marianmeres/kv`
- **Version**: 1.2.2
- **License**: MIT
- **Runtime**: Deno (primary), Node.js (via npm build)
- **Language**: TypeScript

## Purpose

Key-value storage abstraction layer providing a unified Redis-inspired API across multiple storage backends.

## Supported Adapters

| Adapter | Type String | Required Options | Limitations |
|---------|-------------|------------------|-------------|
| Memory | `"memory"` | None | Not persisted |
| Redis | `"redis"` | `db` (Redis client) | Namespace required; `keys()`/`clear()` unavailable in cluster mode |
| PostgreSQL | `"postgres"` | `db` (pg.Pool/Client) | None |
| Deno KV | `"deno-kv"` | `db` (Deno.Kv) | Deno runtime only; `delete()` always true; `expire()`/`ttl()` not supported |

## File Structure

```
src/
├── mod.ts                    # Main entry point, re-exports kv.ts
├── kv.ts                     # Factory function and all exports
├── adapter/
│   ├── abstract.ts           # Base class + shared types
│   ├── memory.ts             # In-memory adapter
│   ├── redis.ts              # Redis adapter
│   ├── postgres.ts           # PostgreSQL adapter
│   └── deno-kv.ts            # Deno KV adapter
└── utils/
    └── sleep.ts              # Sleep utility function

tests/
├── kv.test.ts                # Main test file
├── _tests-runner.ts          # Test harness
├── _redis.ts                 # Redis test helper
└── _pg.ts                    # PostgreSQL test helper
```

## Core API

### Factory

```typescript
createKVClient(namespace?: string, type?: AdapterType, options?: AdapterOptions): Adapter
```

### Client Methods

```
initialize(): Promise<void>
destroy(hard?: boolean): Promise<void>
info(): AdapterInfo
set(key: string, value: any, options?: SetOptions): Promise<boolean>
get(key: string): Promise<any>
delete(key: string): Promise<boolean>
exists(key: string): Promise<boolean>
keys(pattern: string): Promise<string[]>
clear(pattern: string): Promise<number>
setMultiple(pairs: [string, any][], options?: SetOptions): Promise<boolean[]>
getMultiple(keys: string[]): Promise<Record<string, any>>
transaction(operations: Operation[]): Promise<any[]>
expire(key: string, ttl: number): Promise<boolean>
ttl(key: string): Promise<Date | null | false>
```

## Key Types

```typescript
interface SetOptions { ttl: number }
interface AdapterInfo { type: string }
interface AdapterAbstractOptions { defaultTtl: number; logger?: Logger }
interface Operation { type: "set" | "get" | "delete"; key: string; value?: any; options?: SetOptions }
```

## Commands

```bash
# Run tests (requires --unstable-kv for Deno KV)
deno test --unstable-kv -A --env-file

# Run tests with watch mode
deno test --unstable-kv -A --env-file --watch

# Build npm package
deno run -A scripts/build-npm.ts

# Publish to npm
deno run -A scripts/build-npm.ts && cd ./.npm-dist && npm publish --access=public
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

## Implementation Notes

1. **Namespace**: Must end with `:` or be empty string
2. **Value Serialization**: All values JSON-stringified internally
3. **TTL**: In seconds; stored as absolute Date internally
4. **Pattern Matching**: Redis-style (`*` = any chars, `?` = single char)
5. **Transactions**: Atomic for Redis/PostgreSQL; sequential for memory/Deno KV

## Dependencies

- `@marianmeres/clog` - Logging
- `pg` - PostgreSQL driver
- `redis` - Redis client

## Extending

To add a new adapter:
1. Create `src/adapter/<name>.ts`
2. Extend `AdapterAbstract`
3. Implement all abstract/interface methods
4. Add to `KnownTypes` in `src/kv.ts`
5. Add case in `createKVClient` factory
6. Export from `src/kv.ts`
