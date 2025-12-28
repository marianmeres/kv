# CLAUDE.md

## Package Overview

`@marianmeres/kv` is a key-value storage abstraction layer for Deno/Node.js. It provides a unified Redis-inspired API that works with multiple storage backends: memory, Redis, PostgreSQL, and Deno KV.

## Quick Facts

- **Entry point**: `src/mod.ts` (re-exports `src/kv.ts`)
- **Factory**: `createKVClient(namespace, type, options)` returns adapter instance
- **Adapters**: memory (default), redis, postgres, deno-kv
- **Namespace**: Must end with `:` or be empty string
- **Tests**: `deno test --unstable-kv -A --env-file`

## Key Files

- `src/kv.ts` - Factory function and exports
- `src/adapter/abstract.ts` - Base class and types
- `src/adapter/*.ts` - Adapter implementations
- `tests/kv.test.ts` - Test suite

## Common Tasks

```bash
# Run tests
deno test --unstable-kv -A --env-file

# Build for npm
deno run -A scripts/build-npm.ts
```

## API Summary

All adapters implement:
- `initialize()`, `destroy()`
- `set()`, `get()`, `delete()`, `exists()`
- `keys(pattern)`, `clear(pattern)`
- `setMultiple()`, `getMultiple()`
- `transaction()`, `expire()`, `ttl()`

## Adapter Limitations

- **Redis**: Namespace required; no `keys()`/`clear()` in cluster mode
- **Deno KV**: `delete()` always returns true; `expire()`/`ttl()` not supported
