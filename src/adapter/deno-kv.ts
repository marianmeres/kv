/**
 * @module
 *
 * Deno KV key-value storage adapter implementation.
 */

import { createClog } from "@marianmeres/clog";
import {
	AdapterAbstract,
	type Operation,
	type SetOptions,
	type AdapterAbstractOptions,
} from "./abstract.ts";

/**
 * Configuration options for the Deno KV adapter.
 */
export interface AdapterDenoKvOptions extends AdapterAbstractOptions {
	/**
	 * Deno.Kv instance obtained via `Deno.openKv()`.
	 * @see https://docs.deno.com/deploy/kv/#testing
	 */
	db: any; // Deno.Kv - using any to avoid type issues in Node.js environments
}

/**
 * Deno KV key-value storage adapter.
 *
 * Provides persistent key-value storage using Deno's built-in KV store.
 * Only available when running in the Deno runtime.
 *
 * @remarks
 * - Only works in Deno runtime (will throw error in Node.js)
 * - `delete()` always returns `true` (Deno.Kv limitation)
 * - `expire()` is not supported - always returns `false`
 * - `ttl()` is not supported - always returns `null`
 * - TTL can be set during `set()` but cannot be queried afterward
 * - Uses `getMany()` for efficient batch reads
 *
 * @example
 * ```typescript
 * const kv = await Deno.openKv();
 * const client = createKVClient("myapp:", "deno-kv", { db: kv });
 * await client.initialize();
 * await client.set("user:123", { name: "John" }, { ttl: 3600 });
 * ```
 */
export class AdapterDenoKv extends AdapterAbstract {
	override _type = "deno-kv";

	override readonly options: AdapterDenoKvOptions = {
		defaultTtl: 0, // no ttl by default
		db: null!, // will be set in constructor via options merge
		logger: createClog("KV/deno-kv"),
	};

	constructor(
		public override readonly namespace: string = "",
		options: Partial<AdapterDenoKvOptions> = {}
	) {
		super();
		this._assertValidNamespace();
		this.options = Object.freeze({ ...this.options, ...(options || {}) });
		if (!this.options.db) {
			throw new Error("Missing Deno.Kv instance");
		}
	}

	/** @inheritdoc */
	override initialize(): Promise<void> {
		this._initialized = true;
		return Promise.resolve();
	}

	/** @inheritdoc */
	override destroy(_hard?: boolean): Promise<void> {
		this._initialized = false;
		return Promise.resolve();
	}

	#denoKvKey(key: string, full = true) {
		const parts = key.split(":");
		const prefix = parts[0];
		const rest = parts.slice(1).join(":");
		let out = [prefix, rest].filter(Boolean);
		if (full) out = [this.namespace, ...out];
		return out;
	}

	/** @inheritdoc */
	override async set(
		key: string,
		value: any,
		options: Partial<SetOptions> = {}
	): Promise<boolean> {
		this._assertInitialized();
		const { db } = this.options;
		const ttl = options.ttl || this.options.defaultTtl || undefined;

		if (value === undefined) value = null;
		// Deno.Kv does not require this, but for the consistency with other adapters
		// let's just stringify (the toJSON may do magic, so we want consistent behavior
		// across adapters)
		value = JSON.stringify(value);

		await db.set(this.#denoKvKey(key), value, {
			expireIn: ttl ? ttl * 1000 : undefined,
		});
		return true;
	}

	/** Will return the internal value */
	#parseValue(row: { value?: string | null | undefined }) {
		try {
			return JSON.parse(`${row?.value ?? null}`);
		} catch (_err) {
			return row?.value;
		}
	}

	/** @inheritdoc */
	override async get(key: string): Promise<any> {
		this._assertInitialized();
		const { db } = this.options;
		const row = await db.get(this.#denoKvKey(key));
		return this.#parseValue(row);
	}

	/** @inheritdoc */
	override async exists(key: string): Promise<boolean> {
		this._assertInitialized();
		return null !== (await this.get(key));
	}

	/** @inheritdoc */
	override async delete(key: string): Promise<boolean> {
		this._assertInitialized();
		const { db } = this.options;
		await db.delete(this.#denoKvKey(key));
		return Promise.resolve(true); // always true
	}

	/** @inheritdoc */
	override async keys(pattern: string): Promise<string[]> {
		this._assertInitialized();
		const { db } = this.options;

		const [prefix, search] = this.#denoKvKey(pattern, false);
		// convert Redis-style pattern to regex
		const regexPattern = pattern.replace(/\*/g, ".*").replace(/\?/g, ".");
		const regex = new RegExp(`^${regexPattern}$`);

		const iter = db.list({
			prefix: [this.namespace, prefix === "*" ? undefined : prefix].filter(
				Boolean
			) as string[],
		});
		const out = [];
		for await (const res of iter) {
			// note: here we have full data available, not just keys, so this is pure waste
			const key = res.key.slice(1).join(":");
			if (prefix === "*" || search === "*" || regex.test(key)) {
				out.push(key);
			}
		}
		return out;
	}

	/** @inheritdoc */
	override async clear(pattern: string): Promise<number> {
		this._assertInitialized();
		const keysToDelete = await this.keys(pattern);
		let deleteCount = 0;

		for (const key of keysToDelete) {
			await this.delete(key);
			deleteCount++;
		}

		return deleteCount;
	}

	/** @inheritdoc */
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

	/** @inheritdoc */
	override async getMultiple(keys: string[]): Promise<Record<string, any>> {
		this._assertInitialized();
		const { db } = this.options;
		const result: Record<string, any> = {};

		const denoKvKeys = keys.map((k) => this.#denoKvKey(k));
		const results = await db.getMany(denoKvKeys);

		for (const [index, row] of results.entries()) {
			result[keys[index]] = this.#parseValue(row);
		}

		return result;
	}

	/** @inheritdoc */
	override async transaction(operations: Operation[]): Promise<any[]> {
		this._assertInitialized();

		// Note: This implementation does not use Deno.Kv's atomic feature
		// Operations are executed sequentially
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

	/**
	 * Not supported in Deno.Kv - always returns `false`.
	 * @inheritdoc
	 */
	override expire(key: string, ttl: number): Promise<boolean> {
		this._assertInitialized();
		return Promise.resolve(false);
	}

	/**
	 * Not supported in Deno.Kv - always returns `null`.
	 * @inheritdoc
	 */
	override ttl(key: string): Promise<Date | null | false> {
		this._assertInitialized();
		return Promise.resolve(null);
	}
}
