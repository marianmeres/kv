import { AdapterMemory, type AdapterMemoryOptions } from "./adapter/memory.ts";
import {
	AdapterPostgres,
	type AdapterPostgresOptions,
} from "./adapter/postgres.ts";

interface KnownTypes {
	memory: { options: AdapterMemoryOptions; adapter: AdapterMemory };
	postgres: { options: AdapterPostgresOptions; adapter: AdapterPostgres };
}

/**  */
export function createKVClient<T extends keyof KnownTypes>(
	type: T,
	namespace: string = "",
	options: Partial<KnownTypes[T]["options"]> = {}
): KnownTypes[T]["adapter"] {
	//
	if (type === "memory") return new AdapterMemory(namespace, options);
	if (type === "postgres") return new AdapterPostgres(namespace, options);

	//
	throw new TypeError(`Unknown KV client type "${options.type}"`);
}
