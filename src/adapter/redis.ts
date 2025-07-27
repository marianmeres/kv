import type { createClient, createClientPool } from "redis";
import {
	AdapterAbstract,
	type AdapterAbstractOptions,
	type Operation,
	type SetOptions,
} from "./abstract.ts";
import { createLogger } from "@marianmeres/clog";

export interface AdapterRedisOptions extends AdapterAbstractOptions {
	db: ReturnType<typeof createClient> | ReturnType<typeof createClientPool>;
	isCluster: boolean;
}

export class AdapterRedis extends AdapterAbstract {
	override _type = "redis";

	override readonly options: AdapterRedisOptions = {
		defaultTtl: 0, // no ttl by default
		logger: createLogger("KV/redis"),
		db: null as any,
		isCluster: false,
	};

	constructor(
		public override readonly namespace: string = "",
		options: Partial<AdapterRedisOptions> = {}
	) {
		super();
		if (!this.namespace) {
			throw new Error(`Missing namespace (required in RedisAdapter)`);
		}
		this._assertValidNamespace();
		this.options = Object.freeze({ ...this.options, ...(options || {}) });
		if (!this.options.db) {
			throw new Error("Missing redis db client instance");
		}
	}

	async initialize(): Promise<void> {
		const { db, logger } = this.options;

		db.on("error", (err) => logger?.error?.(err));

		// the pool instance doesn't have connect, so being defensive...
		if (!db.isOpen) await db?.connect();

		this._initialized = true;
	}

	destroy(_hard?: boolean): Promise<void> {
		this._initialized = false;
		return Promise.resolve();
	}

	/** Will set key-value pair to the underlying store with given options */
	override async set(
		key: string,
		value: any,
		options: Partial<SetOptions> = {}
	): Promise<boolean> {
		this._assertInitialized();
		key = this._withNs(key);

		const { db } = this.options;
		const ttl = options.ttl || this.options.defaultTtl || undefined;

		if (value === undefined) value = null; // redis does not accept undefined
		value = JSON.stringify(value);

		const r = await db.set(key, value, { EX: ttl });

		return r === "OK";
	}

	/** Will get the key from the underlying store */
	override async get(key: string): Promise<any> {
		this._assertInitialized();
		key = this._withNs(key);

		const { db } = this.options;
		const value = await db.get(key);

		if (value === null) return null;

		try {
			return JSON.parse(`${value}`);
		} catch (_err) {
			return value;
		}
	}

	/** Will delete the key from the underlying store */
	override async delete(key: string): Promise<boolean> {
		this._assertInitialized();
		key = this._withNs(key);
		const { db } = this.options;
		return parseInt((await db.del(key)) as any) > 0;
	}

	/** Will check if the key exists in the underlying store */
	override async exists(key: string): Promise<boolean> {
		this._assertInitialized();
		key = this._withNs(key);
		const { db } = this.options;
		return (await db.exists(key)) === 1;
	}

	/** Will list all existing keys in the underlying store matching given pattern.
	 * Recognizes redis-like star wildcard format. */
	override async keys(pattern: string): Promise<string[]> {
		this._assertInitialized();
		const { db, isCluster } = this.options;

		if (isCluster) {
			throw new Error("KEYS command not supported in Redis Cluster mode");
		}

		const keys: string[] = (await db.keys(this.namespace + pattern)) as any;

		return keys
			.map((k) => {
				// strip namespace if exists
				if (this.namespace) k = k.slice(this.namespace.length);
				return k;
			})
			.toSorted();
	}

	/** Will clear all existing keys in the underlying store matching given pattern */
	override async clear(pattern: string): Promise<number> {
		this._assertInitialized();
		const { db, isCluster } = this.options;

		if (isCluster) {
			throw new Error(
				"Pattern-based clear is not supported in Redis Cluster mode"
			);
		}

		const keys: string[] = await this.keys(pattern);

		if (keys.length === 0) return 0;

		return parseInt((await db.del(keys.map((k) => this._withNs(k)))) as any);
	}

	/** Will set multiple kv pairs in one batch */
	override async setMultiple(
		keyValuePairs: [string, any][],
		options: Partial<SetOptions> = {}
	): Promise<boolean[]> {
		this._assertInitialized();

		const { db } = this.options;
		const ttl = options.ttl || this.options.defaultTtl || undefined;
		const pipeline = db.multi();

		for (let [key, value] of keyValuePairs) {
			key = this._withNs(key);
			pipeline.set(key, JSON.stringify(value), { EX: ttl });
		}

		const res = await pipeline.exec();

		return res.map((v: any) => v === "OK");
	}

	/** Will get multiple keys in one batch */
	override async getMultiple(keys: string[]): Promise<Record<string, any>> {
		this._assertInitialized();
		const { db } = this.options;

		keys = keys.map((k) => this._withNs(k));
		const values = await db.mGet(keys);
		const result: Record<string, any> = {};

		keys.forEach((key, index) => {
			key = this._withoutNs(key);
			const value = values[index];
			if (value !== null) {
				try {
					result[key] = JSON.parse(`${value}`);
				} catch (_err) {
					result[key] = value;
				}
			} else {
				result[key] = null;
			}
		});

		return result;
	}

	/** Will set the expiration ttl on the given key to given ttl value */
	override async expire(key: string, ttl: number): Promise<boolean> {
		this._assertInitialized();
		key = this._withNs(key);
		return parseInt((await this.options.db.expire(key, ttl)) as any) > 0;
	}

	/** Will get the expiration Date for given key */
	override async ttl(key: string): Promise<Date | null | false> {
		this._assertInitialized();
		key = this._withNs(key);
		const ttl = await this.options.db.ttl(key);

		// Key doesn't exist
		if (ttl === -2) return false;

		// No expiration set
		if (ttl === -1) return null;

		// Positive number: TTL in seconds remaining
		return new Date(Date.now() + parseInt(`${ttl}`) * 1_000);
	}

	/**  */
	override async transaction(operations: Operation[]): Promise<any[]> {
		this._assertInitialized();
		const { db } = this.options;

		const multi = db.multi();

		for (const op of operations) {
			const key = this._withNs(op.key);
			switch (op.type) {
				case "set":
					multi.set(key, JSON.stringify(op.value));
					break;
				case "get":
					multi.get(key);
					break;
				case "delete":
					multi.del(key);
					break;
			}
		}

		const res: any = await multi.exec();

		// fix results types
		for (const [i, op] of operations.entries()) {
			switch (op.type) {
				case "set":
					res[i] = res[i] === "OK";
					break;
				case "get":
					try {
						res[i] = JSON.parse(res[i]);
					} catch (_e) {
						/**/
					}
					break;
				case "delete":
					res[i] = res[i] > 0;
					break;
			}
		}

		return res;
	}

	// this is not optimal quick-n-dirty implementation
	// DO NOT USE for production data
	override async __debug_dump(): Promise<
		Record<string, { value: any; ttl: Date | null | false }>
	> {
		this._assertInitialized();
		const { db } = this.options;

		const keys: string[] = ((await db.keys("*")) as any).toSorted();

		const out = {} as any;

		for (const _key of keys) {
			const key = this._withoutNs(_key);
			out[key] = {
				value: await this.get(key),
				ttl: await this.ttl(key),
			};
		}

		return out;
	}
}
