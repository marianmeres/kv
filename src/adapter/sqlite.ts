/**
 * @module
 *
 * SQLite key-value storage adapter implementation (`node:sqlite`, through a sqlkit
 * driver: kv's own over a handle, or the host's).
 */

import type { DatabaseSync } from "node:sqlite";
import { createClog } from "@marianmeres/clog";
import type { Driver, QueryResult, Row, SyncDriver } from "@marianmeres/sqlkit";
import {
	assertSqliteDriver,
	isDatabaseSync,
	ownSqliteDriver,
	type SqliteDb,
	statesDialect,
} from "../utils/sqlite-driver.ts";
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
	 * The database: an open `node:sqlite` handle, e.g. `new DatabaseSync("kv.db")`, or a
	 * sqlkit `Driver` of the `sqlite` dialect with a sync tier, e.g. `openSqlite("kv.db")`.
	 * The caller owns it: `destroy()` never closes it, so one can be shared across
	 * adapters.
	 */
	db: SqliteDb;
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
	 * The timer never keeps the process alive; `destroy()` stops it.
	 */
	ttlCleanupIntervalSec: number;
}

/** Rows fetched per page by {@link AdapterSqlite.keysIter}. */
const KEYS_ITER_PAGE = 500;

/** A row is live when it has no expiry or expires after the bound `now` (epoch ms). */
const LIVE = "(expires_at IS NULL OR expires_at > ?)";

/** One statement as it is sent: its text and its `?` parameters. */
type Statement = [text: string, params: unknown[]];

/**
 * SQLite key-value storage adapter.
 *
 * Provides persistent key-value storage on a `node:sqlite` database: values are JSON
 * text, expirations are epoch milliseconds. Automatically creates the required table
 * and index on initialization.
 *
 * @remarks
 * - Over a `DatabaseSync`, every statement goes through kv's own sqlkit driver over the
 *   handle, on its synchronous tier: one driver per handle, imported on first use. A
 *   statement runs inside the call, and nothing else on the handle interleaves.
 * - Over a sqlkit `Driver` the host passed, a statement takes its turn on the driver's
 *   async tier: it waits for a transaction the host has open elsewhere, and joins one
 *   it was issued inside.
 * - `node:sqlite` is synchronous, so every operation blocks the event loop for its
 *   duration (typically microseconds).
 * - Multi-statement operations run in `BEGIN IMMEDIATE`, so they stay atomic against
 *   other connections and processes on the same file. Inside a transaction the caller
 *   already opened (on the same handle, or through the same `Driver`), they use a
 *   savepoint instead.
 * - A statement SQLite refused rejects with sqlkit's `SqlError`, node:sqlite's error as
 *   its `cause`.
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
 *
 * // or on a sqlkit Driver
 * import { openSqlite } from "@marianmeres/sqlkit/sqlite";
 * const onDriver = createKVClient("myapp:", "sqlite", { db: openSqlite("kv.db") });
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

	/**
	 * What every statement runs on, set by {@link #open}: kv's own driver over
	 * `options.db`, or `options.db` itself when it is a `Driver`. Never closed: either
	 * way that would close what the host owns.
	 */
	#driver: Driver | undefined;

	/**
	 * Whether `options.db` is a host's `Driver` rather than a handle. The one flag that
	 * decides the path, read in {@link #open}, {@link #q}, {@link #atomic},
	 * {@link #exec} and the cleanup, and nowhere else.
	 */
	readonly #onHostDriver: boolean = false;

	constructor(namespace: string = "", options: Partial<AdapterSqliteOptions> = {}) {
		super(namespace);
		this.options = Object.freeze({ ...this.options, ...(options || {}) });
		if (!this.options.db) {
			throw new Error("Missing sqlite database instance");
		}
		if (statesDialect(this.options.db)) {
			assertSqliteDriver(this.options.db);
			this.#onHostDriver = true;
		} else if (!isDatabaseSync(this.options.db)) {
			throw new TypeError(
				"The sqlite adapter takes a node:sqlite DatabaseSync or a sqlkit Driver of the sqlite dialect as db",
			);
		}
		// tableName is spliced into SQL verbatim, so guard against surprises.
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(this.options.tableName)) {
			throw new Error(
				`Invalid tableName "${this.options.tableName}". Only word characters are allowed.`,
			);
		}
	}

	/**
	 * The driver: a host's `Driver` as it is, or kv's own over the handle, built (and its
	 * module imported) on the first call.
	 */
	async #open(): Promise<Driver> {
		this.#driver ??= this.#onHostDriver
			? (this.options.db as Driver)
			: await ownSqliteDriver(this.options.db as DatabaseSync);
		return this.#driver;
	}

	/**
	 * kv's own driver's sync tier: a statement runs inside the call. Never on a host's
	 * `Driver`, outside {@link #atomic}: there it is a `TypeError` whenever the host has a
	 * transaction open elsewhere.
	 */
	get #sync(): SyncDriver {
		return this.#driver!.sync!;
	}

	/**
	 * Run one statement. On a host's `Driver`, on its async tier: it waits its turn, and
	 * joins the host's transaction when the call was issued inside it. On kv's own
	 * driver, on the sync tier: it has run when this returns.
	 */
	#q<T = Row>(
		text: string,
		params: unknown[],
	): QueryResult<T> | Promise<QueryResult<T>> {
		if (this.#onHostDriver) return this.#driver!.query<T>(text, params);
		return this.#sync.query<T>(text, params);
	}

	/** Run a script: the DDL of `initialize()` and `destroy(true)`. */
	#exec(script: string): void | Promise<void> {
		if (this.#onHostDriver) return this.#driver!.exec(script);
		this.#sync.exec(script);
	}

	#expiresAt(ttl: number | undefined): number | null {
		return ttl ? Math.round(Date.now() + ttl * 1000) : null;
	}

	/**
	 * Runs `fn` as one unit: the driver's `sync.savepoint()`, which outside a transaction
	 * is `BEGIN IMMEDIATE` … `COMMIT`, so no other connection can write between its
	 * statements. `fn` must stay synchronous (an `await` inside would let other work join
	 * the transaction), and there is no `await` here either: the unit is over when the
	 * call returns.
	 *
	 * On a host's `Driver`, the same `fn` runs inside the driver's async `savepoint()`,
	 * on its sync tier (sqlkit's rule S3): the unit waits its turn, is a savepoint of the
	 * host's transaction when it was issued inside one, and runs without a break.
	 */
	async #atomic<T>(fn: (tx: SyncDriver) => T): Promise<T> {
		if (this.#onHostDriver) {
			const driver = this.#driver!;
			return driver.savepoint(async () => fn(driver.sync!));
		}
		const sync = this.#sync;
		const handle = this.options.db as DatabaseSync;
		// No transaction of the caller's: the driver's own. (A closed handle goes this way
		// too: `isTransaction` would throw, the driver answers with a `SqlError`.)
		if (!handle.isOpen || !handle.isTransaction) return sync.savepoint(fn);
		// The caller's BEGIN on the handle. The driver does not know that transaction and
		// SQLite refuses a second one, so the savepoint goes to the handle and the unit's
		// statements through the driver.
		handle.exec("SAVEPOINT kv_atomic");
		try {
			const result = fn(sync);
			handle.exec("RELEASE kv_atomic");
			return result;
		} catch (err) {
			try {
				handle.exec("ROLLBACK TO kv_atomic");
				// a savepoint survives ROLLBACK TO; release it to leave the caller's
				// transaction exactly as it was
				handle.exec("RELEASE kv_atomic");
			} catch (rollbackErr) {
				this.options.logger?.error?.(`Rollback failed: ${rollbackErr}`);
			}
			throw err;
		}
	}

	/** @inheritdoc */
	override async initialize(): Promise<void> {
		const { tableName } = this.options;
		await this.#open();

		await this.#exec(`
            CREATE TABLE IF NOT EXISTS ${tableName} (
                key TEXT NOT NULL PRIMARY KEY,
                value TEXT NOT NULL,
                expires_at INTEGER
            )
        `);

		await this.#exec(`
            CREATE INDEX IF NOT EXISTS idx_${tableName}_expires_at
                ON ${tableName} (expires_at)
                WHERE expires_at IS NOT NULL
        `);

		this._initialized = true;
		this.#maybeTTLCleanup();
	}

	/** @inheritdoc */
	override async destroy(hard?: boolean): Promise<void> {
		// stop the timer first so a pending tick cannot fire during DROP, and mark the
		// adapter down before any await
		clearTimeout(this.#cleanupTimer);
		this.#cleanupTimer = undefined;
		this._initialized = false;

		if (hard) {
			// `destroy(true)` may come before `initialize()`: open the driver here too
			await this.#open();
			await this.#exec(`DROP TABLE IF EXISTS ${this.options.tableName}`);
		}
	}

	async #maybeTTLCleanup() {
		clearTimeout(this.#cleanupTimer); // safety
		if (this.options.ttlCleanupIntervalSec) {
			const { db, tableName, logger } = this.options;
			const expired = `DELETE FROM ${tableName}
                    WHERE expires_at IS NOT NULL AND expires_at <= ?`;

			if (this.#onHostDriver) {
				// The PostgreSQL adapter's tick: the delete waits its turn. A closed driver
				// cannot be told from another failure but by its message, so every failure
				// is logged and the tick goes on.
				try {
					await this.#q(expired, [Date.now()]);
				} catch (err) {
					logger?.error?.(`TTL cleanup error: ${err}`);
				}

				// destroy() ran while the delete was waiting or running
				if (!this._initialized) return;
			} else {
				// The caller closed the handle without destroy(). Every later tick would
				// fail the same way, so say it once and stop.
				if (!(db as DatabaseSync).isOpen) {
					logger?.error?.(
						"TTL cleanup stopped: the database handle was closed before destroy()",
					);
					return;
				}

				// do the cleanup now
				try {
					this.#q(expired, [Date.now()]);
				} catch (err) {
					logger?.error?.(`TTL cleanup error: ${err}`);
				}
			}

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

	/** The upsert `set()` sends, shared with the units. Validates the key. */
	#setStatement(key: string, value: any, options: Partial<SetOptions> = {}): Statement {
		return [
			this.#upsertSql(),
			[
				this._withNs(key),
				JSON.stringify(value ?? null),
				this.#expiresAt(this._resolveTtl(options)),
			],
		];
	}

	/** @inheritdoc */
	override async set(
		key: string,
		value: any,
		options: Partial<SetOptions> = {},
	): Promise<boolean> {
		this._assertInitialized();
		await this.#q(...this.#setStatement(key, value, options));
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

		// INSERT on new keys; UPDATE only when the existing row is expired.
		// (Live keys stay untouched — the hallmark of setIfAbsent.)
		const { rowCount } = await this.#q(
			`${this.#upsertSql()}
            WHERE expires_at IS NOT NULL AND expires_at <= ?`,
			[
				nsKey,
				JSON.stringify(value ?? null),
				this.#expiresAt(this._resolveTtl(options)),
				Date.now(),
			],
		);
		return rowCount > 0;
	}

	/** @inheritdoc */
	override async getSet(
		key: string,
		value: any,
		options: Partial<SetOptions> = {},
	): Promise<any> {
		this._assertInitialized();
		return this.#atomic((tx) => {
			const previous = this.#valueOf(
				tx.query<{ value: string }>(...this.#getStatement(key)).rows,
			);
			tx.query(...this.#setStatement(key, value, options));
			return previous;
		});
	}

	#incrBy(
		key: string,
		delta: number,
		options: Partial<SetOptions> = {},
	): Promise<number> {
		this._assertInitialized();
		const nsKey = this._withNs(key);
		const { tableName } = this.options;

		// Read-modify-write in JS, so the arithmetic is exactly the memory adapter's.
		return this.#atomic((tx) => {
			const [row] = tx.query<{ value: string }>(
				`SELECT value FROM ${tableName} WHERE key = ? AND ${LIVE}`,
				[nsKey, Date.now()],
			).rows;

			// - New key OR expired key: value = delta, expires_at = $ttl
			// - Live key: value = old + delta, preserve existing expires_at
			if (!row) {
				tx.query(this.#upsertSql(), [
					nsKey,
					JSON.stringify(delta),
					this.#expiresAt(this._resolveTtl(options)),
				]);
				return delta;
			}

			const current = JSON.parse(row.value);
			if (typeof current !== "number") {
				throw new TypeError("KV value is not a number");
			}
			const next = current + delta;
			tx.query(`UPDATE ${tableName} SET value = ? WHERE key = ?`, [
				JSON.stringify(next),
				nsKey,
			]);
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

		const { rowCount } = await this.#q(
			`UPDATE ${tableName}
            SET value = ?${hasTtl ? ", expires_at = ?" : ""}
            WHERE key = ? AND value = ? AND ${LIVE}`,
			params,
		);
		return rowCount > 0;
	}

	/** The read `get()` sends, shared with the units. Validates the key. */
	#getStatement(key: string): Statement {
		return [
			`SELECT value FROM ${this.options.tableName} WHERE key = ? AND ${LIVE}`,
			[this._withNs(key), Date.now()],
		];
	}

	/** The value a {@link #getStatement} read: `null` when it found no live row. */
	#valueOf(rows: { value: string }[]): any {
		const [row] = rows;
		return row ? JSON.parse(row.value) : null;
	}

	/** @inheritdoc */
	override async get(key: string): Promise<any> {
		this._assertInitialized();
		const { rows } = await this.#q<{ value: string }>(...this.#getStatement(key));
		return this.#valueOf(rows);
	}

	/** The delete `delete()` sends, shared with the units. Validates the key. */
	#deleteStatement(key: string): Statement {
		return [
			`DELETE FROM ${this.options.tableName} WHERE key = ?`,
			[this._withNs(key)],
		];
	}

	/** @inheritdoc */
	override async delete(key: string): Promise<boolean> {
		this._assertInitialized();
		const { rowCount } = await this.#q(...this.#deleteStatement(key));
		return rowCount > 0;
	}

	/** @inheritdoc */
	override async exists(key: string): Promise<boolean> {
		this._assertInitialized();
		const { rowCount } = await this.#q(
			`SELECT 1 FROM ${this.options.tableName} WHERE key = ? AND ${LIVE}`,
			[this._withNs(key), Date.now()],
		);
		return rowCount > 0;
	}

	/** @inheritdoc */
	override async keys(pattern: string): Promise<string[]> {
		this._assertInitialized();
		const { rows } = await this.#q<{ key: string }>(
			`SELECT key FROM ${this.options.tableName}
            WHERE key GLOB ? AND ${LIVE}
            ORDER BY key`,
			[this.#withNsGlob(pattern), Date.now()],
		);
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
			const { rows } = await (after === undefined
				? this.#q<{ key: string }>(
						`SELECT key FROM ${tableName}
                        WHERE key GLOB ? AND ${LIVE}
                        ORDER BY key LIMIT ${KEYS_ITER_PAGE}`,
						[glob, Date.now()],
					)
				: this.#q<{ key: string }>(
						`SELECT key FROM ${tableName}
                        WHERE key GLOB ? AND key > ? AND ${LIVE}
                        ORDER BY key LIMIT ${KEYS_ITER_PAGE}`,
						[glob, after, Date.now()],
					));

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

		return this.#atomic((tx) => {
			const { rowCount } = tx.query(
				`DELETE FROM ${tableName} WHERE key GLOB ? AND ${LIVE}`,
				[glob, now],
			);
			// expired rows under the pattern are already invisible; drop them too, but
			// don't count them
			tx.query(
				`DELETE FROM ${tableName}
                WHERE key GLOB ? AND expires_at IS NOT NULL AND expires_at <= ?`,
				[glob, now],
			);
			return rowCount;
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
		await this.#atomic((tx) => {
			const upsert = this.#upsertSql();
			for (const params of rows) tx.query(upsert, params);
		});

		return rows.map(() => true);
	}

	/** @inheritdoc */
	override async getMultiple(keys: string[]): Promise<Record<string, any>> {
		this._assertInitialized();

		if (keys.length === 0) return {};

		// one JSON-array parameter instead of N placeholders: no bound-variable limit,
		// and a single cached statement for every batch size
		const { rows } = await this.#q<{ key: string; value: string }>(
			`SELECT key, value FROM ${this.options.tableName}
            WHERE key IN (SELECT j.value FROM json_each(?) AS j) AND ${LIVE}`,
			[JSON.stringify(keys.map((k) => this._withNs(k))), Date.now()],
		);

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
		const { rowCount } = await this.#q(
			`UPDATE ${this.options.tableName}
            SET expires_at = ?
            WHERE key = ? AND ${LIVE}`,
			[Math.round(Date.now() + ttl * 1000), this._withNs(key), Date.now()],
		);
		return rowCount > 0;
	}

	/** @inheritdoc */
	override async ttl(key: string): Promise<TtlResult> {
		this._assertInitialized();
		const [row] = (
			await this.#q<{ expires_at: number | bigint | null }>(
				`SELECT expires_at FROM ${this.options.tableName} WHERE key = ?`,
				[this._withNs(key)],
			)
		).rows;

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
		return this.#atomic((tx) => {
			const results: any[] = [];
			for (const op of operations) {
				switch (op.type) {
					case "set":
						tx.query(
							...this.#setStatement(op.key, op.value, op.options || {}),
						);
						results.push(true);
						break;
					case "get":
						results.push(
							this.#valueOf(
								tx.query<{ value: string }>(...this.#getStatement(op.key))
									.rows,
							),
						);
						break;
					case "delete":
						results.push(
							tx.query(...this.#deleteStatement(op.key)).rowCount > 0,
						);
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
		const { rows } = await this.#q<{
			key: string;
			value: string;
			expires_at: number | bigint | null;
		}>(
			`SELECT key, value, expires_at FROM ${this.options.tableName} WHERE key GLOB ?`,
			[this.#withNsGlob("*")],
		);

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
