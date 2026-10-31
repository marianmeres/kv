/**
 * @module
 *
 * SQLite key-value storage adapter implementation (`node:sqlite`).
 */

import type { DatabaseSync, StatementSync } from "node:sqlite";
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
 * Configuration options for the SQLite KV adapter.
 */
export interface AdapterSqliteOptions extends AdapterAbstractOptions {
	/**
	 * An open `node:sqlite` database, e.g. `new DatabaseSync("kv.db")`. The caller owns
	 * it: `destroy()` never closes it, so one handle can be shared across adapters.
	 */
	db: DatabaseSync;
	/**
	 * Name of the table to use for storing key-value pairs.
	 * The table will be created automatically if it doesn't exist.
	 * Only word characters are allowed (no `schema.` prefix).
	 * @default "__kv"
	 */
	tableName: string;
	/**
	 * Interval in seconds for automatic cleanup of expired keys.
	 * Set to 0 to disable automatic cleanup.
	 */
	ttlCleanupIntervalSec: number;
}

/** Rows fetched per page by {@link AdapterSqlite.keysIter}. */
const KEYS_ITER_PAGE = 500;

/** A row is live when it has no expiry or expires after the bound `now` (epoch ms). */
const LIVE = "(expires_at IS NULL OR expires_at > ?)";

/**
 * SQLite key-value storage adapter.
 *
 * Provides persistent key-value storage on a `node:sqlite` database: values are JSON
 * text, expirations are epoch milliseconds. Automatically creates the required table
 * and index on initialization.
 *
 * @remarks
 * - `node:sqlite` is synchronous, so every operation blocks the event loop for its
 *   duration (typically microseconds) and nothing else on the handle interleaves.
 * - Multi-statement operations run in `BEGIN IMMEDIATE`, so they stay atomic against
 *   other connections and processes on the same file. Inside a transaction the caller
 *   already opened on the same handle, they use a savepoint instead.
 *
 * @example
 * ```typescript
 * import { DatabaseSync } from "node:sqlite";
 *
 * const client = createKVClient("myapp:", "sqlite", {
 *   db: new DatabaseSync("kv.db"),
 * });
 * await client.initialize();
 * await client.set("session:abc", { userId: 123 }, { ttl: 3600 });
 * ```
 */
export class AdapterSqlite extends AdapterAbstract {
	override _type = "sqlite";

	override readonly options: AdapterSqliteOptions = {
		defaultTtl: 0, // no ttl by default
		logger: createClog("KV/sqlite"),
		db: null!, // will be set in constructor via options merge
		tableName: "__kv",
		ttlCleanupIntervalSec: 0,
		validateKeys: true,
	};

	#cleanupTimer: ReturnType<typeof setTimeout> | undefined;

	/** Prepared statements by SQL text — a small, fixed set per adapter. */
	#statements = new Map<string, StatementSync>();

	constructor(namespace: string = "", options: Partial<AdapterSqliteOptions> = {}) {
		super(namespace);
		this.options = Object.freeze({ ...this.options, ...(options || {}) });
		if (!this.options.db) {
			throw new Error("Missing sqlite database instance");
		}
		// tableName is spliced into SQL verbatim, so guard against surprises.
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(this.options.tableName)) {
			throw new Error(
				`Invalid tableName "${this.options.tableName}". Only word characters are allowed.`,
			);
		}
	}

	#stmt(sql: string): StatementSync {
		let stmt = this.#statements.get(sql);
		if (!stmt) {
			stmt = this.options.db.prepare(sql);
			this.#statements.set(sql, stmt);
		}
		return stmt;
	}

	#expiresAt(ttl: number | undefined): number | null {
		return ttl ? Math.round(Date.now() + ttl * 1000) : null;
	}

	/**
	 * Runs `fn` as one unit: `BEGIN IMMEDIATE` takes the write lock up front, so no other
	 * connection can write between its statements. Inside a transaction the caller opened
	 * on this handle, a savepoint keeps `fn` all-or-nothing without committing theirs.
	 * `fn` must stay synchronous — an `await` inside would let other work join the
	 * transaction.
	 */
	#atomic<T>(fn: () => T): T {
		const { db, logger } = this.options;
		const [begin, commit, rollback] = db.isTransaction
			? ["SAVEPOINT kv_atomic", "RELEASE kv_atomic", "ROLLBACK TO kv_atomic"]
			: ["BEGIN IMMEDIATE", "COMMIT", "ROLLBACK"];

		db.exec(begin);
		try {
			const result = fn();
			db.exec(commit);
			return result;
		} catch (err) {
			try {
				db.exec(rollback);
				// a savepoint survives ROLLBACK TO; release it to leave the caller's
				// transaction exactly as it was
				if (begin.startsWith("SAVEPOINT")) db.exec(commit);
			} catch (rollbackErr) {
				logger?.error?.(`Rollback failed: ${rollbackErr}`);
			}
			throw err;
		}
	}

	/** @inheritdoc */
	override async initialize(): Promise<void> {
		const { db, tableName } = this.options;

		db.exec(`
            CREATE TABLE IF NOT EXISTS ${tableName} (
                key TEXT NOT NULL PRIMARY KEY,
                value TEXT NOT NULL,
                expires_at INTEGER
            )
        `);

		db.exec(`
            CREATE INDEX IF NOT EXISTS idx_${tableName}_expires_at
                ON ${tableName} (expires_at)
                WHERE expires_at IS NOT NULL
        `);

		this._initialized = true;
		this.#maybeTTLCleanup();
	}

	/** @inheritdoc */
	override async destroy(hard?: boolean): Promise<void> {
		// stop the timer first so a pending tick cannot fire during DROP
		clearTimeout(this.#cleanupTimer);
		this.#cleanupTimer = undefined;
		this.#statements.clear();

		if (hard) {
			const { db, tableName } = this.options;
			db.exec(`DROP TABLE IF EXISTS ${tableName}`);
		}
		this._initialized = false;
	}

	#maybeTTLCleanup() {
		clearTimeout(this.#cleanupTimer); // safety
		if (this.options.ttlCleanupIntervalSec) {
			const { tableName, logger } = this.options;

			// do the cleanup now
			try {
				this.#stmt(
					`DELETE FROM ${tableName}
                    WHERE expires_at IS NOT NULL AND expires_at <= ?`,
				).run(Date.now());
			} catch (err) {
				logger?.error?.(`TTL cleanup error: ${err}`);
			}

			// schedule next...
			this.#cleanupTimer = setTimeout(
				this.#maybeTTLCleanup.bind(this),
				this.options.ttlCleanupIntervalSec * 1000,
			);
		}
	}

	/**
	 * Convert a Redis-style glob to an SQLite GLOB pattern. GLOB already reads `*` and `?`
	 * as wildcards; its one other metacharacter, `[`, is made literal as `[[]`. Unlike
	 * LIKE, GLOB is case-sensitive and can use the primary-key index for a literal prefix.
	 */
	#globPattern(pattern: string): string {
		return pattern.replace(/\[/g, "[[]");
	}

	#withNsGlob(pattern: string): string {
		// namespace is a literal prefix — its own `*`/`?`/`[` must be escaped too
		const ns = this.namespace.replace(/[*?[]/g, "[$&]");
		return ns + this.#globPattern(pattern);
	}

	#upsertSql(): string {
		return `INSERT INTO ${this.options.tableName} (key, value, expires_at)
            VALUES (?, ?, ?)
            ON CONFLICT (key) DO UPDATE SET
                value = excluded.value,
                expires_at = excluded.expires_at`;
	}

	#set(key: string, value: any, options: Partial<SetOptions> = {}): boolean {
		this._assertInitialized();
		this.#stmt(this.#upsertSql()).run(
			this._withNs(key),
			JSON.stringify(value ?? null),
			this.#expiresAt(this._resolveTtl(options)),
		);
		return true;
	}

	/** @inheritdoc */
	override async set(
		key: string,
		value: any,
		options: Partial<SetOptions> = {},
	): Promise<boolean> {
		return this.#set(key, value, options);
	}

	/** @inheritdoc */
	override async setIfAbsent(
		key: string,
		value: any,
		options: Partial<SetOptions> = {},
	): Promise<boolean> {
		this._assertInitialized();
		const nsKey = this._withNs(key);

		// INSERT on new keys; UPDATE only when the existing row is expired.
		// (Live keys stay untouched — the hallmark of setIfAbsent.)
		const { changes } = this.#stmt(
			`${this.#upsertSql()}
            WHERE expires_at IS NOT NULL AND expires_at <= ?`,
		).run(
			nsKey,
			JSON.stringify(value ?? null),
			this.#expiresAt(this._resolveTtl(options)),
			Date.now(),
		);
		return Number(changes) > 0;
	}

	/** @inheritdoc */
	override async getSet(
		key: string,
		value: any,
		options: Partial<SetOptions> = {},
	): Promise<any> {
		this._assertInitialized();
		return this.#atomic(() => {
			const previous = this.#get(key);
			this.#set(key, value, options);
			return previous;
		});
	}

	#incrBy(key: string, delta: number, options: Partial<SetOptions> = {}): number {
		this._assertInitialized();
		const nsKey = this._withNs(key);
		const { tableName } = this.options;

		// Read-modify-write in JS, so the arithmetic is exactly the memory adapter's.
		return this.#atomic(() => {
			const row = this.#stmt(
				`SELECT value FROM ${tableName} WHERE key = ? AND ${LIVE}`,
			).get(nsKey, Date.now()) as { value: string } | undefined;

			// - New key OR expired key: value = delta, expires_at = $ttl
			// - Live key: value = old + delta, preserve existing expires_at
			if (!row) {
				this.#stmt(this.#upsertSql()).run(
					nsKey,
					JSON.stringify(delta),
					this.#expiresAt(this._resolveTtl(options)),
				);
				return delta;
			}

			const current = JSON.parse(row.value);
			if (typeof current !== "number") {
				throw new TypeError("KV value is not a number");
			}
			const next = current + delta;
			this.#stmt(`UPDATE ${tableName} SET value = ? WHERE key = ?`).run(
				JSON.stringify(next),
				nsKey,
			);
			return next;
		});
	}

	/** @inheritdoc */
	override async incr(
		key: string,
		by = 1,
		options: Partial<SetOptions> = {},
	): Promise<number> {
		return this.#incrBy(key, by, options);
	}

	/** @inheritdoc */
	override async decr(
		key: string,
		by = 1,
		options: Partial<SetOptions> = {},
	): Promise<number> {
		return this.#incrBy(key, -by, options);
	}

	/** @inheritdoc */
	override async cas(
		key: string,
		expected: any,
		next: any,
		options: Partial<SetOptions> = {},
	): Promise<boolean> {
		this._assertInitialized();
		const nsKey = this._withNs(key);
		const { tableName } = this.options;
		const hasTtl = options.ttl !== undefined;

		// Stored values are `JSON.stringify` output, so comparing the text is comparing
		// the values — with the memory and Redis adapters' key-order sensitivity.
		const params: (string | number | null)[] = [JSON.stringify(next ?? null)];
		if (hasTtl) params.push(this.#expiresAt(this._resolveTtl(options)));
		params.push(nsKey, JSON.stringify(expected ?? null), Date.now());

		const { changes } = this.#stmt(
			`UPDATE ${tableName}
            SET value = ?${hasTtl ? ", expires_at = ?" : ""}
            WHERE key = ? AND value = ? AND ${LIVE}`,
		).run(...params);
		return Number(changes) > 0;
	}

	#get(key: string): any {
		this._assertInitialized();
		const row = this.#stmt(
			`SELECT value FROM ${this.options.tableName} WHERE key = ? AND ${LIVE}`,
		).get(this._withNs(key), Date.now()) as { value: string } | undefined;

		return row ? JSON.parse(row.value) : null;
	}

	/** @inheritdoc */
	override async get(key: string): Promise<any> {
		return this.#get(key);
	}

	#delete(key: string): boolean {
		this._assertInitialized();
		const { changes } = this.#stmt(
			`DELETE FROM ${this.options.tableName} WHERE key = ?`,
		).run(this._withNs(key));
		return Number(changes) > 0;
	}

	/** @inheritdoc */
	override async delete(key: string): Promise<boolean> {
		return this.#delete(key);
	}

	/** @inheritdoc */
	override async exists(key: string): Promise<boolean> {
		this._assertInitialized();
		const row = this.#stmt(
			`SELECT 1 FROM ${this.options.tableName} WHERE key = ? AND ${LIVE}`,
		).get(this._withNs(key), Date.now());
		return row !== undefined;
	}

	/** @inheritdoc */
	override async keys(pattern: string): Promise<string[]> {
		this._assertInitialized();
		const rows = this.#stmt(
			`SELECT key FROM ${this.options.tableName}
            WHERE key GLOB ? AND ${LIVE}
            ORDER BY key`,
		).all(this.#withNsGlob(pattern), Date.now()) as { key: string }[];
		return rows.map((row) => this._withoutNs(row.key)).toSorted();
	}

	/** @inheritdoc */
	override async *keysIter(pattern: string): AsyncIterable<string> {
		this._assertInitialized();
		const { tableName } = this.options;
		const glob = this.#withNsGlob(pattern);

		// Keyset pages instead of one open statement: nothing is left open (no read
		// snapshot held) while the consumer awaits between yields, and an early break
		// leaves nothing to release.
		let after: string | undefined;
		while (true) {
			const rows = (
				after === undefined
					? this.#stmt(
							`SELECT key FROM ${tableName}
                        WHERE key GLOB ? AND ${LIVE}
                        ORDER BY key LIMIT ${KEYS_ITER_PAGE}`,
						).all(glob, Date.now())
					: this.#stmt(
							`SELECT key FROM ${tableName}
                        WHERE key GLOB ? AND key > ? AND ${LIVE}
                        ORDER BY key LIMIT ${KEYS_ITER_PAGE}`,
						).all(glob, after, Date.now())
			) as { key: string }[];

			for (const row of rows) {
				yield this._withoutNs(row.key);
			}
			if (rows.length < KEYS_ITER_PAGE) return;
			after = rows[rows.length - 1]!.key;
		}
	}

	/** @inheritdoc */
	override async clear(pattern: string): Promise<number> {
		this._assertInitialized();
		const { tableName } = this.options;
		const glob = this.#withNsGlob(pattern);
		const now = Date.now();

		return this.#atomic(() => {
			const { changes } = this.#stmt(
				`DELETE FROM ${tableName} WHERE key GLOB ? AND ${LIVE}`,
			).run(glob, now);
			// expired rows under the pattern are already invisible; drop them too, but
			// don't count them
			this.#stmt(
				`DELETE FROM ${tableName}
                WHERE key GLOB ? AND expires_at IS NOT NULL AND expires_at <= ?`,
			).run(glob, now);
			return Number(changes);
		});
	}

	/** @inheritdoc */
	override async setMultiple(
		entries: readonly SetMultipleEntry[],
		options: Partial<SetOptions> = {},
	): Promise<boolean[]> {
		this._assertInitialized();

		if (entries.length === 0) return [];

		// validate every key before writing any
		const rows = this._normalizePairs(entries).map(({ key, value, ttl }) => [
			this._withNs(key),
			JSON.stringify(value ?? null),
			this.#expiresAt(this._resolveTtl({ ttl: ttl ?? options.ttl })),
		]);

		// one transaction: all-or-nothing, and a single commit instead of one per row
		this.#atomic(() => {
			const upsert = this.#stmt(this.#upsertSql());
			for (const params of rows) upsert.run(...params);
		});

		return rows.map(() => true);
	}

	/** @inheritdoc */
	override async getMultiple(keys: string[]): Promise<Record<string, any>> {
		this._assertInitialized();

		if (keys.length === 0) return {};

		// one JSON-array parameter instead of N placeholders: no bound-variable limit,
		// and a single cached statement for every batch size
		const rows = this.#stmt(
			`SELECT key, value FROM ${this.options.tableName}
            WHERE key IN (SELECT j.value FROM json_each(?) AS j) AND ${LIVE}`,
		).all(JSON.stringify(keys.map((k) => this._withNs(k))), Date.now()) as {
			key: string;
			value: string;
		}[];

		const found: Record<string, any> = Object.create(null);
		for (const row of rows) {
			found[this._withoutNs(row.key)] = JSON.parse(row.value);
		}

		// preserve explicit null / false / 0 / "" — missing keys become null
		const resultMap: Record<string, any> = {};
		for (const key of keys) {
			resultMap[key] = key in found ? found[key] : null;
		}

		return resultMap;
	}

	/** @inheritdoc */
	override async expire(key: string, ttl: number): Promise<boolean> {
		this._assertInitialized();
		const { changes } = this.#stmt(
			`UPDATE ${this.options.tableName}
            SET expires_at = ?
            WHERE key = ? AND ${LIVE}`,
		).run(Math.round(Date.now() + ttl * 1000), this._withNs(key), Date.now());
		return Number(changes) > 0;
	}

	/** @inheritdoc */
	override async ttl(key: string): Promise<TtlResult> {
		this._assertInitialized();
		const row = this.#stmt(
			`SELECT expires_at FROM ${this.options.tableName} WHERE key = ?`,
		).get(this._withNs(key)) as { expires_at: number | bigint | null } | undefined;

		if (!row) return { state: "missing" };
		if (row.expires_at === null) return { state: "no-ttl" };

		// expired-but-not-yet-cleaned counts as missing (matches get() filter)
		const at = new Date(Number(row.expires_at));
		if (at.valueOf() <= Date.now()) return { state: "missing" };
		return { state: "expires", at };
	}

	/** @inheritdoc */
	override async transaction(operations: Operation[]): Promise<any[]> {
		this._assertInitialized();
		return this.#atomic(() => {
			const results: any[] = [];
			for (const op of operations) {
				switch (op.type) {
					case "set":
						results.push(this.#set(op.key, op.value, op.options || {}));
						break;
					case "get":
						results.push(this.#get(op.key));
						break;
					case "delete":
						results.push(this.#delete(op.key));
						break;
				}
			}
			return results;
		});
	}

	override async __debug_dump(): Promise<
		Record<string, { value: any; ttl: Date | null }>
	> {
		this._assertInitialized();
		const rows = this.#stmt(
			`SELECT key, value, expires_at FROM ${this.options.tableName} WHERE key GLOB ?`,
		).all(this.#withNsGlob("*")) as {
			key: string;
			value: string;
			expires_at: number | bigint | null;
		}[];

		return rows.reduce<Record<string, { value: unknown; ttl: Date | null }>>(
			(m, row) => {
				m[this._withoutNs(row.key)] = {
					value: JSON.parse(row.value),
					ttl:
						row.expires_at === null ? null : new Date(Number(row.expires_at)),
				};
				return m;
			},
			{},
		);
	}
}
