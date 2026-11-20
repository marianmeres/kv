/**
 * @module
 *
 * PostgreSQL key-value storage adapter implementation.
 */

import { createClog } from "@marianmeres/clog";
import type { Driver } from "@marianmeres/sqlkit";
import { type PgDb, toPgDriver } from "@marianmeres/sqlkit/pg";
import {
	AdapterAbstract,
	type AdapterAbstractOptions,
	type Operation,
	type SetMultipleEntry,
	type SetOptions,
	type TtlResult,
} from "./abstract.ts";

/**
 * What the postgres adapter's `db` option takes: a node-postgres `pg.Pool`, a
 * connected `pg.Client`, or a sqlkit `Driver` of the `pg` dialect (sqlkit's `PgDb`).
 * The first two are declared by shape, so nothing here imports `pg`.
 */
export type PostgresDb = PgDb;

/**
 * Configuration options for the PostgreSQL KV adapter.
 */
export interface AdapterPostgresOptions extends AdapterAbstractOptions {
	/**
	 * The database: a node-postgres `pg.Pool`, a connected `pg.Client`, or a sqlkit
	 * `Driver` of the `pg` dialect. The caller owns it: the adapter never closes it.
	 */
	db: PostgresDb;
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
	 * The timer never keeps the process alive; `destroy()` stops it.
	 */
	ttlCleanupIntervalSec: number;
}

/** Rows fetched per page by {@link AdapterPostgres.keysIter}. */
const KEYS_ITER_PAGE = 500;

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

	/**
	 * What every statement runs on: sqlkit's `toPgDriver(options.db)`. A host's `Driver`
	 * as it is; over a pool or a client, the one driver sqlkit keeps for that object,
	 * shared with every other caller of `toPgDriver` on it. The adapter never closes it.
	 */
	readonly #db: Driver;

	constructor(namespace: string = "", options: Partial<AdapterPostgresOptions> = {}) {
		super(namespace);
		this.options = Object.freeze({ ...this.options, ...(options || {}) });
		if (!this.options.db) {
			throw new Error("Missing pg instance");
		}
		// validate tableName — it is spliced into SQL verbatim, so guard
		// against surprises. Allow optional schema prefix (one dot).
		if (
			!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(
				this.options.tableName,
			)
		) {
			throw new Error(
				`Invalid tableName "${this.options.tableName}". Only word characters and a single "schema." prefix are allowed.`,
			);
		}
		// last, so a constructor that throws leaves no driver (and no listener) behind
		this.#db = toPgDriver(this.options.db);
	}

	/** Safe slug derived from tableName for use inside other identifiers (e.g. index names). */
	get #safeSlug(): string {
		return this.options.tableName.replace(/\W/g, "_");
	}

	/** @inheritdoc */
	override async initialize(): Promise<void> {
		const { tableName } = this.options;

		await this.#db.query(`
            CREATE TABLE IF NOT EXISTS ${tableName} (
                key VARCHAR(512) PRIMARY KEY,
                value JSONB NOT NULL,
                expires_at TIMESTAMP WITH TIME ZONE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            )
        `);

		await this.#db.query(`
            CREATE INDEX IF NOT EXISTS idx_${this.#safeSlug}_expires_at
                ON ${tableName} (expires_at)
                WHERE expires_at IS NOT NULL
        `);

		// Index for efficient prefix lookups with LIKE 'prefix%' queries
		await this.#db.query(`
            CREATE INDEX IF NOT EXISTS idx_${this.#safeSlug}_key_prefix
                ON ${tableName} (key text_pattern_ops)
        `);

		this._initialized = true;
		this.#maybeTTLCleanup();
	}

	/** @inheritdoc */
	override async destroy(hard?: boolean): Promise<void> {
		// stop the timer first so a pending tick cannot fire during DROP, and mark the
		// adapter down before any await so an in-flight tick does not re-arm it
		clearTimeout(this.#cleanupTimer);
		this.#cleanupTimer = undefined;
		this._initialized = false;

		if (hard) {
			const { tableName } = this.options;
			await this.#db.query(`DROP TABLE IF EXISTS ${tableName}`);
		}
	}

	async #maybeTTLCleanup() {
		clearTimeout(this.#cleanupTimer); // safety
		if (this.options.ttlCleanupIntervalSec) {
			const { tableName, logger } = this.options;

			// do the cleanup now
			try {
				await this.#db.query(`
                    DELETE FROM ${tableName}
                    WHERE expires_at IS NOT NULL AND expires_at <= NOW()`);
			} catch (err) {
				logger?.error?.(`TTL cleanup error: ${err}`);
			}

			// destroy() ran while the query was in flight
			if (!this._initialized) return;

			// schedule next...
			this.#cleanupTimer = setTimeout(
				this.#maybeTTLCleanup.bind(this),
				this.options.ttlCleanupIntervalSec * 1000,
			);
			// housekeeping must not hold the process open; destroy() still clears it
			// (`?.`: browser and worker timers are plain numbers)
			this.#cleanupTimer.unref?.();
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
		options: Partial<SetOptions> = {},
	): Promise<boolean> {
		return this.#setOn(this.#db, key, value, options);
	}

	async #setOn(
		exec: Driver,
		key: string,
		value: any,
		options: Partial<SetOptions> = {},
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
			[key, JSON.stringify(value ?? null), expiresAt],
		);

		return true;
	}

	/** @inheritdoc */
	override async setIfAbsent(
		key: string,
		value: any,
		options: Partial<SetOptions> = {},
	): Promise<boolean> {
		this._assertInitialized();
		const nsKey = this._withNs(key);
		const { tableName } = this.options;
		const ttl = this._resolveTtl(options);
		const expiresAt = ttl ? new Date(Date.now() + ttl * 1000) : null;

		// INSERT on new keys; UPDATE only when the existing row is expired.
		// (Live keys stay untouched — the hallmark of setIfAbsent.)
		const { rowCount } = await this.#db.query(
			`INSERT INTO ${tableName} (key, value, expires_at, updated_at)
            VALUES ($1, $2, $3, NOW())
            ON CONFLICT (key) DO UPDATE SET
                value = EXCLUDED.value,
                expires_at = EXCLUDED.expires_at,
                updated_at = NOW()
            WHERE ${tableName}.expires_at IS NOT NULL AND ${tableName}.expires_at <= NOW()`,
			[nsKey, JSON.stringify(value ?? null), expiresAt],
		);
		return (rowCount ?? 0) > 0;
	}

	/** @inheritdoc */
	override async getSet(
		key: string,
		value: any,
		options: Partial<SetOptions> = {},
	): Promise<any> {
		this._assertInitialized();
		const nsKey = this._withNs(key);
		const { tableName } = this.options;
		const ttl = this._resolveTtl(options);
		const expiresAt = ttl ? new Date(Date.now() + ttl * 1000) : null;

		// CTE captures pre-write state; UPSERT writes; RETURNING surfaces the prev.
		const { rows } = await this.#db.query(
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
			[nsKey, JSON.stringify(value ?? null), expiresAt],
		);
		return rows[0]?.prev ?? null;
	}

	async #incrBy(
		key: string,
		delta: number,
		options: Partial<SetOptions> = {},
	): Promise<number> {
		this._assertInitialized();
		const nsKey = this._withNs(key);
		const { tableName } = this.options;
		const ttl = this._resolveTtl(options);
		const expiresAt = ttl ? new Date(Date.now() + ttl * 1000) : null;

		// - New key OR expired key: value = delta, expires_at = $ttl
		// - Live key: value = old + delta, preserve existing expires_at
		// - Live key that is not a JSON number: the WHERE of DO UPDATE skips it,
		//   so the statement updates nothing and returns no row. It raises nothing,
		//   so a transaction the host opened on the same Driver is not aborted.
		// The 22P02 catch is a backstop: a delta PostgreSQL cannot cast as numeric.
		try {
			const { rows } = await this.#db.query<{ value: unknown }>(
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
                WHERE (${tableName}.expires_at IS NOT NULL AND ${tableName}.expires_at <= NOW())
                    OR jsonb_typeof(${tableName}.value) = 'number'
                RETURNING value`,
				[nsKey, delta, expiresAt],
			);
			if (!rows.length) throw new TypeError("KV value is not a number");
			return Number(rows[0]!.value);
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
		options: Partial<SetOptions> = {},
	): Promise<number> {
		return this.#incrBy(key, by, options);
	}

	/** @inheritdoc */
	override decr(
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

		const { rowCount } = await this.#db.query(sql, params);
		return (rowCount ?? 0) > 0;
	}

	/** @inheritdoc */
	override get(key: string): Promise<any> {
		return this.#getOn(this.#db, key);
	}

	async #getOn(exec: Driver, key: string): Promise<any> {
		this._assertInitialized();
		key = this._withNs(key);

		const { tableName } = this.options;
		const { rows } = await exec.query<{ value: any }>(
			`SELECT value, expires_at
            FROM ${tableName}
            WHERE key = $1 AND (expires_at IS NULL OR expires_at > NOW())`,
			[key],
		);

		if (rows.length === 0) return null;

		return rows[0]!.value;
	}

	/** @inheritdoc */
	override delete(key: string): Promise<boolean> {
		return this.#deleteOn(this.#db, key);
	}

	async #deleteOn(exec: Driver, key: string): Promise<boolean> {
		this._assertInitialized();
		key = this._withNs(key);

		const { tableName } = this.options;
		const { rowCount } = await exec.query(`DELETE FROM ${tableName} WHERE key = $1`, [
			key,
		]);

		return rowCount! > 0;
	}

	/** @inheritdoc */
	override async exists(key: string): Promise<boolean> {
		this._assertInitialized();
		key = this._withNs(key);

		const { tableName } = this.options;
		const { rows } = await this.#db.query(
			`SELECT 1 FROM ${tableName}
            WHERE key = $1 AND (expires_at IS NULL OR expires_at > NOW())`,
			[key],
		);

		return rows.length > 0;
	}

	/** @inheritdoc */
	override async keys(pattern: string): Promise<string[]> {
		this._assertInitialized();

		const { tableName } = this.options;

		const { rows } = await this.#db.query<{ key: string }>(
			`SELECT key FROM ${tableName}
            WHERE key LIKE $1${this.#likeEscape}
            AND (expires_at IS NULL OR expires_at > NOW())`,
			[this.#withNsLike(pattern)],
		);
		return rows.map((row) => this._withoutNs(row.key)).toSorted();
	}

	/** @inheritdoc */
	override async *keysIter(pattern: string): AsyncIterable<string> {
		this._assertInitialized();
		const { tableName } = this.options;
		const like = this.#withNsLike(pattern);

		// Keyset pages in byte order, which is the order of the text_pattern_ops index
		// initialize() creates: each page is one range scan of it. Nothing stays open
		// between yields, so an early break leaves nothing to release.
		let after: string | undefined;
		while (true) {
			const { rows } =
				after === undefined
					? await this.#db.query<{ key: string }>(
							`SELECT key FROM ${tableName}
                        WHERE key LIKE $1${this.#likeEscape}
                        AND (expires_at IS NULL OR expires_at > NOW())
                        ORDER BY key USING ~<~ LIMIT ${KEYS_ITER_PAGE}`,
							[like],
						)
					: await this.#db.query<{ key: string }>(
							`SELECT key FROM ${tableName}
                        WHERE key LIKE $1${this.#likeEscape} AND key ~>~ $2
                        AND (expires_at IS NULL OR expires_at > NOW())
                        ORDER BY key USING ~<~ LIMIT ${KEYS_ITER_PAGE}`,
							[like, after],
						);

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
		const likePattern = this.#withNsLike(pattern);

		// Batch large deletions to prevent long-running transactions
		const batchSize = 10000;
		let totalDeleted = 0;
		let deleted: number;

		do {
			const { rowCount } = await this.#db.query(
				`DELETE FROM ${tableName} WHERE key IN (
					SELECT key FROM ${tableName} WHERE key LIKE $1${this.#likeEscape} LIMIT $2
				)`,
				[likePattern, batchSize],
			);
			deleted = rowCount ?? 0;
			totalDeleted += deleted;
		} while (deleted === batchSize);

		return totalDeleted;
	}

	/** @inheritdoc */
	override async setMultiple(
		entries: readonly SetMultipleEntry[],
		options: Partial<SetOptions> = {},
	): Promise<boolean[]> {
		this._assertInitialized();

		if (entries.length === 0) return [];

		const normalized = this._normalizePairs(entries);
		const { tableName } = this.options;

		const placeholders: string[] = [];
		const params: (string | Date | null)[] = [];
		let idx = 1;
		for (const { key, value, ttl: pairTtl } of normalized) {
			const ttl = this._resolveTtl({ ttl: pairTtl ?? options.ttl });
			const expiresAt = ttl ? new Date(Date.now() + ttl * 1000) : null;
			placeholders.push(`($${idx++}, $${idx++}, $${idx++})`);
			params.push(this._withNs(key), JSON.stringify(value ?? null), expiresAt);
		}

		const sql = `
            INSERT INTO ${tableName} (key, value, expires_at)
            VALUES ${placeholders.join(", ")}
            ON CONFLICT (key) DO UPDATE SET
                value = EXCLUDED.value,
                expires_at = EXCLUDED.expires_at,
                updated_at = NOW()
        `;
		await this.#db.query(sql, params);

		return normalized.map(() => true);
	}

	/** @inheritdoc */
	override async getMultiple(keys: string[]): Promise<Record<string, any>> {
		this._assertInitialized();

		if (keys.length === 0) return {};

		const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");

		const { tableName } = this.options;
		const sql = `
            SELECT key, value
            FROM ${tableName}
            WHERE key IN (${placeholders}) AND (expires_at IS NULL OR expires_at > NOW())
        `;
		const params = keys.map((k) => this._withNs(k));
		const { rows } = await this.#db.query<{ key: string; value: any }>(sql, params);

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

		const { tableName } = this.options;
		const expiresAt = new Date(Date.now() + ttl * 1000);

		const { rowCount } = await this.#db.query(
			`UPDATE ${tableName}
            SET expires_at = $2, updated_at = NOW()
            WHERE key = $1 AND (expires_at IS NULL OR expires_at > NOW())`,
			[key, expiresAt],
		);

		return rowCount! > 0;
	}

	/** @inheritdoc */
	override async ttl(key: string): Promise<TtlResult> {
		this._assertInitialized();
		key = this._withNs(key);

		const { tableName } = this.options;

		const { rows } = await this.#db.query<{ expires_at: Date | null }>(
			`SELECT expires_at FROM ${tableName} WHERE key = $1`,
			[key],
		);

		if (rows.length === 0) return { state: "missing" };

		const expiresAt = rows[0]!.expires_at;
		if (!expiresAt) return { state: "no-ttl" };

		// expired-but-not-yet-cleaned counts as missing (matches get() filter)
		const at = new Date(expiresAt);
		if (at.valueOf() <= Date.now()) return { state: "missing" };
		return { state: "expires", at };
	}

	/** @inheritdoc */
	override async transaction(operations: Operation[]): Promise<any[]> {
		this._assertInitialized(); // `async` keeps this a rejection
		// `savepoint()`, not `transaction()`: outside a transaction the two are the same
		// call, and the driver pins one connection (or, on one client, holds every other
		// caller back), checks the COMMIT, and rolls back when the callback rejects.
		// Inside a transaction the host opened on the same driver, the unit is a
		// savepoint of it: undone alone when it fails, while the host's transaction goes
		// on and decides the rest. A joined `transaction()` would leave the operations
		// before the failure in the host's transaction.
		return this.#db.savepoint(async (tx) => {
			const results: any[] = [];
			for (const op of operations) {
				switch (op.type) {
					case "set":
						results.push(
							await this.#setOn(tx, op.key, op.value, op.options || {}),
						);
						break;
					case "get":
						results.push(await this.#getOn(tx, op.key));
						break;
					case "delete":
						results.push(await this.#deleteOn(tx, op.key));
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

		const { tableName } = this.options;

		const { rows } = await this.#db.query<{
			key: string;
			value: unknown;
			expires_at: Date | null;
		}>(
			`SELECT key, value, expires_at FROM ${tableName} WHERE key LIKE $1${this.#likeEscape}`,
			[this.#withNsLike("*")],
		);

		return rows.reduce<Record<string, { value: unknown; ttl: Date | null }>>(
			(m, row) => {
				m[this._withoutNs(row.key)] = {
					value: row.value,
					ttl: row.expires_at ? new Date(row.expires_at) : null,
				};
				return m;
			},
			{},
		);
	}
}
