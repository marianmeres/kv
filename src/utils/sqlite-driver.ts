/**
 * @module
 *
 * The one seam between the sqlite adapter and sqlkit's node:sqlite driver. That driver's
 * module imports `node:sqlite` when it loads, so it is imported here lazily, and only
 * for a `DatabaseSync`: the package root loads no `node:sqlite`.
 */

import type { DatabaseSync } from "node:sqlite";
import type { Driver } from "@marianmeres/sqlkit";

/**
 * Compiled statements kv's own driver keeps, by their text: what sqlkit's `openSqlite()`
 * keeps. Without a number the driver compiles every statement on every call.
 */
const STATEMENT_CACHE = 128;

/** One driver per handle, however many adapters share it. */
const drivers = new WeakMap<DatabaseSync, Driver>();

/**
 * Whether `db` has the shape of a node:sqlite `DatabaseSync`. By shape, so nothing here
 * imports `node:sqlite`. `isOpen` is read rather than `isTransaction`, which throws on a
 * closed handle.
 */
export function isDatabaseSync(db: unknown): db is DatabaseSync {
	const d = db as Partial<DatabaseSync> | null;
	return (
		typeof d === "object" &&
		d !== null &&
		typeof d.prepare === "function" &&
		typeof d.exec === "function" &&
		typeof d.isOpen === "boolean"
	);
}

/**
 * kv's own sqlkit driver over a handle the host passed: one per handle, keeping
 * {@link STATEMENT_CACHE} compiled statements. Imports `@marianmeres/sqlkit/sqlite` on
 * the first call.
 *
 * The adapter never calls `close()` on it: that would close the host's handle.
 */
export async function ownSqliteDriver(db: DatabaseSync): Promise<Driver> {
	let driver = drivers.get(db);
	if (driver === undefined) {
		const { createSqliteDriver } = await import("@marianmeres/sqlkit/sqlite");
		// two adapters on one handle may have awaited the import together
		driver =
			drivers.get(db) ??
			createSqliteDriver(db, { statementCache: STATEMENT_CACHE });
		drivers.set(db, driver);
	}
	return driver;
}
