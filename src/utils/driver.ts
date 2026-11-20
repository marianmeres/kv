/**
 * @module
 *
 * The one seam between the postgres adapter and the database: whatever the host passed
 * as `db` becomes a sqlkit `Driver`, and every statement the adapter sends goes through it.
 */

import type { Driver } from "@marianmeres/sqlkit";
import {
	createPgClientDriver,
	createPgDriver,
	type PgPoolLike,
	type PgStandaloneClientLike,
} from "@marianmeres/sqlkit/pg";

/**
 * What the postgres adapter's `db` option takes: a node-postgres `pg.Pool`, a
 * connected `pg.Client`, or a sqlkit `Driver` of the `pg` dialect. The first two are
 * declared by shape, so nothing here imports `pg`.
 */
export type PostgresDb = PgPoolLike | PgStandaloneClientLike | Driver;

/** One driver per pool or client object, however many adapters share it. */
const drivers = new WeakMap<object, Driver>();

/** Whether `db` is a sqlkit `Driver` (by shape). */
export function isDriver(db: unknown): db is Driver {
	const d = db as Partial<Driver> | null;
	return (
		typeof d === "object" &&
		d !== null &&
		typeof d.dialect === "string" &&
		typeof d.query === "function" &&
		typeof d.exec === "function" &&
		typeof d.transaction === "function" &&
		typeof d.capabilities === "object" &&
		d.capabilities !== null
	);
}

/** A `pg.Pool` has `connect()` and counts its clients; a `pg.Client` does not. */
export function isPool(db: unknown): db is PgPoolLike {
	return (
		typeof db === "object" &&
		db !== null &&
		typeof (db as { connect?: unknown }).connect === "function" &&
		typeof (db as { totalCount?: unknown }).totalCount === "number"
	);
}

/**
 * The `Driver` the postgres adapter runs on. A host's `Driver` is used as it is; a
 * pool or a client gets one driver per object. The adapter never closes any of them.
 *
 * @throws {TypeError} For a `Driver` of another dialect, or one without `savepoint()`
 *   (built by a sqlkit older than 0.3.0).
 */
export function toPgDriver(db: PostgresDb): Driver {
	if (isDriver(db)) {
		if (db.dialect !== "pg") {
			throw new TypeError(
				`The postgres adapter runs on PostgreSQL: got a "${db.dialect}" driver (${db.adapter})`,
			);
		}
		// `transaction()` runs in the driver's `savepoint()`. The type requires it; a
		// driver from an older sqlkit, passed past the type, would fail there instead.
		if (typeof db.savepoint !== "function") {
			throw new TypeError(
				"The postgres adapter needs a Driver from @marianmeres/sqlkit 0.3.0 or newer: this one has no savepoint()",
			);
		}
		return db;
	}
	let driver = drivers.get(db);
	if (driver === undefined) {
		driver = isPool(db) ? createPgDriver(db) : createPgClientDriver(db);
		drivers.set(db, driver);
	}
	return driver;
}
