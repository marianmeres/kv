import type { Logger } from "@marianmeres/clog";

/**
 * Options for the `set` operation.
 */
export interface SetOptions extends Record<string, any> {
	/** Time-to-live in seconds. After this time, the key will expire. */
	ttl: number;
}

/**
 * Information about the adapter instance.
 */
export interface AdapterInfo {
	/** The adapter type identifier (e.g., "redis", "postgres", "memory", "deno-kv"). */
	type: string;
}

/**
 * Base options shared by all adapter implementations.
 */
export interface AdapterAbstractOptions extends Record<string, any> {
	/** Default TTL in seconds applied to all `set` operations when not explicitly specified. Set to 0 to disable. */
	defaultTtl: number;
	/** Optional logger instance for debugging and error logging. */
	logger?: Logger;
}

/**
 * Represents a single operation within a transaction.
 */
export interface Operation {
	/** The type of operation to perform. */
	type: "set" | "get" | "delete";
	/** The key to operate on. */
	key: string;
	/** The value to set (only used for "set" operations). */
	value?: any;
	/** Optional settings for the operation (only used for "set" operations). */
	options?: Partial<SetOptions>;
}

function notImplemented(): any {
	throw new Error("Not implemented");
}

/**
 * Abstract base class for all KV storage adapters.
 *
 * Provides a unified interface for key-value operations across different storage backends.
 * All adapters must extend this class and implement the abstract methods.
 *
 * @example
 * ```typescript
 * const client = createKVClient("myapp:", "memory");
 * await client.initialize();
 * await client.set("user:123", { name: "John" });
 * const user = await client.get("user:123");
 * await client.destroy();
 * ```
 */
export abstract class AdapterAbstract {
	protected _type: string = "abstract";

	readonly options: AdapterAbstractOptions = {
		defaultTtl: 0,
	};

	protected _initialized: boolean = false;

	/**
	 * Creates a new adapter instance.
	 *
	 * @param namespace - Internal key prefix applied to all keys. Must end with a colon (`:`) or be empty.
	 *                    Acts as a low-level namespace (similar to a database schema).
	 * @param options - Adapter configuration options.
	 * @throws {TypeError} If namespace doesn't end with a colon and is not empty.
	 */
	constructor(
		public readonly namespace: string = "",
		options: Partial<AdapterAbstractOptions> = {}
	) {
		this.options = { ...this.options, ...(options || {}) };
		this._assertValidNamespace();
	}

	protected _assertInitialized() {
		if (!this._initialized) {
			throw new Error("Client does not appear to be initialized");
		}
	}

	protected _assertValidNamespace() {
		if (this.namespace && !this.namespace.endsWith(":")) {
			throw new TypeError(
				`Namespace must be either empty, or must end with a colon ("${this.namespace}")`
			);
		}
	}

	protected _withNs(key: string): string {
		return this.namespace + key;
	}

	protected _withoutNs(key: string): string {
		if (this.namespace) key = key.slice(this.namespace.length);
		return key;
	}

	/**
	 * Initializes the adapter and connects to the underlying storage.
	 *
	 * Must be called before any other operations. For some adapters (like memory),
	 * this is a no-op, but it should always be called for consistency.
	 *
	 * @returns A promise that resolves when the connection is established.
	 * @throws {Error} If connection fails.
	 */
	abstract initialize(): Promise<void>;

	/**
	 * Destroys the adapter and releases all resources.
	 *
	 * Should be called when the adapter is no longer needed to clean up
	 * connections, timers, and other resources.
	 *
	 * @param hard - If `true`, performs a hard cleanup (e.g., drops tables in PostgreSQL).
	 * @returns A promise that resolves when cleanup is complete.
	 */
	abstract destroy(hard?: boolean): Promise<void>;

	/**
	 * Stores a key-value pair in the storage.
	 *
	 * Values are automatically serialized to JSON. If the key already exists, it will be overwritten.
	 *
	 * @param key - The key to store the value under.
	 * @param value - The value to store. Can be any JSON-serializable value. `undefined` is stored as `null`.
	 * @param options - Optional settings including TTL.
	 * @returns A promise that resolves to `true` if the operation was successful.
	 *
	 * @example
	 * ```typescript
	 * await client.set("user:123", { name: "John" });
	 * await client.set("session:abc", { token: "xyz" }, { ttl: 3600 }); // expires in 1 hour
	 * ```
	 */
	set(
		key: string,
		value: any,
		options?: Partial<SetOptions>
	): Promise<boolean> {
		return notImplemented();
	}

	/**
	 * Retrieves a value by its key.
	 *
	 * @param key - The key to retrieve.
	 * @returns A promise that resolves to the stored value, or `null` if the key doesn't exist or has expired.
	 *
	 * @example
	 * ```typescript
	 * const user = await client.get("user:123");
	 * if (user) {
	 *   console.log(user.name);
	 * }
	 * ```
	 */
	get(key: string): Promise<any> {
		return notImplemented();
	}

	/**
	 * Deletes a key from the storage.
	 *
	 * @param key - The key to delete.
	 * @returns A promise that resolves to `true` if the key existed and was deleted,
	 *          `false` if the key didn't exist. Note: Deno KV always returns `true`.
	 *
	 * @example
	 * ```typescript
	 * const wasDeleted = await client.delete("user:123");
	 * ```
	 */
	delete(key: string): Promise<boolean> {
		return notImplemented();
	}

	/**
	 * Checks if a key exists in the storage.
	 *
	 * @param key - The key to check.
	 * @returns A promise that resolves to `true` if the key exists and hasn't expired, `false` otherwise.
	 *
	 * @example
	 * ```typescript
	 * if (await client.exists("user:123")) {
	 *   console.log("User exists");
	 * }
	 * ```
	 */
	exists(key: string): Promise<boolean> {
		return notImplemented();
	}

	/**
	 * Lists all keys matching a pattern.
	 *
	 * Uses Redis-style wildcard patterns:
	 * - `*` matches any number of characters
	 * - `?` matches exactly one character
	 *
	 * @param pattern - The pattern to match keys against (e.g., `"user:*"`, `"session:???"`).
	 * @returns A promise that resolves to an array of matching keys (without namespace prefix), sorted alphabetically.
	 *
	 * @example
	 * ```typescript
	 * const userKeys = await client.keys("user:*");
	 * const allKeys = await client.keys("*");
	 * ```
	 *
	 * @throws {Error} In Redis cluster mode.
	 */
	keys(pattern: string): Promise<string[]> {
		return notImplemented();
	}

	/**
	 * Deletes all keys matching a pattern.
	 *
	 * Uses the same pattern syntax as {@link keys}.
	 *
	 * @param pattern - The pattern to match keys against.
	 * @returns A promise that resolves to the number of keys deleted.
	 *
	 * @example
	 * ```typescript
	 * const deleted = await client.clear("session:*"); // Clear all sessions
	 * const clearedAll = await client.clear("*"); // Clear everything
	 * ```
	 *
	 * @throws {Error} In Redis cluster mode.
	 */
	clear(pattern: string): Promise<number> {
		return notImplemented();
	}

	/**
	 * Stores multiple key-value pairs in a single batch operation.
	 *
	 * More efficient than multiple individual `set` calls, especially for Redis and PostgreSQL.
	 *
	 * @param keyValuePairs - An array of `[key, value]` tuples to store.
	 * @param options - Optional settings applied to all pairs (e.g., TTL).
	 * @returns A promise that resolves to an array of boolean results for each operation.
	 *
	 * @example
	 * ```typescript
	 * await client.setMultiple([
	 *   ["user:1", { name: "Alice" }],
	 *   ["user:2", { name: "Bob" }],
	 * ], { ttl: 3600 });
	 * ```
	 */
	setMultiple(
		keyValuePairs: [string, any][],
		options?: Partial<SetOptions>
	): Promise<any[]> {
		return notImplemented();
	}

	/**
	 * Retrieves multiple values in a single batch operation.
	 *
	 * More efficient than multiple individual `get` calls, especially for Redis and PostgreSQL.
	 *
	 * @param keys - An array of keys to retrieve.
	 * @returns A promise that resolves to an object mapping keys to their values.
	 *          Missing or expired keys will have a value of `null`.
	 *
	 * @example
	 * ```typescript
	 * const users = await client.getMultiple(["user:1", "user:2", "user:3"]);
	 * // { "user:1": { name: "Alice" }, "user:2": null, "user:3": { name: "Charlie" } }
	 * ```
	 */
	getMultiple(keys: string[]): Promise<Record<string, any>> {
		return notImplemented();
	}

	/**
	 * Executes multiple operations within a single transaction.
	 *
	 * For adapters that support it (Redis, PostgreSQL), operations are atomic.
	 * For memory and Deno KV, operations are executed sequentially.
	 *
	 * @param operations - An array of operations to execute.
	 * @returns A promise that resolves to an array of results for each operation.
	 *
	 * @example
	 * ```typescript
	 * const results = await client.transaction([
	 *   { type: "set", key: "counter", value: 1 },
	 *   { type: "get", key: "counter" },
	 *   { type: "delete", key: "old:key" },
	 * ]);
	 * // [true, 1, true]
	 * ```
	 */
	transaction(operations: Operation[]): Promise<any[]> {
		return notImplemented();
	}

	/**
	 * Sets a new expiration time on an existing key.
	 *
	 * @param key - The key to set expiration on.
	 * @param ttl - Time-to-live in seconds from now.
	 * @returns A promise that resolves to `true` if the expiration was set,
	 *          `false` if the key doesn't exist. Note: Not supported in Deno KV (always returns `false`).
	 *
	 * @example
	 * ```typescript
	 * await client.set("session:abc", { user: "john" });
	 * await client.expire("session:abc", 1800); // Expire in 30 minutes
	 * ```
	 */
	expire(key: string, ttl: number): Promise<boolean> {
		return notImplemented();
	}

	/**
	 * Gets the expiration time of a key.
	 *
	 * @param key - The key to check.
	 * @returns A promise that resolves to:
	 *          - `Date` - The expiration date if TTL is set
	 *          - `null` - If the key exists but has no expiration
	 *          - `false` - If the key doesn't exist or has expired
	 *          Note: Deno KV always returns `null` (TTL query not supported).
	 *
	 * @example
	 * ```typescript
	 * const expiry = await client.ttl("session:abc");
	 * if (expiry instanceof Date) {
	 *   console.log(`Expires at: ${expiry.toISOString()}`);
	 * } else if (expiry === null) {
	 *   console.log("No expiration set");
	 * } else {
	 *   console.log("Key does not exist");
	 * }
	 * ```
	 */
	ttl(key: string): Promise<Date | null | false> {
		return notImplemented();
	}

	/**
	 * Returns information about the current adapter instance.
	 *
	 * @returns An object containing adapter metadata.
	 *
	 * @example
	 * ```typescript
	 * const info = client.info();
	 * console.log(info.type); // "redis", "postgres", "memory", or "deno-kv"
	 * ```
	 */
	info(): AdapterInfo {
		return {
			type: this._type,
		};
	}

	/**
	 * Dumps all stored data for debugging purposes.
	 *
	 * **Warning**: This method is intended for testing only. Do not use in production
	 * as it may be slow and resource-intensive for large datasets.
	 *
	 * @returns A promise that resolves to an object mapping keys to their values and TTL info.
	 * @internal
	 */
	__debug_dump(): Promise<
		Record<string, { value: any; ttl: Date | null | false }>
	> {
		return notImplemented();
	}
}
