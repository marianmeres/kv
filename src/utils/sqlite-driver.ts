/**
 * @module
 *
 * The one seam between the sqlite adapter and sqlkit's node:sqlite driver. That driver's
 * module imports `node:sqlite` when it loads, so it is imported here lazily, and only
 * for a `DatabaseSync`: the package root loads no `node:sqlite`. A sqlkit `Driver` the
 * host passes is checked here and used as it is.
 */

import type { DatabaseSync } from "node:sqlite";
import { type Driver, isDriver } from "@marianmeres/sqlkit";

/**
 * What the sqlite adapter's `db` option takes: a node:sqlite `DatabaseSync`, or a sqlkit
 * `Driver` of the `sqlite` dialect with a sync tier (`openSqlite()`'s, for one).
 */
export type SqliteDb = DatabaseSync | Driver;

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

/**
 * Whether `db` presents itself as a sqlkit `Driver`: a driver states its dialect, a
 * `DatabaseSync` has none. sqlkit's `toPgDriver` tells a driver from a pool or a client
 * by the same rule. Whether it is a driver the adapter can run on,
 * {@link assertSqliteDriver} decides.
 */
export function statesDialect(db: unknown): db is object {
	return (
		typeof db === "object" &&
		db !== null &&
		typeof (db as { dialect?: unknown }).dialect === "string"
	);
}

/**
 * Refuses a host's `Driver` the sqlite adapter cannot run on: one of another dialect,
 * one without the sync tier or `savepoint()` a unit runs on (a sqlkit older than 0.3.0
 * built no `savepoint()`), and one that is not a `Driver` as sqlkit's `isDriver()`
 * reads the contract.
 *
 * @throws {TypeError}
 */
export function assertSqliteDriver(db: object): asserts db is Driver {
	const d = db as Partial<Driver>;
	if (d.dialect !== "sqlite") {
		throw new TypeError(
			`The sqlite adapter runs on SQLite: got a "${d.dialect}" driver (${d.adapter})`,
		);
	}
	const missing =
		typeof d.sync !== "object" || d.sync === null
			? "no sync tier"
			: typeof d.savepoint !== "function"
				? "no savepoint()"
				: undefined;
	if (missing) {
		throw new TypeError(
			`The sqlite adapter needs a Driver with a sync tier and savepoint(), from @marianmeres/sqlkit 0.3.0 or newer: this one has ${missing}`,
		);
	}
	if (!isDriver(db)) {
		throw new TypeError(
			"The sqlite adapter needs a Driver as @marianmeres/sqlkit states the contract: isDriver() refuses this one",
		);
	}
}
