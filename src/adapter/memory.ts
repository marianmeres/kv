/**
 * @module
 *
 * In-memory key-value storage adapter implementation.
 */

import { createClog } from "@marianmeres/clog";
import {
	AdapterAbstract,
	type AdapterAbstractOptions,
	type Operation,
	type SetMultipleEntry,
	type SetOptions,
	type TtlResult,
} from "./abstract.ts";

/**
 * Configuration options for the in-memory KV adapter.
 */
export interface AdapterMemoryOptions extends AdapterAbstractOptions {
	/**
	 * Interval in seconds for automatic cleanup of expired keys.
	 * Set to 0 to disable automatic cleanup (expired keys will still be
	 * lazily removed on access).
	 */
	ttlCleanupIntervalSec: number;
}

/**
 * In-memory key-value storage adapter.
 *
 * Stores all data in memory using JavaScript Maps. Data is not persisted
 * and will be lost when the process exits.
 *
 * @remarks
 * - Fast and simple, ideal for testing and caching
 * - Supports TTL with optional automatic cleanup
 * - Thread-safe within a single Node.js/Deno process
 * - Not suitable for multi-process or distributed environments
 *
 * @example
 * ```typescript
 * const client = createKVClient("myapp:", "memory", {
 *   defaultTtl: 3600,
 *   ttlCleanupIntervalSec: 60, // Clean expired keys every minute
 * });
 * await client.initialize();
 * await client.set("key", "value");
 * ```
 */
export class AdapterMemory extends AdapterAbstract {
	override _type = "memory";

	override readonly options: AdapterMemoryOptions = {
		defaultTtl: 0, // no ttl by default
		ttlCleanupIntervalSec: 0,
		logger: createClog("KV/memory"),
		validateKeys: true,
	};

	#store = new Map<string, string>();
	#expirations = new Map<string, Date>();
	#cleanupTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		public override readonly namespace: string = "",
		options: Partial<AdapterMemoryOptions> = {}
	) {
		super();
		this.options = Object.freeze({ ...this.options, ...(options || {}) });
		this._assertValidNamespace();
	}

	/** @inheritdoc */
	override initialize(): Promise<void> {
		this._initialized = true;
		this.#maybeTTLCleanup();
		return Promise.resolve();
	}

	/** @inheritdoc */
	override destroy(_hard?: boolean): Promise<void> {
		this._initialized = false;
		clearTimeout(this.#cleanupTimer);
		return Promise.resolve();
	}

	#maybeTTLCleanup() {
		clearTimeout(this.#cleanupTimer); // safety
		if (this.options.ttlCleanupIntervalSec) {
			// do the cleanup now
			const now = new Date();
			for (const [key, expiresAt] of this.#expirations.entries()) {
				if (expiresAt.valueOf() <= now.valueOf()) {
					this.#store.delete(key);
					this.#expirations.delete(key);
				}
			}

			// schedule next...
			this.#cleanupTimer = setTimeout(
				this.#maybeTTLCleanup.bind(this),
				this.options.ttlCleanupIntervalSec * 1000
			);
		}
	}

	#isExpired(key: string): boolean {
		const expiresAt = this.#expirations.get(key);
		if (!expiresAt) return false;

		if (Date.now() > expiresAt.valueOf()) {
			this.#store.delete(key);
			this.#expirations.delete(key);
			return true;
		}

		return false;
	}

	#applyTtl(nsKey: string, ttlSeconds: number | undefined) {
		if (ttlSeconds) {
			this.#expirations.set(nsKey, new Date(Date.now() + ttlSeconds * 1_000));
		} else {
			this.#expirations.delete(nsKey);
		}
	}

	/** @inheritdoc */
	override async set(
		key: string,
		value: any,
		options: Partial<SetOptions> = {}
	): Promise<boolean> {
		this._assertInitialized();
		const nsKey = this._withNs(key);

		// to be consistent across adapters, keeping internally the strigified version...
		this.#store.set(nsKey, JSON.stringify(value));
		this.#applyTtl(nsKey, this._resolveTtl(options));

		return true;
	}

	/** @inheritdoc */
	override async setIfAbsent(
		key: string,
		value: any,
		options: Partial<SetOptions> = {}
	): Promise<boolean> {
		this._assertInitialized();
		const nsKey = this._withNs(key);

		if (this.#store.has(nsKey) && !this.#isExpired(nsKey)) {
			return false;
		}

		this.#store.set(nsKey, JSON.stringify(value));
		this.#applyTtl(nsKey, this._resolveTtl(options));
		return true;
	}

	/** @inheritdoc */
	override async getSet(
		key: string,
		value: any,
		options: Partial<SetOptions> = {}
	): Promise<any> {
		this._assertInitialized();
		const previous = await this.get(key);
		await this.set(key, value, options);
		return previous;
	}

	#incrBy(
		key: string,
		delta: number,
		options: Partial<SetOptions> = {}
	): number {
		this._assertInitialized();
		const nsKey = this._withNs(key);

		const existed = this.#store.has(nsKey) && !this.#isExpired(nsKey);
		let current = 0;
		if (existed) {
			const raw = JSON.parse(this.#store.get(nsKey)!);
			if (typeof raw !== "number") {
				throw new TypeError("KV value is not a number");
			}
			current = raw;
		}
		const next = current + delta;
		this.#store.set(nsKey, JSON.stringify(next));
		// only set TTL when the key was newly created
		if (!existed) this.#applyTtl(nsKey, this._resolveTtl(options));
		return next;
	}

	/** @inheritdoc */
	override async incr(
		key: string,
		by = 1,
		options: Partial<SetOptions> = {}
	): Promise<number> {
		return this.#incrBy(key, by, options);
	}

	/** @inheritdoc */
	override async decr(
		key: string,
		by = 1,
		options: Partial<SetOptions> = {}
	): Promise<number> {
		return this.#incrBy(key, -by, options);
	}

	/** @inheritdoc */
	override async cas(
		key: string,
		expected: any,
		next: any,
		options: Partial<SetOptions> = {}
	): Promise<boolean> {
		this._assertInitialized();
		const nsKey = this._withNs(key);
		if (!this.#store.has(nsKey) || this.#isExpired(nsKey)) {
			return false;
		}
		const currentRaw = JSON.parse(this.#store.get(nsKey)!);
		if (JSON.stringify(currentRaw) !== JSON.stringify(expected)) {
			return false;
		}
		this.#store.set(nsKey, JSON.stringify(next));
		// CAS preserves existing TTL unless options.ttl is provided
		if (options.ttl !== undefined) {
			this.#applyTtl(nsKey, this._resolveTtl(options));
		}
		return true;
	}

	/** @inheritdoc */
	override async get(key: string): Promise<any> {
		this._assertInitialized();
		const nsKey = this._withNs(key);

		if (this.#isExpired(nsKey)) return null;

		const value = this.#store.get(nsKey);

		// NOTE: even if the saved value was `undefined` it is always returned as `null`
		if (value === undefined) return null;

		return JSON.parse(value);
	}

	/** @inheritdoc */
	override async delete(key: string): Promise<boolean> {
		this._assertInitialized();
		const nsKey = this._withNs(key);
		const existed = this.#store.has(nsKey);
		this.#store.delete(nsKey);
		this.#expirations.delete(nsKey);
		return existed;
	}

	/** @inheritdoc */
	override async exists(key: string): Promise<boolean> {
		this._assertInitialized();
		const nsKey = this._withNs(key);
		if (this.#isExpired(nsKey)) return false;
		return this.#store.has(nsKey);
	}

	/** @inheritdoc */
	override keys(pattern: string): Promise<string[]> {
		this._assertInitialized();
		const all = Array.from(this.#store.keys())
			.filter((key) => !this.#isExpired(key))
			.map((k) => (this.namespace ? k.slice(this.namespace.length) : k))
			.toSorted();

		if (pattern === "*") return Promise.resolve(all);

		const regex = this._globToRegex(pattern);
		return Promise.resolve(all.filter((key) => regex.test(key)));
	}

	/** @inheritdoc */
	override async *keysIter(pattern: string): AsyncIterable<string> {
		const all = await this.keys(pattern);
		for (const k of all) yield k;
	}

	/** @inheritdoc */
	override async clear(pattern: string): Promise<number> {
		this._assertInitialized();
		const keysToDelete = await this.keys(pattern);
		let deleteCount = 0;

		for (const key of keysToDelete) {
			const nsKey = this.namespace + key;
			this.#store.delete(nsKey);
			this.#expirations.delete(nsKey);
			deleteCount++;
		}

		return deleteCount;
	}

	/** @inheritdoc */
	override async setMultiple(
		entries: readonly SetMultipleEntry[],
		options: Partial<SetOptions> = {}
	): Promise<boolean[]> {
		this._assertInitialized();
		const normalized = this._normalizePairs(entries);
		const results: boolean[] = [];

		for (const { key, value, ttl } of normalized) {
			const opts = ttl !== undefined ? { ...options, ttl } : options;
			await this.set(key, value, opts);
			results.push(true);
		}

		return results;
	}

	/** @inheritdoc */
	override async getMultiple(keys: string[]): Promise<Record<string, any>> {
		this._assertInitialized();
		const result: Record<string, any> = {};

		for (const key of keys) {
			result[key] = await this.get(key);
		}

		return result;
	}

	/** @inheritdoc */
	override async expire(key: string, ttl: number): Promise<boolean> {
		this._assertInitialized();
		const nsKey = this._withNs(key);

		if (!this.#store.has(nsKey) || this.#isExpired(nsKey)) {
			return false;
		}

		this.#expirations.set(nsKey, new Date(Date.now() + ttl * 1000));
		return true;
	}

	/** @inheritdoc */
	override async ttl(key: string): Promise<TtlResult> {
		this._assertInitialized();
		const nsKey = this._withNs(key);

		if (!this.#store.has(nsKey)) return { state: "missing" };
		if (this.#isExpired(nsKey)) return { state: "missing" };

		const expiresAt = this.#expirations.get(nsKey);
		if (!expiresAt) return { state: "no-ttl" };
		return { state: "expires", at: expiresAt };
	}

	/** @inheritdoc */
	override async transaction(operations: Operation[]): Promise<any[]> {
		this._assertInitialized();
		// note: memory operations are atomic by nature
		const results = [];

		for (const op of operations) {
			switch (op.type) {
				case "set":
					results.push(await this.set(op.key, op.value, op.options || {}));
					break;
				case "get":
					results.push(await this.get(op.key));
					break;
				case "delete":
					results.push(await this.delete(op.key));
					break;
			}
		}

		return results;
	}

	override async __debug_dump(): Promise<
		Record<string, { value: unknown; ttl: Date | null }>
	> {
		this._assertInitialized();
		const out: Record<string, { value: unknown; ttl: Date | null }> = {};
		for (let k of this.#store.keys()) {
			// need to strip the namespace from the key
			if (this.namespace) k = k.slice(this.namespace.length);

			const t = await this.ttl(k);
			out[k] = {
				value: await this.get(k),
				ttl: t.state === "expires" ? t.at : null,
			};
		}

		return Promise.resolve(out);
	}
}
