# Claude Context

For comprehensive package documentation, architecture details, API reference, and implementation notes, read [llm.txt](./llm.txt).

## Quick Reference

- **Package**: @marianmeres/kv (v1.2.1)
- **Purpose**: Key-value storage abstraction with multiple backend adapters
- **Adapters**: memory, redis, postgres, deno-kv
- **Entry**: `src/mod.ts` → `createKVClient(namespace, type, options)`
- **Test**: `deno test --unstable-kv -A --env-file`
- **Build**: `deno task npm:build`
