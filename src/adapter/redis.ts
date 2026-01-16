/**
 * @module
 *
 * Redis key-value storage adapter implementation.
 */

import type { createClient, createClientPool } from "redis";
import {
	AdapterAbstract,
	type AdapterAbstractOptions,
	type Operation,
	type SetOptions,
} from "./abstract.ts";
import { createClog } from "@marianmeres/clog";

/**
 * Configuration options for the Redis KV adapter.
 */
export interface AdapterRedisOptions extends AdapterAbstractOptions {
	/**
	 * Redis client instance created via `createClient()` or `createClientPool()`.
	 * Pool support is experimental and not fully tested.
	 */
	db: ReturnType<typeof createClient> | ReturnType<typeof createClientPool>;
	/**
	 * Set to `true` if connecting to a Redis Cluster.
	 * Note: `keys()` and `clear()` operations are not supported in cluster mode.
	 */
	isCluster: boolean;
}

/**
 * Redis key-value storage adapter.
 *
 * Provides persistent key-value storage using Redis as the backend.
 * Supports all Redis features including TTL, pipelining, and transactions.
 *
 * @remarks
 * - Namespace is required (cannot be empty)
 * - Uses Redis MULTI for transactions (atomic operations)
 * - Uses pipelining for batch operations (setMultiple)
 * - `keys()` and `clear()` are not supported in cluster mode
 *
 * @example
 * ```typescript
 * import { createClient } from 'redis';
 *
 * const redisClient = createClient({ url: 'redis://localhost:6379' });
 * const client = createKVClient("myapp:", "redis", {
 *   db: redisClient,
 *   defaultTtl: 3600,
 * });
 * await client.initialize();
 * await client.set("session:abc", { userId: 123 });
 * ```
 */
export class AdapterRedis extends AdapterAbstract {
	override _type = "redis";

	override readonly options: AdapterRedisOptions = {
		defaultTtl: 0, // no ttl by default
		logger: createClog("KV/redis"),
		db: null!, // will be set in constructor via options merge
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

	/** @inheritdoc */
	override async initialize(): Promise<void> {
		const { db, logger } = this.options;

		db.on("error", (err) => logger?.error?.(err));

		// the pool instance doesn't have connect, so being defensive...
		if (!db.isOpen) await db?.connect();

		this._initialized = true;
	}

	/** @inheritdoc */
	override destroy(_hard?: boolean): Promise<void> {
		this._initialized = false;
		return Promise.resolve();
	}

	/** @inheritdoc */
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

	/** @inheritdoc */
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

	/** @inheritdoc */
	override async delete(key: string): Promise<boolean> {
		this._assertInitialized();
		key = this._withNs(key);
		const { db } = this.options;
		return Number(await db.del(key)) > 0;
	}

	/** @inheritdoc */
	override async exists(key: string): Promise<boolean> {
		this._assertInitialized();
		key = this._withNs(key);
		const { db } = this.options;
		return (await db.exists(key)) === 1;
	}

	/** @inheritdoc */
	override async keys(pattern: string): Promise<string[]> {
		this._assertInitialized();
		const { db, isCluster } = this.options;

		if (isCluster) {
			throw new Error("keys() is not supported in Redis Cluster mode");
		}

		// Use SCAN instead of KEYS for non-blocking iteration
		const fullPattern = this.namespace + pattern;
		const keys: string[] = [];
		let cursor = "0";

		do {
			const result = await db.scan(cursor, {
				MATCH: fullPattern,
				COUNT: 100,
			});
			cursor = `${result.cursor}`;
			keys.push(...result.keys.map((k) => String(k)));
		} while (cursor !== "0");

		return keys
			.map((k) => {
				// strip namespace if exists
				if (this.namespace) k = k.slice(this.namespace.length);
				return k;
			})
			.toSorted();
	}

	/** @inheritdoc */
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

		// Use UNLINK instead of DEL for non-blocking memory reclamation
		return Number(await db.unlink(keys.map((k) => this._withNs(k))));
	}

	/** @inheritdoc */
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

		return res.map((v) => String(v) === "OK");
	}

	/** @inheritdoc */
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

	/** @inheritdoc */
	override async expire(key: string, ttl: number): Promise<boolean> {
		this._assertInitialized();
		key = this._withNs(key);
		return Number(await this.options.db.expire(key, ttl)) > 0;
	}

	/** @inheritdoc */
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

	/** @inheritdoc */
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

		const res = await multi.exec() as unknown[];

		// fix results types
		for (const [i, op] of operations.entries()) {
			switch (op.type) {
				case "set":
					res[i] = String(res[i]) === "OK";
					break;
				case "get":
					try {
						res[i] = JSON.parse(String(res[i]));
					} catch (_e) {
						/**/
					}
					break;
				case "delete":
					res[i] = Number(res[i]) > 0;
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

		const keys = (await db.keys("*")).toSorted();

		const out: Record<string, { value: unknown; ttl: Date | null | false }> = {};

		for (const _key of keys) {
			const key = this._withoutNs(String(_key));
			out[key] = {
				value: await this.get(key),
				ttl: await this.ttl(key),
			};
		}

		return out;
	}
}
