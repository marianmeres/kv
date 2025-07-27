import { createLogger } from "@marianmeres/clog";
import {
	AdapterAbstract,
	type AdapterAbstractOptions,
	type Operation,
	type SetOptions,
} from "./abstract.ts";

export interface AdapterMemoryOptions extends AdapterAbstractOptions {
	/** Set 0 to disable */
	ttlCleanupIntervalSec: number;
}

export class AdapterMemory extends AdapterAbstract {
	override _type = "memory";

	override readonly options: AdapterMemoryOptions = {
		defaultTtl: 0, // no ttl by default
		ttlCleanupIntervalSec: 0,
		logger: createLogger("KV/memory"),
	};

	#store = new Map<string, any>();
	#expirations = new Map<string, Date>();
	#cleanupTimer: any;

	constructor(
		public override readonly namespace: string = "",
		options: Partial<AdapterMemoryOptions> = {}
	) {
		super();
		this.options = { ...this.options, ...(options || {}) };
		this._assertValidNamespace();
	}

	/** Will initialize the client instance */
	initialize(): Promise<void> {
		this._initialized = true;
		this.#maybeTTLCleanup();
		return Promise.resolve(); // memory is always "connected"
	}

	/** Will destroy (do cleanups) on the instance */
	destroy(_hard?: boolean): Promise<void> {
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

	/** Will set key-value pair to the underlying store with given options */
	override set(
		key: string,
		value: any,
		options: Partial<SetOptions> = {}
	): Promise<boolean> {
		this._assertInitialized();
		key = this._withNs(key);

		// to be consistent across adapters, keeping internally the strigified version...
		this.#store.set(key, JSON.stringify(value));

		const ttl = options.ttl || this.options.defaultTtl;
		if (ttl) {
			this.#expirations.set(key, new Date(Date.now() + ttl * 1_000));
		} else {
			this.#expirations.delete(key);
		}

		return Promise.resolve(true);
	}

	/** Will get the key from the underlying store */
	override get(key: string): Promise<any> {
		this._assertInitialized();
		key = this._withNs(key);

		if (this.#isExpired(key)) return Promise.resolve(null);

		const value = this.#store.get(key);

		// NOTE: even if the saved value was `undefined` it is always returned as `null`
		if (value === undefined) return Promise.resolve(null);

		return JSON.parse(value);
	}

	/** Will delete the key from the underlying store */
	override delete(key: string): Promise<boolean> {
		this._assertInitialized();
		key = this._withNs(key);
		const existed = this.#store.has(key);
		this.#store.delete(key);
		this.#expirations.delete(key);
		return Promise.resolve(existed);
	}

	/** Will check if the key exists in the underlying store */
	override exists(key: string): Promise<boolean> {
		this._assertInitialized();
		key = this._withNs(key);
		if (this.#isExpired(key)) return Promise.resolve(false);
		return Promise.resolve(this.#store.has(key));
	}

	/** Will list all existing keys in the underlying store matching given pattern.
	 * Recognizes redis-like star wildcard format. */
	override keys(pattern: string): Promise<string[]> {
		this._assertInitialized();
		const all = Array.from(this.#store.keys())
			.filter((key) => !this.#isExpired(key))
			.map((k) => {
				// strip namespace if exists
				if (this.namespace) k = k.slice(this.namespace.length);
				return k;
			})
			.toSorted();

		if (pattern === "*") return Promise.resolve(all);

		// convert Redis-style pattern to regex
		const regexPattern = pattern.replace(/\*/g, ".*").replace(/\?/g, ".");
		const regex = new RegExp(`^${regexPattern}$`);

		return Promise.resolve(all.filter((key) => regex.test(key)));
	}

	/** Will clear all existing keys in the underlying store matching given pattern */
	override async clear(pattern: string): Promise<number> {
		this._assertInitialized();
		const keysToDelete = await this.keys(pattern);
		let deleteCount = 0;

		for (let key of keysToDelete) {
			key = this._withNs(key);
			this.#store.delete(key);
			this.#expirations.delete(key);
			deleteCount++;
		}

		return deleteCount;
	}

	/** Will set multiple kv pairs in one batch */
	override async setMultiple(
		keyValuePairs: [string, any][],
		options: Partial<SetOptions> = {}
	): Promise<boolean[]> {
		this._assertInitialized();
		const results = [];

		for (const [key, value] of keyValuePairs) {
			await this.set(key, value, options);
			results.push(true);
		}

		return results;
	}

	/** Will get multiple keys in one batch */
	override async getMultiple(keys: string[]): Promise<Record<string, any>> {
		this._assertInitialized();
		const result: Record<string, any> = {};

		for (const key of keys) {
			result[key] = await this.get(key);
		}

		return result;
	}

	/** Will set the expiration ttl on the given key to given ttl value */
	override expire(key: string, ttl: number): Promise<boolean> {
		this._assertInitialized();
		key = this._withNs(key);

		if (!this.#store.has(key) || this.#isExpired(key)) {
			return Promise.resolve(false);
		}

		this.#expirations.set(key, new Date(Date.now() + ttl * 1000));
		return Promise.resolve(true);
	}

	/** Will get the expiration Date for given key */
	override ttl(key: string): Promise<Date | null | false> {
		this._assertInitialized();
		key = this._withNs(key);

		// Key doesn't exist
		if (!this.#store.has(key)) return Promise.resolve(false);

		// Key expired (and was cleaned up)
		if (this.#isExpired(key)) return Promise.resolve(false);

		const expiresAt = this.#expirations.get(key);
		// No expiration set
		if (!expiresAt) return Promise.resolve(null);

		return Promise.resolve(expiresAt);
		// const remaining = Math.max(0, expiresAt.valueOf() - Date.now());
		// return Promise.resolve(new Date(Date.now() + Math.ceil(remaining)));
	}

	/**  */
	override async transaction(operations: Operation[]): Promise<any[]> {
		this._assertInitialized();
		// note: memory operations are atomic by nature
		const results = [];

		try {
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
		} catch (err) {
			// rollback here in a real db-based adapter
			throw err;
		}

		return results;
	}

	override async __debug_dump(): Promise<
		Record<string, { value: any; ttl: Date | null | false }>
	> {
		this._assertInitialized();
		const out: Record<string, { value: any; ttl: Date | null | false }> = {};
		for (let k of this.#store.keys()) {
			// need to strip the namespace from the key
			if (this.namespace) k = k.slice(this.namespace.length);

			out[k] = {
				value: await this.get(k),
				ttl: await this.ttl(k),
			};
		}

		return Promise.resolve(out);
	}
}
