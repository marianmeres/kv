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
	type SetMultipleEntry,
	type SetOptions,
	type TtlResult,
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
		validateKeys: true,
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

	#errorListener: ((err: unknown) => void) | undefined;
	#listenerDb: any | undefined;
	#weOpened = false;

	/** @inheritdoc */
	override async initialize(): Promise<void> {
		const { db, logger } = this.options;

		// avoid stacking listeners across repeated initialize() calls
		// (also handles a hot-swapped db instance, though not a documented path)
		if (this.#errorListener && this.#listenerDb) {
			this.#listenerDb.off?.("error", this.#errorListener);
		}
		this.#errorListener = (err) => logger?.error?.(err);
		this.#listenerDb = db;
		db.on("error", this.#errorListener);

		// the pool instance doesn't have connect, so being defensive...
		if (!db.isOpen) {
			await db?.connect();
			this.#weOpened = true;
		}

		this._initialized = true;
	}

	/** @inheritdoc */
	override async destroy(_hard?: boolean): Promise<void> {
		this._initialized = false;
		const { db } = this.options;

		if (this.#errorListener && this.#listenerDb) {
			this.#listenerDb.off?.("error", this.#errorListener);
			this.#errorListener = undefined;
			this.#listenerDb = undefined;
		}

		// Only close a connection we opened ourselves — if the caller opened the
		// client before passing it in, they own the lifecycle. `quit` is the
		// graceful path; it is missing on the pool, so be defensive.
		if (this.#weOpened && db?.isOpen) {
			const quit = (db as any).quit ?? (db as any).close;
			if (typeof quit === "function") {
				try {
					await quit.call(db);
				} catch {
					// ignore — caller may have already closed it
				}
			}
			this.#weOpened = false;
		}
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
		const ttl = this._resolveTtl(options);

		if (value === undefined) value = null; // redis does not accept undefined
		value = JSON.stringify(value);

		const r = await db.set(key, value, ttl ? { EX: ttl } : {});

		return r === "OK";
	}

	/** @inheritdoc */
	override async setIfAbsent(
		key: string,
		value: any,
		options: Partial<SetOptions> = {}
	): Promise<boolean> {
		this._assertInitialized();
		key = this._withNs(key);
		const { db } = this.options;
		const ttl = this._resolveTtl(options);

		if (value === undefined) value = null;
		const serialized = JSON.stringify(value);

		const setOptions: any = { NX: true };
		if (ttl) setOptions.EX = ttl;

		const r = await db.set(key, serialized, setOptions);
		return r === "OK";
	}

	// Lua: GET prev, SET new (optionally EX). Returns previous value (nil = missing).
	#GET_SET_SCRIPT = `
local prev = redis.call('GET', KEYS[1])
if ARGV[2] == '0' then
  redis.call('SET', KEYS[1], ARGV[1])
else
  redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[2]))
end
return prev
`;

	/** @inheritdoc */
	override async getSet(
		key: string,
		value: any,
		options: Partial<SetOptions> = {}
	): Promise<any> {
		this._assertInitialized();
		const nsKey = this._withNs(key);
		const { db } = this.options;
		const ttl = this._resolveTtl(options);

		if (value === undefined) value = null;
		const serialized = JSON.stringify(value);

		const prev = await (db as any).eval(this.#GET_SET_SCRIPT, {
			keys: [nsKey],
			arguments: [serialized, String(ttl ?? 0)],
		});

		if (prev === null || prev === undefined) return null;
		try {
			return JSON.parse(`${prev}`);
		} catch {
			return prev;
		}
	}

	// Lua: conditional EXPIRE only when the key is newly created by INCRBY.
	#INCR_SCRIPT = `
local existed = redis.call('EXISTS', KEYS[1]) == 1
if not existed then
  redis.call('SET', KEYS[1], '0')
end
local v = redis.call('INCRBY', KEYS[1], ARGV[1])
if not existed and tonumber(ARGV[2]) > 0 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
end
return v
`;

	async #incrBy(
		key: string,
		delta: number,
		options: Partial<SetOptions> = {}
	): Promise<number> {
		this._assertInitialized();
		const nsKey = this._withNs(key);
		const { db } = this.options;
		const ttl = this._resolveTtl(options);

		// Validate *before* the INCRBY: if the key holds a JSON non-number
		// (e.g. `"foo"`), INCRBY would reject with "not an integer" anyway,
		// but a stored JSON number like `1` is `"1"` in Redis — compatible.
		// Booleans / objects get rejected downstream with a Redis error.
		try {
			const result = await (db as any).eval(this.#INCR_SCRIPT, {
				keys: [nsKey],
				arguments: [String(delta), String(ttl ?? 0)],
			});
			return Number(result);
		} catch (err: any) {
			const msg = `${err?.message ?? err}`;
			if (/not an integer|is not a number/i.test(msg)) {
				throw new TypeError("KV value is not a number");
			}
			throw err;
		}
	}

	/** @inheritdoc */
	override incr(
		key: string,
		by = 1,
		options: Partial<SetOptions> = {}
	): Promise<number> {
		return this.#incrBy(key, by, options);
	}

	/** @inheritdoc */
	override decr(
		key: string,
		by = 1,
		options: Partial<SetOptions> = {}
	): Promise<number> {
		return this.#incrBy(key, -by, options);
	}

	// Lua: compare current (stringified) value to expected; swap on match.
	// Returns 1 on swap, 0 otherwise. Missing key → 0 (GET returns nil which
	// never equals a non-empty expected string).
	#CAS_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current == ARGV[1] then
  if ARGV[3] == '0' then
    redis.call('SET', KEYS[1], ARGV[2])
  else
    redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[3]))
  end
  return 1
end
return 0
`;

	/** @inheritdoc */
	override async cas(
		key: string,
		expected: any,
		next: any,
		options: Partial<SetOptions> = {}
	): Promise<boolean> {
		this._assertInitialized();
		const nsKey = this._withNs(key);
		const { db } = this.options;
		const ttl = this._resolveTtl(options);

		if (next === undefined) next = null;
		const expectedSerialized = JSON.stringify(
			expected === undefined ? null : expected
		);
		const nextSerialized = JSON.stringify(next);

		const r = await (db as any).eval(this.#CAS_SCRIPT, {
			keys: [nsKey],
			arguments: [expectedSerialized, nextSerialized, String(ttl ?? 0)],
		});
		return Number(r) === 1;
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
		const { isCluster } = this.options;
		if (isCluster) {
			throw new Error("keys() is not supported in Redis Cluster mode");
		}

		const out: string[] = [];
		for await (const k of this.keysIter(pattern)) out.push(k);
		return out.toSorted();
	}

	/** @inheritdoc */
	override async *keysIter(pattern: string): AsyncIterable<string> {
		this._assertInitialized();
		const { db, isCluster } = this.options;
		if (isCluster) {
			throw new Error("keysIter() is not supported in Redis Cluster mode");
		}
		const fullPattern = this.namespace + pattern;
		let cursor = "0";
		do {
			const result = await db.scan(cursor, {
				MATCH: fullPattern,
				COUNT: 100,
			});
			cursor = `${result.cursor}`;
			for (const k of result.keys) {
				yield this._withoutNs(String(k));
			}
		} while (cursor !== "0");
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
		entries: readonly SetMultipleEntry[],
		options: Partial<SetOptions> = {}
	): Promise<boolean[]> {
		this._assertInitialized();

		const { db } = this.options;
		const normalized = this._normalizePairs(entries);
		const pipeline = db.multi();

		for (const { key, value, ttl: pairTtl } of normalized) {
			const ttl = this._resolveTtl({ ttl: pairTtl ?? options.ttl });
			pipeline.set(
				this._withNs(key),
				JSON.stringify(value === undefined ? null : value),
				ttl ? { EX: ttl } : {}
			);
		}

		const res = await pipeline.exec();
		return res.map((v) => String(v) === "OK");
	}

	/** @inheritdoc */
	override async getMultiple(keys: string[]): Promise<Record<string, any>> {
		this._assertInitialized();
		const { db } = this.options;

		const nsKeys = keys.map((k) => this._withNs(k));
		const values = await db.mGet(nsKeys);
		const result: Record<string, any> = {};

		keys.forEach((origKey, index) => {
			const value = values[index];
			if (value !== null) {
				try {
					result[origKey] = JSON.parse(`${value}`);
				} catch (_err) {
					result[origKey] = value;
				}
			} else {
				result[origKey] = null;
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
	override async ttl(key: string): Promise<TtlResult> {
		this._assertInitialized();
		key = this._withNs(key);
		const ttl = await this.options.db.ttl(key);

		// Key doesn't exist
		if (ttl === -2) return { state: "missing" };

		// No expiration set
		if (ttl === -1) return { state: "no-ttl" };

		// Positive number: TTL in seconds remaining
		return {
			state: "expires",
			at: new Date(Date.now() + parseInt(`${ttl}`) * 1_000),
		};
	}

	/** @inheritdoc */
	override async transaction(operations: Operation[]): Promise<any[]> {
		this._assertInitialized();
		const { db } = this.options;

		const multi = db.multi();

		for (const op of operations) {
			const key = this._withNs(op.key);
			switch (op.type) {
				case "set": {
					const ttl = this._resolveTtl(op.options);
					const val = op.value === undefined ? null : op.value;
					multi.set(key, JSON.stringify(val), ttl ? { EX: ttl } : {});
					break;
				}
				case "get":
					multi.get(key);
					break;
				case "delete":
					multi.del(key);
					break;
			}
		}

		const res = (await multi.exec()) as unknown[];

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
		Record<string, { value: any; ttl: Date | null }>
	> {
		this._assertInitialized();
		const { db } = this.options;

		// SCAN scoped to this namespace — do not touch foreign tenants
		const match = this.namespace + "*";
		const nsKeys: string[] = [];
		let cursor = "0";
		do {
			const r = await db.scan(cursor, { MATCH: match, COUNT: 500 });
			cursor = `${r.cursor}`;
			nsKeys.push(...r.keys.map((k: unknown) => String(k)));
		} while (cursor !== "0");

		const keys = nsKeys.map((k) => this._withoutNs(k)).toSorted();
		const out: Record<string, { value: unknown; ttl: Date | null }> = {};
		for (const key of keys) {
			const t = await this.ttl(key);
			out[key] = {
				value: await this.get(key),
				ttl: t.state === "expires" ? t.at : null,
			};
		}

		return out;
	}
}
