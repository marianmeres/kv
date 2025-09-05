import {
	AdapterAbstract,
	type Operation,
	type SetOptions,
	type AdapterAbstractOptions,
} from "./abstract.ts";
import { createLogger } from "@marianmeres/clog";
import type pg from "pg";

export interface AdapterPostgresOptions extends AdapterAbstractOptions {
	/** pg.Pool or pg.Client instance */
	db: pg.Pool | pg.Client;
	/** */
	tableName: string;
	/** Set 0 to disable */
	ttlCleanupIntervalSec: number;
}

export class AdapterPostgres extends AdapterAbstract {
	override _type = "postgres";

	override readonly options: AdapterPostgresOptions = {
		defaultTtl: 0, // no ttl by default
		logger: createLogger("KV/memory"),
		db: null as any,
		tableName: "__kv",
		ttlCleanupIntervalSec: 0,
	};

	#cleanupTimer: any;

	constructor(
		public override readonly namespace: string = "",
		options: Partial<AdapterPostgresOptions> = {}
	) {
		super();
		this._assertValidNamespace();
		this.options = { ...this.options, ...(options || {}) };
		if (!this.options.db) {
			throw new Error("Missing pg instance");
		}
	}

	async initialize(): Promise<void> {
		const { db, tableName } = this.options;

		// so we can work with "schema." prefix in naming things...
		const safe = (name: string) => `${name}`.replace(/\W/g, "");

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
            CREATE INDEX IF NOT EXISTS idx_${safe(tableName)}_expires_at 
                ON ${tableName} (expires_at) 
                WHERE expires_at IS NOT NULL
        `);

		this._initialized = true;
		this.#maybeTTLCleanup();
	}

	async destroy(hard?: boolean): Promise<void> {
		if (hard) {
			const { db, tableName } = this.options;
			await db.query(`DROP TABLE IF EXISTS ${tableName}`);
		}
		this._initialized = false;
		clearTimeout(this.#cleanupTimer);
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

	/** convert Redis-style pattern to PostgreSQL LIKE pattern */
	#likePattern(pattern: string) {
		return pattern.replace(/\*/g, "%").replace(/\?/g, "_");
	}

	/** Will set key-value pair to the underlying store with given options */
	override async set(
		key: string,
		value: any,
		options: Partial<SetOptions> = {}
	): Promise<boolean> {
		this._assertInitialized();
		key = this._withNs(key);

		const { db, tableName } = this.options;
		const ttl = options.ttl || this.options.defaultTtl;
		const expiresAt = ttl ? new Date(Date.now() + ttl * 1000) : null;

		// a.k.a. UPSERT
		await db.query(
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

	/** Will get the key from the underlying store */
	override async get(key: string): Promise<any> {
		this._assertInitialized();
		key = this._withNs(key);

		const { db, tableName } = this.options;
		const { rows } = await db.query(
			`SELECT value, expires_at 
            FROM ${tableName} 
            WHERE key = $1 AND (expires_at IS NULL OR expires_at > NOW())`,
			[key]
		);

		if (rows.length === 0) return null;

		return rows[0].value;
	}

	/** Will delete the key from the underlying store */
	override async delete(key: string): Promise<boolean> {
		this._assertInitialized();
		key = this._withNs(key);

		const { db, tableName } = this.options;
		const { rowCount } = await db.query(
			`DELETE FROM ${tableName} WHERE key = $1`,
			[key]
		);

		return rowCount! > 0;
	}

	/** Will check if the key exists in the underlying store */
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

	/** Will list all existing keys in the underlying store matching given pattern.
	 * Recognizes redis-like star wildcard format. */
	override async keys(pattern: string): Promise<string[]> {
		this._assertInitialized();

		const { db, tableName } = this.options;
		let params: string[] = [];

		const query = `
            SELECT key FROM ${tableName} 
            WHERE key LIKE $1 
            AND (expires_at IS NULL OR expires_at > NOW())
            ORDER BY key`;

		if (pattern === "*") {
			params = [this.namespace + "%"];
		} else {
			params = [this.namespace + this.#likePattern(pattern)];
		}

		const { rows } = await db.query(query, params);
		return rows
			.map((row) => {
				let k = row.key;
				// strip namespace if exists
				if (this.namespace) k = k.slice(this.namespace.length);
				return k;
			})
			.toSorted();
	}

	/** Will clear all existing keys in the underlying store matching given pattern */
	override async clear(pattern: string): Promise<number> {
		this._assertInitialized();

		const { db, tableName } = this.options;
		let params: string[] = [];

		const query = `DELETE FROM ${tableName} WHERE key LIKE $1`;
		if (pattern === "*") {
			params = [this.namespace + "%"];
		} else {
			params = [this.namespace + this.#likePattern(pattern)];
		}

		const { rowCount } = await db.query(query, params);
		return rowCount!;
	}

	/** Will set multiple kv pairs in one batch */
	override async setMultiple(
		keyValuePairs: [string, any][],
		options: Partial<SetOptions> = {}
	): Promise<boolean[]> {
		this._assertInitialized();

		const { db, tableName } = this.options;
		const ttl = options.ttl || this.options.defaultTtl;
		const expiresAt = ttl ? new Date(Date.now() + ttl * 1000) : null;

		const values = Object.entries(keyValuePairs)
			.map(([_k, _v], i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`)
			.join(", ");

		const params = keyValuePairs.reduce(
			(m, [k, v]) => [...m, this._withNs(k), JSON.stringify(v), expiresAt],
			[] as any
		);

		// a.k.a UPSERT
		const sql = `
            INSERT INTO ${tableName} (key, value, expires_at)
            VALUES ${values}
            ON CONFLICT (key) DO UPDATE SET 
                value = EXCLUDED.value,
                expires_at = EXCLUDED.expires_at,
                updated_at = NOW()
        `;
		// console.log(sql, params);
		await db.query(sql, params);

		return keyValuePairs.map(() => true);
	}

	/** Will get multiple keys in one batch */
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
		// console.log(sql, params);
		const { rows } = await db.query(sql, params);

		const found: Record<string, any> = {};
		rows.forEach((row) => {
			const key = this._withoutNs(row.key);
			found[key] = row.value;
		});

		// ensure all requested keys are in the result
		const resultMap: Record<string, any> = {};
		keys.forEach((key) => {
			resultMap[key] = found[key] || null;
		});

		return resultMap;
	}

	/** Will set the expiration ttl on the given key to given ttl value */
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

	/** Will get the expiration Date for given key */
	override async ttl(key: string): Promise<Date | null | false> {
		this._assertInitialized();
		key = this._withNs(key);

		const { db, tableName } = this.options;

		const { rows } = await db.query(
			`SELECT expires_at FROM ${tableName} WHERE key = $1`,
			[key]
		);

		// Key doesn't exist
		if (rows.length === 0) return false;

		const expiresAt = rows[0].expires_at;
		// No expiration set
		if (!expiresAt) return null;

		return new Date(expiresAt);
	}

	/**  */
	override async transaction(operations: Operation[]): Promise<any[]> {
		this._assertInitialized();
		const { db, logger } = this.options;

		const results = [];

		await db.query("BEGIN");

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
			await db.query("COMMIT");
		} catch (err) {
			await db.query("ROLLBACK");
			logger?.error?.(err);
			throw err;
		}

		return results;
	}

	override async __debug_dump(): Promise<
		Record<string, { value: any; ttl: Date | null | false }>
	> {
		this._assertInitialized();

		const { db, tableName } = this.options;

		const { rows } = await db.query(
			`SELECT key, value, expires_at FROM ${tableName} WHERE key LIKE $1`,
			[this.namespace + "%"]
		);

		// console.log(12312, rows);

		return rows.reduce((m, row) => {
			m[this._withoutNs(row.key)] = {
				value: row.value,
				ttl: row.expires_at,
			};
			return m;
		}, {} as any);
	}
}
