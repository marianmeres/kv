/**
 * @module
 *
 * Factory module for creating KV client instances.
 *
 * Exports the main {@link createKVClient} factory function and re-exports
 * all adapter classes, types, and interfaces.
 */

import { AdapterDenoKv, type AdapterDenoKvOptions } from "./adapter/deno-kv.ts";
import { AdapterMemory, type AdapterMemoryOptions } from "./adapter/memory.ts";
import {
	AdapterPostgres,
	type AdapterPostgresOptions,
} from "./adapter/postgres.ts";
import { AdapterRedis, type AdapterRedisOptions } from "./adapter/redis.ts";

// Re-export all types for consumers
export type { SetOptions, AdapterInfo, AdapterAbstractOptions, Operation } from "./adapter/abstract.ts";
export { AdapterAbstract } from "./adapter/abstract.ts";
export { AdapterMemory, type AdapterMemoryOptions } from "./adapter/memory.ts";
export { AdapterRedis, type AdapterRedisOptions } from "./adapter/redis.ts";
export { AdapterPostgres, type AdapterPostgresOptions } from "./adapter/postgres.ts";
export { AdapterDenoKv, type AdapterDenoKvOptions } from "./adapter/deno-kv.ts";
export { sleep } from "./utils/sleep.ts";

/**
 * Type mapping for all supported KV adapter types.
 * @internal
 */
interface KnownTypes {
	memory: { options: AdapterMemoryOptions; adapter: AdapterMemory };
	postgres: { options: AdapterPostgresOptions; adapter: AdapterPostgres };
	redis: { options: AdapterRedisOptions; adapter: AdapterRedis };
	"deno-kv": { options: AdapterDenoKvOptions; adapter: AdapterDenoKv };
}

/**
 * Factory function to create a KV client with the specified adapter type.
 *
 * Creates and returns an adapter instance configured for the specified storage backend.
 * The returned client must be initialized with `await client.initialize()` before use.
 *
 * @typeParam T - The adapter type (inferred from the `type` parameter).
 *
 * @param namespace - Key prefix applied to all operations. Must end with `:` or be empty.
 *                    Used to isolate different applications or environments sharing the same storage.
 * @param type - The storage backend to use:
 *               - `"memory"` - In-memory storage (default, not persisted)
 *               - `"redis"` - Redis server (requires `db` option with Redis client)
 *               - `"postgres"` - PostgreSQL database (requires `db` option with pg client/pool)
 *               - `"deno-kv"` - Deno KV (Deno runtime only, requires `db` option with Deno.Kv)
 * @param options - Adapter-specific configuration options.
 *
 * @returns A configured adapter instance. Call `initialize()` before use.
 *
 * @throws {TypeError} If namespace doesn't end with `:` (and is not empty).
 * @throws {TypeError} If an unsupported adapter type is specified.
 * @throws {Error} If `"deno-kv"` is used outside the Deno runtime.
 * @throws {Error} If required options (like `db`) are missing for the adapter.
 *
 * @example
 * ```typescript
 * // In-memory storage (great for testing)
 * const memoryClient = createKVClient("test:", "memory");
 * await memoryClient.initialize();
 *
 * // Redis storage
 * import { createClient } from 'redis';
 * const redisClient = createClient();
 * const redis = createKVClient("myapp:", "redis", { db: redisClient });
 * await redis.initialize();
 *
 * // PostgreSQL storage
 * import pg from 'pg';
 * const pool = new pg.Pool({ connectionString: '...' });
 * const postgres = createKVClient("myapp:", "postgres", { db: pool });
 * await postgres.initialize();
 *
 * // Deno KV (Deno runtime only)
 * const kv = await Deno.openKv();
 * const denoKv = createKVClient("myapp:", "deno-kv", { db: kv });
 * await denoKv.initialize();
 * ```
 */
export function createKVClient<T extends keyof KnownTypes>(
	namespace: string = "",
	type: T = "memory" as T,
	options: Partial<KnownTypes[T]["options"]> = {}
): KnownTypes[T]["adapter"] {
	//
	if (type === "memory") return new AdapterMemory(namespace, options);
	if (type === "postgres") return new AdapterPostgres(namespace, options);
	if (type === "redis") return new AdapterRedis(namespace, options);

	if (type === "deno-kv") {
		if (typeof globalThis.Deno === "undefined") {
			throw new Error(`Type "${type}" is only supported under Deno runtime`);
		}
		return new AdapterDenoKv(namespace, options);
	}

	//
	throw new TypeError(`Unsupported KV client type "${type}"`);
}
