/**
 * @module
 *
 * Abstract base class and shared types for all KV adapters.
 */

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
	/**
	 * When `true` (default), keys are validated on every operation: must be
	 * non-empty strings, no `\0` characters, and the total stored length
	 * (namespace + key) must be ≤ 512. Set to `false` to skip validation.
	 */
	validateKeys?: boolean;
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

/**
 * Extended shape accepted by {@link AdapterAbstract.setMultiple}.
 *
 * The tuple form `[key, value]` is preserved for backward compatibility;
 * the object form allows per-pair TTL that overrides `options.ttl`.
 */
export type SetMultipleEntry =
	| [string, any]
	| { key: string; value: any; ttl?: number };

/**
 * Result of a {@link AdapterAbstract.ttl} call.
 *
 * Discriminated union — switch on `.state`:
 * - `"missing"` — key does not exist (or has expired)
 * - `"no-ttl"` — key exists with no expiration
 * - `"expires"` — key exists and will expire at `at`
 */
export type TtlResult =
	| { state: "missing" }
	| { state: "no-ttl" }
	| { state: "expires"; at: Date };

/**
 * Thrown when a CAS-based atomic primitive (e.g. Deno KV `incr`/`cas`)
 * exhausts its retry budget due to contention on the key.
 */
export class KvRaceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "KvRaceError";
	}
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
		validateKeys: true,
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
		// NOTE: subclasses re-declare `namespace` with a field initializer, so
		// validation runs in each subclass constructor AFTER `super()` completes.
		// Calling `_assertValidNamespace()` here would see the base default (empty)
		// and provide no safety.
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
		if (this.options.validateKeys !== false) {
			if (typeof key !== "string" || key.length === 0) {
				throw new TypeError("KV key must be a non-empty string");
			}
			if (key.includes("\0")) {
				throw new TypeError("KV key must not contain null characters (\\0)");
			}
			if (this.namespace.length + key.length > 512) {
				throw new RangeError(
					`KV key exceeds 512-char limit (namespace + key = ${
						this.namespace.length + key.length
					})`
				);
			}
		}
		return this.namespace + key;
	}

	protected _withoutNs(key: string): string {
		if (this.namespace) key = key.slice(this.namespace.length);
		return key;
	}

	/**
	 * Resolves the effective TTL (in seconds) for a set operation.
	 *
	 * Uses `options.ttl` when provided, otherwise falls back to `defaultTtl`.
	 * Non-positive values (0 or less) mean "no expiration" and return `undefined`.
	 *
	 * Note: `{ ttl: 0 }` explicitly overrides a non-zero `defaultTtl` to mean
	 * "no expiration for this call".
	 */
	protected _resolveTtl(opts?: Partial<SetOptions>): number | undefined {
		const raw = opts?.ttl ?? this.options.defaultTtl;
		return raw && raw > 0 ? raw : undefined;
	}

	/**
	 * Converts a Redis-style glob pattern to a regular expression.
	 * Escapes regex metacharacters before translating `*`/`?`.
	 *
	 * Glob syntax: `*` matches any chars, `?` matches a single char.
	 * All other characters — including `.`, `(`, `)`, `[`, `]`, `+` — are
	 * matched literally.
	 */
	protected _globToRegex(pattern: string): RegExp {
		const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		const body = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
		return new RegExp(`^${body}$`);
	}

	/**
	 * Normalizes the polymorphic `setMultiple` input to a single shape.
	 */
	protected _normalizePairs(
		entries: readonly SetMultipleEntry[]
	): Array<{ key: string; value: any; ttl?: number }> {
		return entries.map((e) =>
			Array.isArray(e) ? { key: e[0], value: e[1] } : e
		);
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
	 * Stores a key-value pair only when the key does not already exist.
	 *
	 * @returns `true` if the value was stored, `false` if the key existed.
	 */
	setIfAbsent(
		key: string,
		value: any,
		options?: Partial<SetOptions>
	): Promise<boolean> {
		return notImplemented();
	}

	/**
	 * Atomically sets a new value and returns the previous one.
	 *
	 * @returns The previous value, or `null` if the key did not exist.
	 */
	getSet(
		key: string,
		value: any,
		options?: Partial<SetOptions>
	): Promise<any> {
		return notImplemented();
	}

	/**
	 * Atomically increments a numeric value.
	 *
	 * If the key does not exist, it is created with the value `by`.
	 * If the key exists but is not a JSON number, throws `TypeError`.
	 *
	 * TTL semantics: `options.ttl` (or `defaultTtl`) is applied only when the
	 * key is newly created by this call. Existing TTLs are preserved.
	 *
	 * @returns The new numeric value after the increment.
	 * @throws {TypeError} If the stored value is not a number.
	 */
	incr(
		key: string,
		by?: number,
		options?: Partial<SetOptions>
	): Promise<number> {
		return notImplemented();
	}

	/**
	 * Atomically decrements a numeric value. See {@link incr} for details.
	 */
	decr(
		key: string,
		by?: number,
		options?: Partial<SetOptions>
	): Promise<number> {
		return notImplemented();
	}

	/**
	 * Atomic compare-and-set. Replaces the stored value with `next` only when
	 * the currently-stored value deep-equals `expected`.
	 *
	 * Missing keys never match, even when `expected` is `null`.
	 *
	 * @returns `true` if the swap happened, `false` if the current value did
	 * not match.
	 */
	cas(
		key: string,
		expected: any,
		next: any,
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
	 *          `false` if the key didn't exist. Note: Deno KV always returns `true` unless
	 *          the adapter was created with `strictDeleteResult: true`.
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
	 * Iterates matching keys without materializing the full list.
	 *
	 * Prefer this over {@link keys} for unbounded or unknown-sized scans.
	 * Ordering is not guaranteed across adapters.
	 *
	 * @example
	 * ```ts
	 * for await (const k of client.keysIter("user:*")) {
	 *   console.log(k);
	 * }
	 * ```
	 */
	keysIter(pattern: string): AsyncIterable<string> {
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
	 * Accepts either tuples `[key, value]` (legacy) or objects
	 * `{ key, value, ttl? }`. Per-pair `ttl` overrides `options.ttl`.
	 *
	 * @param entries - Pairs to store.
	 * @param options - Optional batch-wide settings (TTL fallback).
	 * @returns Array of boolean results (one per entry).
	 *
	 * @example
	 * ```typescript
	 * await client.setMultiple([
	 *   ["user:1", { name: "Alice" }],
	 *   { key: "user:2", value: { name: "Bob" }, ttl: 30 },
	 * ], { ttl: 3600 });
	 * ```
	 */
	setMultiple(
		entries: readonly SetMultipleEntry[],
		options?: Partial<SetOptions>
	): Promise<boolean[]> {
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
	 * Gets the expiration time of a key as a discriminated union.
	 *
	 * @example
	 * ```typescript
	 * const t = await client.ttl("session:abc");
	 * switch (t.state) {
	 *   case "expires": console.log(`expires at ${t.at.toISOString()}`); break;
	 *   case "no-ttl":  console.log("no expiration"); break;
	 *   case "missing": console.log("key not found"); break;
	 * }
	 * ```
	 *
	 * Note: Deno KV cannot report TTL state — always returns `{ state: "no-ttl" }`
	 * for existing keys and `{ state: "missing" }` for absent ones.
	 */
	ttl(key: string): Promise<TtlResult> {
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
		Record<string, { value: any; ttl: Date | null }>
	> {
		return notImplemented();
	}
}
