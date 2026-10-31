/**
 * Child process for the "cleanup timer does not hold the process open" test (see
 * kv.test.ts).
 *
 * Starts the adapter named in argv with TTL cleanup on, reports readiness, and returns
 * without ever calling `destroy()`. Nothing else keeps the event loop alive (the pg pool
 * is ended), so the process must exit by itself.
 */
import process from "node:process";
import { createKVClient } from "../src/kv.ts";
import { createPg } from "./_pg.ts";
import { createSqlite } from "./_sqlite.ts";

const type = process.argv[2];

if (type === "memory") {
	await createKVClient("x:", "memory", { ttlCleanupIntervalSec: 1 }).initialize();
} else if (type === "sqlite") {
	const db = createSqlite();
	await createKVClient("x:", "sqlite", { db, ttlCleanupIntervalSec: 1 }).initialize();
} else if (type === "postgres") {
	// One connection, so queries run in order: `SELECT 1` returns only after the first
	// cleanup query, which initialize() starts without awaiting it. Ending the pool
	// earlier would abandon that query before it schedules the next tick.
	const db = createPg({ max: 1 });
	await createKVClient("x:", "postgres", {
		db,
		tableName: "_kv_no_destroy_child", // the parent test drops it
		ttlCleanupIntervalSec: 1,
	}).initialize();
	await db.query("SELECT 1");
	// the pool's sockets would hold the process on their own: release them, leave the
	// adapter running
	await db.end();
} else {
	throw new Error(`Unknown adapter type "${type}"`);
}

console.log("READY");
