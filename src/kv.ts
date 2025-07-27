import { AdapterMemory, type AdapterMemoryOptions } from "./adapter/memory.ts";
import {
	AdapterPostgres,
	type AdapterPostgresOptions,
} from "./adapter/postgres.ts";
import { AdapterRedis, type AdapterRedisOptions } from "./adapter/redis.ts";

interface KnownTypes {
	memory: { options: AdapterMemoryOptions; adapter: AdapterMemory };
	postgres: { options: AdapterPostgresOptions; adapter: AdapterPostgres };
	redis: { options: AdapterRedisOptions; adapter: AdapterRedis };
}

/**  */
export function createKVClient<T extends keyof KnownTypes>(
	namespace: string = "",
	type: T = "redis" as any,
	options: Partial<KnownTypes[T]["options"]> = {}
): KnownTypes[T]["adapter"] {
	//
	if (type === "memory") return new AdapterMemory(namespace, options);
	if (type === "postgres") return new AdapterPostgres(namespace, options);
	if (type === "redis") return new AdapterRedis(namespace, options);

	//
	throw new TypeError(`Unsupported KV client type "${options.type}"`);
}
