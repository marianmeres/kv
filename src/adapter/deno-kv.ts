import { createLogger } from "@marianmeres/clog";
import {
	AdapterAbstract,
	type Operation,
	type SetOptions,
	type AdapterAbstractOptions,
} from "./abstract.ts";

export interface AdapterDenoKvOptions extends AdapterAbstractOptions {
	// https://docs.deno.com/deploy/kv/#testing
	db: any; // Deno.Kv;
}

export class AdapterDenoKv extends AdapterAbstract {
	override _type = "deno-kv";

	override readonly options: AdapterDenoKvOptions = {
		defaultTtl: 0, // no ttl by default
		db: null as any,
		logger: createLogger("KV/deno-kv"),
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

	/** Will initialize the client instance */
	initialize(): Promise<void> {
		this._initialized = true;
		return Promise.resolve();
	}

	/** Will destroy (do cleanups) on the instance */
	destroy(_hard?: boolean): Promise<void> {
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

	/** Will set key-value pair to the underlying store with given options */
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

	/** Will get the key from the underlying store */
	override async get(key: string): Promise<any> {
		this._assertInitialized();
		const { db } = this.options;
		const row = await db.get(this.#denoKvKey(key));
		return this.#parseValue(row);
	}

	/** Will check if the key exists in the underlying store */
	override async exists(key: string): Promise<boolean> {
		this._assertInitialized();
		return null !== (await this.get(key));
	}

	/** Will delete the key from the underlying store */
	override async delete(key: string): Promise<boolean> {
		this._assertInitialized();
		const { db } = this.options;
		await db.delete(this.#denoKvKey(key));
		return Promise.resolve(true); // always true
	}

	/** Will list all existing keys in the underlying store matching given pattern.
	 * Recognizes redis-like star wildcard format. */
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

	/** Will clear all existing keys in the underlying store matching given pattern */
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

	/** Will get multiple keys in one batch. */
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

	/**  */
	override async transaction(operations: Operation[]): Promise<any[]> {
		this._assertInitialized();
		const { db } = this.options;

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

	/** Not supported in Deno.Kv */
	override expire(key: string, ttl: number): Promise<boolean> {
		this._assertInitialized();
		return Promise.resolve(false);
	}

	/** NOT SUPPORTED IN DENO KV... Will get the expiration Date for given key */
	override async ttl(key: string): Promise<Date | null | false> {
		this._assertInitialized();
		//
		return Promise.resolve(null);
	}
}
