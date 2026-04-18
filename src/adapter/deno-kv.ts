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
		const ttl = this._resolveTtl(options);

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
		const { db } = this.options;
		// Deno.Kv returns an entry with `versionstamp: null` for missing keys,
		// and a non-null versionstamp for present keys — even if the stored value is null.
		const entry = await db.get(this.#denoKvKey(key));
		return entry?.versionstamp !== null && entry?.versionstamp !== undefined;
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

		const [firstSeg] = this.#denoKvKey(pattern, false);
		const regex = this._globToRegex(pattern);

		// Only use the first key segment as a Deno.Kv prefix if it contains
		// no wildcards — otherwise we must scan the whole namespace and rely
		// on regex filtering.
		const firstIsLiteral =
			firstSeg !== undefined && firstSeg !== "*" && !/[*?]/.test(firstSeg);

		const listPrefix = firstIsLiteral
			? [this.namespace, firstSeg]
			: [this.namespace];

		const iter = db.list({ prefix: listPrefix });
		const out: string[] = [];
		for await (const res of iter) {
			// We must iterate entries (Deno.Kv has no keys-only API), but we
			// deliberately do not touch `res.value` — no JSON parse, no copy.
			const key = res.key.slice(1).join(":");
			if (pattern === "*" || regex.test(key)) {
				out.push(key);
			}
		}
		return out.toSorted();
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
		if (keyValuePairs.length === 0) return [];

		const { db } = this.options;
		const ttl = this._resolveTtl(options);
		const expireIn = ttl ? ttl * 1000 : undefined;

		// batch into a single atomic commit (all-or-nothing)
		const atomic = db.atomic();
		for (const [key, value] of keyValuePairs) {
			const v = value === undefined ? null : value;
			atomic.set(this.#denoKvKey(key), JSON.stringify(v), { expireIn });
		}
		const res = await atomic.commit();
		const ok = !!res?.ok;
		return keyValuePairs.map(() => ok);
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
		const { db } = this.options;

		// When the transaction contains only set/delete ops we can use Deno.Kv's
		// native atomic() for true all-or-nothing semantics. A `get` inside the
		// transaction breaks that — Deno.Kv has no atomic-read — so in that case
		// we fall back to sequential execution (consistent with pre-existing
		// behavior).
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
			const ok = !!res?.ok;
			if (!ok) throw new Error("Deno.Kv atomic transaction failed to commit");
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
