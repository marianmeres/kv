/**
 * @module
 *
 * PostgreSQL key-value storage adapter implementation.
 */

import {
	AdapterAbstract,
	type Operation,
	type SetMultipleEntry,
	type SetOptions,
	type TtlResult,
	type AdapterAbstractOptions,
} from "./abstract.ts";
import { createClog } from "@marianmeres/clog";
import type pg from "pg";

/**
 * Configuration options for the PostgreSQL KV adapter.
 */
export interface AdapterPostgresOptions extends AdapterAbstractOptions {
	/** PostgreSQL connection instance - either `pg.Pool` or `pg.Client`. */
	db: pg.Pool | pg.Client;
	/**
	 * Name of the table to use for storing key-value pairs.
	 * The table will be created automatically if it doesn't exist.
	 * May be prefixed with a schema, e.g. `"public.kv"`.
	 * Only word characters and a single dot are allowed.
	 * @default "__kv"
	 */
	tableName: string;
	/**
	 * Interval in seconds for automatic cleanup of expired keys.
	 * Set to 0 to disable automatic cleanup.
	 */
	ttlCleanupIntervalSec: number;
}

/** Minimal subset of pg.ClientBase used by this adapter. */
type PgExecutor = {
	query: (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number | null }>;
};

/**
 * PostgreSQL key-value storage adapter.
 *
 * Provides persistent key-value storage using PostgreSQL with JSONB values.
 * Automatically creates the required table and indexes on initialization.
 */
export class AdapterPostgres extends AdapterAbstract {
	override _type = "postgres";

	override readonly options: AdapterPostgresOptions = {
		defaultTtl: 0, // no ttl by default
		logger: createClog("KV/postgres"),
		db: null!, // will be set in constructor via options merge
		tableName: "__kv",
		ttlCleanupIntervalSec: 0,
		validateKeys: true,
	};

	#cleanupTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		public override readonly namespace: string = "",
		options: Partial<AdapterPostgresOptions> = {}
	) {
		super();
		this._assertValidNamespace();
		this.options = Object.freeze({ ...this.options, ...(options || {}) });
		if (!this.options.db) {
			throw new Error("Missing pg instance");
		}
		// validate tableName — it is spliced into SQL verbatim, so guard
		// against surprises. Allow optional schema prefix (one dot).
		if (
			!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(this.options.tableName)
		) {
			throw new Error(
				`Invalid tableName "${this.options.tableName}". Only word characters and a single "schema." prefix are allowed.`
			);
		}
	}

	/** Safe slug derived from tableName for use inside other identifiers (e.g. index names). */
	get #safeSlug(): string {
		return this.options.tableName.replace(/\W/g, "_");
	}

	/** @inheritdoc */
	override async initialize(): Promise<void> {
		const { db, tableName } = this.options;

		await db.query(`
            CREATE TABLE IF NOT EXISTS ${tableName} (
                key VARCHAR(512) PRIMARY KEY,
                value JSONB NOT NULL,
                expires_at TIMESTAMP WITH TIME ZONE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            )
        `);

		await db.query(`
            CREATE INDEX IF NOT EXISTS idx_${this.#safeSlug}_expires_at
                ON ${tableName} (expires_at)
                WHERE expires_at IS NOT NULL
        `);

		// Index for efficient prefix lookups with LIKE 'prefix%' queries
		await db.query(`
            CREATE INDEX IF NOT EXISTS idx_${this.#safeSlug}_key_prefix
                ON ${tableName} (key text_pattern_ops)
        `);

		this._initialized = true;
		this.#maybeTTLCleanup();
	}

	/** @inheritdoc */
	override async destroy(hard?: boolean): Promise<void> {
		// stop the timer first so a pending tick cannot fire during DROP
		clearTimeout(this.#cleanupTimer);
		this.#cleanupTimer = undefined;

		if (hard) {
			const { db, tableName } = this.options;
			await db.query(`DROP TABLE IF EXISTS ${tableName}`);
		}
		this._initialized = false;
	}

	async #maybeTTLCleanup() {
		clearTimeout(this.#cleanupTimer); // safety
		if (this.options.ttlCleanupIntervalSec) {
			const { db, tableName, logger } = this.options;

			// do the cleanup now
			try {
				await db.query(`
                    DELETE FROM ${tableName}
                    WHERE expires_at IS NOT NULL AND expires_at <= NOW()`);
			} catch (err) {
				logger?.error?.(`TTL cleanup error: ${err}`);
			}

			// schedule next...
			this.#cleanupTimer = setTimeout(
				this.#maybeTTLCleanup.bind(this),
				this.options.ttlCleanupIntervalSec * 1000
			);
		}
	}

	/**
	 * Convert Redis-style glob to a PostgreSQL LIKE pattern.
	 * Literal `%`, `_`, and `\` are escaped with `\`; `*`/`?` become `%`/`_`.
	 * LIKE queries using this output must include `ESCAPE '\'`.
	 */
	#likePattern(pattern: string) {
		return pattern
			.replace(/([\\%_])/g, "\\$1")
			.replace(/\*/g, "%")
			.replace(/\?/g, "_");
	}

	/** Suffix to append to any LIKE clause built from {@link #likePattern}. */
	readonly #likeEscape = ` ESCAPE '\\'`;

	#withNsLike(pattern: string): string {
		// namespace is a literal prefix — its own `%`/`_`/`\` must be escaped too
		const ns = this.namespace.replace(/([\\%_])/g, "\\$1");
		return ns + (pattern === "*" ? "%" : this.#likePattern(pattern));
	}

	/** @inheritdoc */
	override set(
		key: string,
		value: any,
		options: Partial<SetOptions> = {}
	): Promise<boolean> {
		return this.#setOn(this.options.db, key, value, options);
	}

	async #setOn(
		exec: PgExecutor,
		key: string,
		value: any,
		options: Partial<SetOptions> = {}
	): Promise<boolean> {
		this._assertInitialized();
		key = this._withNs(key);

		const { tableName } = this.options;
		const ttl = this._resolveTtl(options);
		const expiresAt = ttl ? new Date(Date.now() + ttl * 1000) : null;

		await exec.query(
			`INSERT INTO ${tableName} (key, value, expires_at, updated_at)
            VALUES ($1, $2, $3, NOW())
            ON CONFLICT (key) DO UPDATE SET
                value = EXCLUDED.value,
                expires_at = EXCLUDED.expires_at,
                updated_at = NOW()`,
			[key, JSON.stringify(value ?? null), expiresAt]
		);

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
		const { db, tableName } = this.options;
		const ttl = this._resolveTtl(options);
		const expiresAt = ttl ? new Date(Date.now() + ttl * 1000) : null;

		// INSERT on new keys; UPDATE only when the existing row is expired.
		// (Live keys stay untouched — the hallmark of setIfAbsent.)
		const { rowCount } = await db.query(
			`INSERT INTO ${tableName} (key, value, expires_at, updated_at)
            VALUES ($1, $2, $3, NOW())
            ON CONFLICT (key) DO UPDATE SET
                value = EXCLUDED.value,
                expires_at = EXCLUDED.expires_at,
                updated_at = NOW()
            WHERE ${tableName}.expires_at IS NOT NULL AND ${tableName}.expires_at <= NOW()`,
			[nsKey, JSON.stringify(value ?? null), expiresAt]
		);
		return (rowCount ?? 0) > 0;
	}

	/** @inheritdoc */
	override async getSet(
		key: string,
		value: any,
		options: Partial<SetOptions> = {}
	): Promise<any> {
		this._assertInitialized();
		const nsKey = this._withNs(key);
		const { db, tableName } = this.options;
		const ttl = this._resolveTtl(options);
		const expiresAt = ttl ? new Date(Date.now() + ttl * 1000) : null;

		// CTE captures pre-write state; UPSERT writes; RETURNING surfaces the prev.
		const { rows } = await db.query(
			`WITH prev AS (
                SELECT value FROM ${tableName}
                WHERE key = $1 AND (expires_at IS NULL OR expires_at > NOW())
            ), upserted AS (
                INSERT INTO ${tableName} (key, value, expires_at, updated_at)
                VALUES ($1, $2, $3, NOW())
                ON CONFLICT (key) DO UPDATE SET
                    value = EXCLUDED.value,
                    expires_at = EXCLUDED.expires_at,
                    updated_at = NOW()
                RETURNING 1
            )
            SELECT (SELECT value FROM prev) AS prev`,
			[nsKey, JSON.stringify(value ?? null), expiresAt]
		);
		return rows[0]?.prev ?? null;
	}

	async #incrBy(
		key: string,
		delta: number,
		options: Partial<SetOptions> = {}
	): Promise<number> {
		this._assertInitialized();
		const nsKey = this._withNs(key);
		const { db, tableName } = this.options;
		const ttl = this._resolveTtl(options);
		const expiresAt = ttl ? new Date(Date.now() + ttl * 1000) : null;

		// - New key OR expired key: value = delta, expires_at = $ttl
		// - Live key: value = old + delta, preserve existing expires_at
		// The nested cast `value::text::numeric` throws 22P02 when the stored
		// value is not a JSON number — we translate that to TypeError.
		try {
			const { rows } = await db.query(
				`INSERT INTO ${tableName} (key, value, expires_at, updated_at)
                VALUES ($1, to_jsonb($2::numeric), $3, NOW())
                ON CONFLICT (key) DO UPDATE SET
                    value = CASE
                        WHEN ${tableName}.expires_at IS NOT NULL AND ${tableName}.expires_at <= NOW()
                        THEN to_jsonb($2::numeric)
                        ELSE to_jsonb(${tableName}.value::text::numeric + $2::numeric)
                    END,
                    expires_at = CASE
                        WHEN ${tableName}.expires_at IS NOT NULL AND ${tableName}.expires_at <= NOW()
                        THEN EXCLUDED.expires_at
                        ELSE ${tableName}.expires_at
                    END,
                    updated_at = NOW()
                RETURNING value`,
				[nsKey, delta, expiresAt]
			);
			return Number(rows[0].value);
		} catch (err: any) {
			if (
				err?.code === "22P02" ||
				/invalid input syntax for type numeric/i.test(err?.message ?? "")
			) {
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

	/** @inheritdoc */
	override async cas(
		key: string,
		expected: any,
		next: any,
		options: Partial<SetOptions> = {}
	): Promise<boolean> {
		this._assertInitialized();
		const nsKey = this._withNs(key);
		const { db, tableName } = this.options;
		const hasTtl = options.ttl !== undefined;
		const ttl = hasTtl ? this._resolveTtl(options) : undefined;
		const expiresAt = ttl ? new Date(Date.now() + ttl * 1000) : null;

		const expectedJson = JSON.stringify(expected ?? null);
		const nextJson = JSON.stringify(next ?? null);

		const sql = hasTtl
			? `UPDATE ${tableName}
                SET value = $2::jsonb, expires_at = $4, updated_at = NOW()
                WHERE key = $1
                  AND value = $3::jsonb
                  AND (expires_at IS NULL OR expires_at > NOW())`
			: `UPDATE ${tableName}
                SET value = $2::jsonb, updated_at = NOW()
                WHERE key = $1
                  AND value = $3::jsonb
                  AND (expires_at IS NULL OR expires_at > NOW())`;

		const params: any[] = [nsKey, nextJson, expectedJson];
		if (hasTtl) params.push(expiresAt);

		const { rowCount } = await db.query(sql, params);
		return (rowCount ?? 0) > 0;
	}

	/** @inheritdoc */
	override get(key: string): Promise<any> {
		return this.#getOn(this.options.db, key);
	}

	async #getOn(exec: PgExecutor, key: string): Promise<any> {
		this._assertInitialized();
		key = this._withNs(key);

		const { tableName } = this.options;
		const { rows } = await exec.query(
			`SELECT value, expires_at
            FROM ${tableName}
            WHERE key = $1 AND (expires_at IS NULL OR expires_at > NOW())`,
			[key]
		);

		if (rows.length === 0) return null;

		return rows[0].value;
	}

	/** @inheritdoc */
	override delete(key: string): Promise<boolean> {
		return this.#deleteOn(this.options.db, key);
	}

	async #deleteOn(exec: PgExecutor, key: string): Promise<boolean> {
		this._assertInitialized();
		key = this._withNs(key);

		const { tableName } = this.options;
		const { rowCount } = await exec.query(
			`DELETE FROM ${tableName} WHERE key = $1`,
			[key]
		);

		return rowCount! > 0;
	}

	/** @inheritdoc */
	override async exists(key: string): Promise<boolean> {
		this._assertInitialized();
		key = this._withNs(key);

		const { db, tableName } = this.options;
		const { rows } = await db.query(
			`SELECT 1 FROM ${tableName}
            WHERE key = $1 AND (expires_at IS NULL OR expires_at > NOW())`,
			[key]
		);

		return rows.length > 0;
	}

	/** @inheritdoc */
	override async keys(pattern: string): Promise<string[]> {
		this._assertInitialized();

		const { db, tableName } = this.options;

		const { rows } = await db.query(
			`SELECT key FROM ${tableName}
            WHERE key LIKE $1${this.#likeEscape}
            AND (expires_at IS NULL OR expires_at > NOW())
            ORDER BY key`,
			[this.#withNsLike(pattern)]
		);
		return rows.map((row) => this._withoutNs(row.key)).toSorted();
	}

	/** @inheritdoc */
	override async *keysIter(pattern: string): AsyncIterable<string> {
		this._assertInitialized();
		const { tableName } = this.options;

		const { client, release } = await this.#acquireClient();
		// Use a per-call cursor name so multiple iterators on the same PG
		// client can't collide. `toString(36)` only emits [0-9a-z].
		const cursorName = `kv_iter_${Math.random().toString(36).slice(2)}`;

		let inTxn = false;
		try {
			await client.query("BEGIN");
			inTxn = true;
			await client.query(
				`DECLARE ${cursorName} NO SCROLL CURSOR FOR
                SELECT key FROM ${tableName}
                WHERE key LIKE $1${this.#likeEscape}
                AND (expires_at IS NULL OR expires_at > NOW())
                ORDER BY key`,
				[this.#withNsLike(pattern)]
			);
			while (true) {
				const { rows } = await client.query(`FETCH 500 FROM ${cursorName}`);
				if (rows.length === 0) break;
				for (const row of rows) {
					yield this._withoutNs(row.key);
				}
			}
		} finally {
			if (inTxn) {
				try {
					await client.query(`CLOSE ${cursorName}`);
				} catch {
					// cursor may already be gone if the txn aborted
				}
				try {
					await client.query("COMMIT");
				} catch {
					try {
						await client.query("ROLLBACK");
					} catch {
						// ignore — caller will see the original error
					}
				}
			}
			release();
		}
	}

	/** @inheritdoc */
	override async clear(pattern: string): Promise<number> {
		this._assertInitialized();

		const { db, tableName } = this.options;
		const likePattern = this.#withNsLike(pattern);

		// Batch large deletions to prevent long-running transactions
		const batchSize = 10000;
		let totalDeleted = 0;
		let deleted: number;

		do {
			const { rowCount } = await db.query(
				`DELETE FROM ${tableName} WHERE key IN (
					SELECT key FROM ${tableName} WHERE key LIKE $1${this.#likeEscape} LIMIT $2
				)`,
				[likePattern, batchSize]
			);
			deleted = rowCount ?? 0;
			totalDeleted += deleted;
		} while (deleted === batchSize);

		return totalDeleted;
	}

	/** @inheritdoc */
	override async setMultiple(
		entries: readonly SetMultipleEntry[],
		options: Partial<SetOptions> = {}
	): Promise<boolean[]> {
		this._assertInitialized();

		if (entries.length === 0) return [];

		const normalized = this._normalizePairs(entries);
		const { db, tableName } = this.options;

		const placeholders: string[] = [];
		const params: (string | Date | null)[] = [];
		let idx = 1;
		for (const { key, value, ttl: pairTtl } of normalized) {
			const ttl = this._resolveTtl({ ttl: pairTtl ?? options.ttl });
			const expiresAt = ttl ? new Date(Date.now() + ttl * 1000) : null;
			placeholders.push(`($${idx++}, $${idx++}, $${idx++})`);
			params.push(
				this._withNs(key),
				JSON.stringify(value ?? null),
				expiresAt
			);
		}

		const sql = `
            INSERT INTO ${tableName} (key, value, expires_at)
            VALUES ${placeholders.join(", ")}
            ON CONFLICT (key) DO UPDATE SET
                value = EXCLUDED.value,
                expires_at = EXCLUDED.expires_at,
                updated_at = NOW()
        `;
		await db.query(sql, params);

		return normalized.map(() => true);
	}

	/** @inheritdoc */
	override async getMultiple(keys: string[]): Promise<Record<string, any>> {
		this._assertInitialized();

		if (keys.length === 0) return {};

		const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");

		const { db, tableName } = this.options;
		const sql = `
            SELECT key, value
            FROM ${tableName}
            WHERE key IN (${placeholders}) AND (expires_at IS NULL OR expires_at > NOW())
        `;
		const params = keys.map((k) => this._withNs(k));
		const { rows } = await db.query(sql, params);

		const found: Record<string, any> = Object.create(null);
		for (const row of rows) {
			found[this._withoutNs(row.key)] = row.value;
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
		key = this._withNs(key);

		const { db, tableName } = this.options;
		const expiresAt = new Date(Date.now() + ttl * 1000);

		const { rowCount } = await db.query(
			`UPDATE ${tableName}
            SET expires_at = $2, updated_at = NOW()
            WHERE key = $1 AND (expires_at IS NULL OR expires_at > NOW())`,
			[key, expiresAt]
		);

		return rowCount! > 0;
	}

	/** @inheritdoc */
	override async ttl(key: string): Promise<TtlResult> {
		this._assertInitialized();
		key = this._withNs(key);

		const { db, tableName } = this.options;

		const { rows } = await db.query(
			`SELECT expires_at FROM ${tableName} WHERE key = $1`,
			[key]
		);

		if (rows.length === 0) return { state: "missing" };

		const expiresAt = rows[0].expires_at;
		if (!expiresAt) return { state: "no-ttl" };

		// expired-but-not-yet-cleaned counts as missing (matches get() filter)
		const at = new Date(expiresAt);
		if (at.valueOf() <= Date.now()) return { state: "missing" };
		return { state: "expires", at };
	}

	/**
	 * Acquire a single pinned connection for a transaction.
	 */
	async #acquireClient(): Promise<{ client: PgExecutor; release: () => void }> {
		const { db } = this.options as { db: any };
		if (typeof db.totalCount === "number" && typeof db.connect === "function") {
			const client = await db.connect();
			return { client, release: () => client.release() };
		}
		return { client: db, release: () => {} };
	}

	/** @inheritdoc */
	override async transaction(operations: Operation[]): Promise<any[]> {
		this._assertInitialized();
		const { logger } = this.options;

		const { client, release } = await this.#acquireClient();
		const results: any[] = [];

		try {
			await client.query("BEGIN");
			try {
				for (const op of operations) {
					switch (op.type) {
						case "set":
							results.push(
								await this.#setOn(client, op.key, op.value, op.options || {})
							);
							break;
						case "get":
							results.push(await this.#getOn(client, op.key));
							break;
						case "delete":
							results.push(await this.#deleteOn(client, op.key));
							break;
					}
				}
				await client.query("COMMIT");
			} catch (err) {
				try {
					await client.query("ROLLBACK");
				} catch (rollbackErr) {
					logger?.error?.(`Rollback failed: ${rollbackErr}`);
				}
				throw err;
			}
		} finally {
			release();
		}

		return results;
	}

	override async __debug_dump(): Promise<
		Record<string, { value: any; ttl: Date | null }>
	> {
		this._assertInitialized();

		const { db, tableName } = this.options;

		const { rows } = await db.query(
			`SELECT key, value, expires_at FROM ${tableName} WHERE key LIKE $1${this.#likeEscape}`,
			[this.#withNsLike("*")]
		);

		return rows.reduce<Record<string, { value: unknown; ttl: Date | null }>>(
			(m, row) => {
				m[this._withoutNs(row.key)] = {
					value: row.value,
					ttl: row.expires_at ? new Date(row.expires_at) : null,
				};
				return m;
			},
			{}
		);
	}
}
