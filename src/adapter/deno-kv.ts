/**
 * @module
 *
 * Deno KV key-value storage adapter implementation.
 */

import { createClog } from "@marianmeres/clog";
import {
	AdapterAbstract,
	KvRaceError,
	type Operation,
	type SetMultipleEntry,
	type SetOptions,
	type TtlResult,
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

	/**
	 * When `true`, `delete()` pre-checks the key's existence and returns
	 * the real "did it exist?" flag — at the cost of one extra round-trip.
	 * Default `false` preserves the Deno.Kv native "always true" behavior.
	 */
	strictDeleteResult?: boolean;

	/**
	 * Max retry attempts for CAS-based primitives (`incr`, `decr`, `getSet`,
	 * `cas`) before throwing `KvRaceError`. Each attempt waits a small
	 * exponential-backoff delay, so 20 retries covers substantial contention
	 * without blocking callers for long.
	 * @default 20
	 */
	atomicRetryAttempts?: number;
}

/**
 * Deno KV key-value storage adapter.
 *
 * Provides persistent key-value storage using Deno's built-in KV store.
 * Only available when running in the Deno runtime.
 *
 * @remarks
 * - Only works in Deno runtime (will throw error in Node.js)
 * - `delete()` returns `true` by default even for missing keys (Deno.Kv
 *   limitation); opt in to strict behavior via `strictDeleteResult: true`
 * - `expire()` is not supported — always returns `false`
 * - `ttl()` returns `{ state: "no-ttl" }` for present keys (TTL cannot be
 *   queried) and `{ state: "missing" }` for absent ones
 * - Uses `getMany()` for efficient batch reads
 * - Atomic primitives (`incr`, `decr`, `getSet`, `cas`) use a CAS retry loop
 *   backed by Deno.Kv's native `atomic().check()`
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
		validateKeys: true,
		strictDeleteResult: false,
		atomicRetryAttempts: 20,
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

	#denoKvKey(key: string, full = true): string[] {
		// validate via base (no-op if validateKeys is false)
		if (full) this._withNs(key);
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
		const ttl = this._resolveTtl(options);

		if (value === undefined) value = null;
		const serialized = JSON.stringify(value);

		await db.set(this.#denoKvKey(key), serialized, {
			expireIn: ttl ? ttl * 1000 : undefined,
		});
		return true;
	}

	/** @inheritdoc */
	override async setIfAbsent(
		key: string,
		value: any,
		options: Partial<SetOptions> = {}
	): Promise<boolean> {
		this._assertInitialized();
		const { db } = this.options;
		const ttl = this._resolveTtl(options);

		if (value === undefined) value = null;
		const serialized = JSON.stringify(value);

		const kvKey = this.#denoKvKey(key);
		const res = await db
			.atomic()
			.check({ key: kvKey, versionstamp: null })
			.set(kvKey, serialized, { expireIn: ttl ? ttl * 1000 : undefined })
			.commit();
		return !!res?.ok;
	}

	/** Parses a Deno.Kv entry's stored value back to its JSON form. */
	#parseValue(row: { value?: string | null | undefined }) {
		try {
			return JSON.parse(`${row?.value ?? null}`);
		} catch (_err) {
			return row?.value;
		}
	}

	/**
	 * Runs a CAS-style update. The `mutate` fn takes the current value
	 * (or `undefined` when missing) and returns `{ next, ttlMs?, result }`.
	 * Retries on atomic-commit contention; throws `KvRaceError` on exhaustion.
	 */
	async #atomicUpdate<R>(
		key: string,
		mutate: (current: any, exists: boolean) =>
			| { next: any; expireInMs?: number | undefined; result: R }
			| { abort: true; result: R }
	): Promise<R> {
		const { db, atomicRetryAttempts = 20 } = this.options;
		const kvKey = this.#denoKvKey(key);
		for (let attempt = 0; attempt < atomicRetryAttempts; attempt++) {
			const entry = await db.get(kvKey);
			const exists =
				entry?.versionstamp !== null && entry?.versionstamp !== undefined;
			const current = exists ? this.#parseValue(entry) : undefined;

			const decision = mutate(current, exists);
			if ("abort" in decision) return decision.result;

			const nextSerialized = JSON.stringify(
				decision.next === undefined ? null : decision.next
			);
			const atomic = db.atomic();
			atomic.check({
				key: kvKey,
				versionstamp: exists ? entry.versionstamp : null,
			});
			atomic.set(kvKey, nextSerialized, { expireIn: decision.expireInMs });
			const res = await atomic.commit();
			if (res?.ok) return decision.result;

			// Exponential backoff with jitter, capped at 50ms. Minimal blocking,
			// enough to break symmetric contention between many parallel callers.
			const backoffMs =
				Math.min(50, 2 ** Math.min(attempt, 6)) * (0.5 + Math.random());
			await new Promise((r) => setTimeout(r, backoffMs));
		}
		throw new KvRaceError(
			`Deno.Kv atomic update retries exhausted (${atomicRetryAttempts}) for key "${key}"`
		);
	}

	/** @inheritdoc */
	override async getSet(
		key: string,
		value: any,
		options: Partial<SetOptions> = {}
	): Promise<any> {
		this._assertInitialized();
		const ttl = this._resolveTtl(options);
		const expireInMs = ttl ? ttl * 1000 : undefined;
		const next = value === undefined ? null : value;

		return this.#atomicUpdate(key, (current) => ({
			next,
			expireInMs,
			result: current === undefined ? null : current,
		}));
	}

	async #incrBy(
		key: string,
		delta: number,
		options: Partial<SetOptions> = {}
	): Promise<number> {
		this._assertInitialized();
		const ttl = this._resolveTtl(options);
		const expireInMs = ttl ? ttl * 1000 : undefined;

		return this.#atomicUpdate(key, (current, exists) => {
			let base = 0;
			if (exists) {
				if (typeof current !== "number") {
					throw new TypeError("KV value is not a number");
				}
				base = current;
			}
			const next = base + delta;
			return {
				next,
				// Only apply TTL on key creation; preserving TTL on existing
				// keys is not natively possible in Deno.Kv (every atomic set
				// resets expireIn), so we skip expireIn when the key existed.
				expireInMs: exists ? undefined : expireInMs,
				result: next,
			};
		});
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

	/** @inheritdoc */
	override async cas(
		key: string,
		expected: any,
		next: any,
		options: Partial<SetOptions> = {}
	): Promise<boolean> {
		this._assertInitialized();
		const hasTtl = options.ttl !== undefined;
		const ttl = hasTtl ? this._resolveTtl(options) : undefined;
		const expireInMs = ttl ? ttl * 1000 : undefined;

		const expectedCanonical = JSON.stringify(expected ?? null);

		return this.#atomicUpdate(key, (current, exists) => {
			if (!exists) return { abort: true as const, result: false };
			if (JSON.stringify(current ?? null) !== expectedCanonical) {
				return { abort: true as const, result: false };
			}
			return {
				next: next === undefined ? null : next,
				// When no TTL option is provided, preserve existing TTL. Deno.Kv
				// doesn't let us read/keep it, so this is best-effort: omit
				// `expireIn` and the atomic set clears any existing expiration.
				// Documented limitation — callers who want to preserve TTL must
				// re-supply it.
				expireInMs: hasTtl ? expireInMs : undefined,
				result: true,
			};
		});
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
		const { db } = this.options;
		const entry = await db.get(this.#denoKvKey(key));
		return entry?.versionstamp !== null && entry?.versionstamp !== undefined;
	}

	/** @inheritdoc */
	override async delete(key: string): Promise<boolean> {
		this._assertInitialized();
		const { db, strictDeleteResult } = this.options;
		const kvKey = this.#denoKvKey(key);

		if (strictDeleteResult) {
			const entry = await db.get(kvKey);
			const existed = entry?.versionstamp !== null && entry?.versionstamp !== undefined;
			await db.delete(kvKey);
			return existed;
		}

		await db.delete(kvKey);
		return true;
	}

	/** @inheritdoc */
	override async keys(pattern: string): Promise<string[]> {
		this._assertInitialized();
		const out: string[] = [];
		for await (const k of this.keysIter(pattern)) out.push(k);
		return out.toSorted();
	}

	/** @inheritdoc */
	override async *keysIter(pattern: string): AsyncIterable<string> {
		this._assertInitialized();
		const { db } = this.options;

		const [firstSeg] = this.#denoKvKey(pattern, false);
		const regex = this._globToRegex(pattern);

		// Only use the first key segment as a Deno.Kv prefix if it contains
		// no wildcards — otherwise scan the whole namespace and regex-filter.
		const firstIsLiteral =
			firstSeg !== undefined && firstSeg !== "*" && !/[*?]/.test(firstSeg);

		const listPrefix = firstIsLiteral
			? [this.namespace, firstSeg]
			: [this.namespace];

		for await (const res of db.list({ prefix: listPrefix })) {
			// Iterate entries (Deno.Kv has no keys-only API) but do not touch
			// `res.value` — no JSON parse, no copy.
			const key = res.key.slice(1).join(":");
			if (pattern === "*" || regex.test(key)) {
				yield key;
			}
		}
	}

	/** @inheritdoc */
	override async clear(pattern: string): Promise<number> {
		this._assertInitialized();
		const { db } = this.options;
		let deleteCount = 0;

		// Batch deletes via atomic to reduce round-trips — but Deno.Kv caps
		// atomic operations, so chunk at 500.
		const CHUNK = 500;
		let atomic = db.atomic();
		let inBatch = 0;

		for await (const key of this.keysIter(pattern)) {
			atomic.delete(this.#denoKvKey(key));
			inBatch++;
			deleteCount++;
			if (inBatch >= CHUNK) {
				await atomic.commit();
				atomic = db.atomic();
				inBatch = 0;
			}
		}
		if (inBatch > 0) await atomic.commit();
		return deleteCount;
	}

	/** @inheritdoc */
	override async setMultiple(
		entries: readonly SetMultipleEntry[],
		options: Partial<SetOptions> = {}
	): Promise<boolean[]> {
		this._assertInitialized();
		if (entries.length === 0) return [];

		const normalized = this._normalizePairs(entries);
		const { db } = this.options;

		// Atomic commit for all-or-nothing semantics.
		const atomic = db.atomic();
		for (const { key, value, ttl: pairTtl } of normalized) {
			const ttl = this._resolveTtl({ ttl: pairTtl ?? options.ttl });
			const v = value === undefined ? null : value;
			atomic.set(this.#denoKvKey(key), JSON.stringify(v), {
				expireIn: ttl ? ttl * 1000 : undefined,
			});
		}
		const res = await atomic.commit();
		const ok = !!res?.ok;
		return normalized.map(() => ok);
	}

	/** @inheritdoc */
	override async getMultiple(keys: string[]): Promise<Record<string, any>> {
		this._assertInitialized();
		const { db } = this.options;
		const result: Record<string, any> = {};

		if (keys.length === 0) return result;

		const denoKvKeys = keys.map((k) => this.#denoKvKey(k));
		const results = await db.getMany(denoKvKeys);

		for (const [index, row] of results.entries()) {
			const origKey = keys[index];
			const hasValue = row?.versionstamp !== null && row?.versionstamp !== undefined;
			result[origKey] = hasValue ? this.#parseValue(row) : null;
		}

		return result;
	}

	/** @inheritdoc */
	override async transaction(operations: Operation[]): Promise<any[]> {
		this._assertInitialized();
		const { db } = this.options;

		// When the transaction contains only set/delete ops we can use Deno.Kv's
		// native atomic() for true all-or-nothing semantics. A `get` inside the
		// transaction breaks that — Deno.Kv has no atomic-read — so in that
		// case we fall back to sequential execution.
		const hasGet = operations.some((op) => op.type === "get");

		if (!hasGet && operations.length > 0) {
			const atomic = db.atomic();
			for (const op of operations) {
				if (op.type === "set") {
					const ttl = this._resolveTtl(op.options);
					const v = op.value === undefined ? null : op.value;
					atomic.set(this.#denoKvKey(op.key), JSON.stringify(v), {
						expireIn: ttl ? ttl * 1000 : undefined,
					});
				} else if (op.type === "delete") {
					atomic.delete(this.#denoKvKey(op.key));
				}
			}
			const res = await atomic.commit();
			if (!res?.ok) {
				throw new Error("Deno.Kv atomic transaction failed to commit");
			}
			return operations.map(() => true);
		}

		// Sequential fallback — operations are NOT atomic.
		const results: any[] = [];
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

	/**
	 * Not supported in Deno.Kv — always returns `false`.
	 * @inheritdoc
	 */
	override expire(_key: string, _ttl: number): Promise<boolean> {
		this._assertInitialized();
		return Promise.resolve(false);
	}

	/**
	 * Deno.Kv cannot report TTL state. Returns `{ state: "no-ttl" }` for
	 * existing keys (whether or not they actually have an expireIn set)
	 * and `{ state: "missing" }` for absent keys.
	 */
	override async ttl(key: string): Promise<TtlResult> {
		this._assertInitialized();
		const { db } = this.options;
		const entry = await db.get(this.#denoKvKey(key));
		const exists =
			entry?.versionstamp !== null && entry?.versionstamp !== undefined;
		return exists ? { state: "no-ttl" } : { state: "missing" };
	}
}
