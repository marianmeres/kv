import assert from "node:assert/strict";
import process from "node:process";
import { type Driver, SqlError } from "@marianmeres/sqlkit";
import { createPgDriver } from "@marianmeres/sqlkit/pg";
import { openSqlite } from "@marianmeres/sqlkit/sqlite";
import pg from "pg";
import type { AdapterPostgres } from "../src/adapter/postgres.ts";
import { type AdapterAbstract, createKVClient, type Operation } from "../src/kv.ts";
import { sleep } from "../src/utils/sleep.ts";
import { createPg } from "./_pg.ts";
import { createPglite } from "./_pglite.ts";
import { testsRunner } from "./_tests-runner.ts";

// The postgres adapter's `db` as a pool, a client or a sqlkit Driver, over node-postgres
// and over PGlite, and the sqlite adapter's `db` as a sqlkit Driver the host built. Every
// case is raw: it builds what it needs, uses its own table, touches no Redis, and ends
// what it built.

const TABLE = "_kv_driver_test";

async function connectPgClient(): Promise<pg.Client> {
	const client = new pg.Client({
		host: process.env.TEST_PG_HOST || "localhost",
		user: process.env.TEST_PG_USER,
		database: process.env.TEST_PG_DATABASE,
		password: process.env.TEST_PG_PASSWORD,
		port: parseInt(process.env.TEST_PG_PORT || "5432", 10),
	});
	await client.connect();
	return client;
}

/** The name of what `p` rejected with, or "no error". */
async function errName(p: Promise<unknown>): Promise<string> {
	try {
		await p;
		return "no error";
	} catch (e) {
		return (e as Error)?.name;
	}
}

/** One fixed run of operations; the answers are compared across adapters. */
async function exercise(c: AdapterAbstract): Promise<[string, unknown][]> {
	const out: [string, unknown][] = [];
	const push = async (label: string, p: Promise<unknown>) => {
		out.push([label, await p]);
	};
	const state = async (key: string) => (await c.ttl(key)).state;

	await c.clear("*");
	await push("set a", c.set("a", { x: 1, y: [1, "two", null] }));
	await push("get a", c.get("a"));
	await push("exists a", c.exists("a"));
	await push("set undefined", c.set("u", undefined));
	await push("get u", c.get("u"));
	await push("set null", c.set("n", null));
	await push("exists n", c.exists("n"));
	await push("setIfAbsent a", c.setIfAbsent("a", 2));
	await push("setIfAbsent b", c.setIfAbsent("b", 2));
	await push("get b", c.get("b"));
	await push("getSet b", c.getSet("b", 3));
	await push("getSet missing", c.getSet("gs", "x"));
	await push("incr c", c.incr("c"));
	await push("incr c 5", c.incr("c", 5));
	await push("decr c 2", c.decr("c", 2));
	await push("incr non-number", errName(c.incr("a")));
	await push("cas missing", c.cas("x", null, "new"));
	await push("set x", c.set("x", "a"));
	await push("cas mismatch", c.cas("x", "z", "b"));
	await push("cas match", c.cas("x", "a", "b"));
	await push("get x", c.get("x"));
	await push("set obj", c.set("obj", { n: 1 }));
	await push("cas obj", c.cas("obj", { n: 1 }, { n: 2 }));
	await push(
		"setMultiple",
		c.setMultiple([["m1", 1], { key: "m2", value: false, ttl: 60 }], { ttl: 300 }),
	);
	await push("getMultiple", c.getMultiple(["m1", "m2", "nope"]));
	await push("ttl m1", state("m1"));
	await push("ttl nope", state("nope"));
	await push("ttl a", state("a"));
	await push("expire a", c.expire("a", 60));
	await push("expire nope", c.expire("nope", 60));
	await push("ttl a after expire", state("a"));
	await push("set e", c.set("e", 41));
	await push("expire e -1", c.expire("e", -1));
	await push("get expired", c.get("e"));
	await push("exists expired", c.exists("e"));
	await push("incr expired", c.incr("e"));
	await push("ttl after incr", state("e"));
	await push("set 50%_x", c.set("50%_x", 1));
	await push("set 50abc", c.set("50abc", 1));
	await push("keys 50%*", c.keys("50%*"));
	await push("keys m?", c.keys("m?"));
	await push("keys *", c.keys("*"));
	await push(
		"transaction",
		c.transaction([
			{ type: "set", key: "t1", value: { n: 1 } },
			{ type: "get", key: "t1" },
			{ type: "set", key: "t2", value: [1, 2], options: { ttl: 60 } },
			{ type: "delete", key: "x" },
			{ type: "get", key: "x" },
			{ type: "delete", key: "x" },
		]),
	);
	await push("get t1 after transaction", c.get("t1"));
	await push("ttl t2 after transaction", state("t2"));
	const walked: string[] = [];
	for await (const key of c.keysIter("*")) walked.push(key);
	out.push(["keysIter *", walked.toSorted()]); // its order is not part of the contract
	await push("delete a", c.delete("a"));
	await push("delete a again", c.delete("a"));
	await push("clear m*", c.clear("m*"));
	await push("keys * after clear", c.keys("*"));
	await push("oversize key", errName(c.set("x".repeat(600), 1)));
	return out;
}

/** What `exercise()` answers on the memory adapter: the reference. */
async function reference(): Promise<[string, unknown][]> {
	const memory = createKVClient("p:", "memory");
	await memory.initialize();
	try {
		return await exercise(memory);
	} finally {
		await memory.destroy();
	}
}

/**
 * Operations issued inside a transaction the host opened on the shared `Driver` are part
 * of it: its rollback takes them, its commit keeps them.
 */
async function assertJoins(driver: Driver, kv: AdapterAbstract): Promise<void> {
	const boom = new Error("the host rolls back");
	await assert.rejects(
		driver.transaction(async () => {
			await kv.set("joined", 1);
			await kv.transaction([{ type: "set", key: "nested", value: 1 }]);
			throw boom;
		}),
		(e) => e === boom,
	);
	assert.equal(await kv.get("joined"), null);
	assert.equal(await kv.get("nested"), null);

	await driver.transaction(async () => {
		await kv.set("kept", 1);
	});
	assert.equal(await kv.get("kept"), 1);
}

/**
 * A kv `transaction()` that fails inside the host's transaction is undone alone, and the
 * host's transaction goes on and commits. `failsInDatabase` is a second unit that fails
 * there, past kv's own checks, and asserts how: each database has its own.
 */
async function assertUndoneAlone(
	driver: Driver,
	kv: AdapterAbstract,
	failsInDatabase: (kv: AdapterAbstract) => Promise<void>,
): Promise<void> {
	await driver.transaction(async () => {
		await kv.set("before", 1);

		// fails before it reaches the database: an invalid key
		await assert.rejects(
			kv.transaction([
				{ type: "set", key: "a", value: 1 },
				{ type: "set", key: "", value: 2 },
			]),
			{ name: "TypeError" },
		);

		await failsInDatabase(kv);

		// the host's transaction goes on
		await kv.transaction([{ type: "set", key: "c", value: 1 }]);
		await kv.set("after", 1);
	});

	assert.deepEqual(await kv.getMultiple(["before", "a", "b", "c", "after"]), {
		before: 1,
		a: null,
		b: null,
		c: 1,
		after: 1,
	});
}

/**
 * PostgreSQL refuses the unit's second statement (jsonb refuses \u0000 inside a string),
 * which without a savepoint would abort the host's transaction.
 */
async function refusedByPostgres(kv: AdapterAbstract): Promise<void> {
	const refused = await kv
		.transaction([
			{ type: "set", key: "b", value: 1 },
			{ type: "set", key: "nul", value: "a\u0000b" },
		])
		.then(
			() => undefined,
			(e: unknown) => e,
		);
	assert.ok(refused instanceof SqlError, `got ${String(refused)}`);
	assert.equal(refused.code, "22P05");
}

/**
 * SQLite refuses nothing kv sends inside a unit, and a refused statement would not end
 * the transaction anyway: the unit that fails there after reading is an `incr` on a
 * string.
 */
async function incrOnAString(kv: AdapterAbstract): Promise<void> {
	await kv.set("s", "text");
	await assert.rejects(kv.incr("s"), {
		name: "TypeError",
		message: "KV value is not a number",
	});
}

/**
 * `incr`/`decr` on a value that is not a number rejects with a `TypeError` and fails no
 * statement, so the host's transaction it ran in goes on and commits.
 */
async function assertIncrKeepsTransaction(
	driver: Driver,
	kv: AdapterAbstract,
): Promise<void> {
	await kv.set("s", "text");
	await driver.transaction(async () => {
		await kv.set("before", 1);
		const notANumber = { name: "TypeError", message: "KV value is not a number" };
		await assert.rejects(kv.incr("s"), notANumber);
		await assert.rejects(kv.decr("s"), notANumber);
		await kv.set("after", 1);
	});
	assert.deepEqual(await kv.getMultiple(["before", "s", "after"]), {
		before: 1,
		s: "text",
		after: 1,
	});
}

testsRunner([
	{
		name: "driver: a sqlkit Driver built by the host answers as the memory adapter does",
		raw: true,
		async fn() {
			const pool = createPg();
			const driver = createPgDriver(pool);
			const kv = createKVClient("p:", "postgres", { db: driver, tableName: TABLE });
			try {
				await kv.destroy(true);
				await kv.initialize();
				assert.deepEqual(await exercise(kv), await reference());
			} finally {
				await kv.destroy(true);
				await pool.end();
			}
		},
	},
	{
		name: "driver: one pg.Client answers as the memory adapter does",
		raw: true,
		async fn() {
			const client = await connectPgClient();
			const kv = createKVClient("p:", "postgres", { db: client, tableName: TABLE });
			try {
				await kv.destroy(true);
				await kv.initialize();
				assert.deepEqual(await exercise(kv), await reference());
			} finally {
				await kv.destroy(true);
				await client.end();
			}
		},
	},
	{
		name: "driver: on one pg.Client a write issued during transaction() is kept",
		raw: true,
		async fn() {
			const client = await connectPgClient();
			const kv = createKVClient("x:", "postgres", { db: client, tableName: TABLE });
			try {
				await kv.destroy(true);
				await kv.initialize();
				const ops: Operation[] = Array.from({ length: 40 }, (_, i) => ({
					type: "set",
					key: `t${i}`,
					value: i,
				}));
				ops.push({ type: "set", key: "", value: "boom" }); // rejects: all of it rolls back
				const settled = kv.transaction(ops).then(
					() => "resolved",
					(e: unknown) => e,
				);
				await sleep(2); // the transaction is in flight now
				assert.equal(await kv.set("outside", 1), true);
				const outcome = await settled;
				assert.ok(outcome instanceof TypeError, `got ${String(outcome)}`);
				assert.equal(await kv.get("outside"), 1);
				assert.equal(await kv.get("t0"), null);
			} finally {
				await kv.destroy(true);
				await client.end();
			}
		},
	},
	{
		name: "driver: operations join the transaction the host opened on the shared Driver",
		raw: true,
		async fn() {
			const pool = createPg();
			const driver = createPgDriver(pool);
			const kv = createKVClient("x:", "postgres", { db: driver, tableName: TABLE });
			try {
				await kv.destroy(true);
				await kv.initialize();

				await assertJoins(driver, kv);
			} finally {
				await kv.destroy(true);
				await pool.end();
			}
		},
	},
	{
		name: "driver: transaction() inside the host's transaction is undone alone",
		raw: true,
		async fn() {
			const pool = createPg();
			const driver = createPgDriver(pool);
			const kv = createKVClient("x:", "postgres", { db: driver, tableName: TABLE });
			try {
				await kv.destroy(true);
				await kv.initialize();

				await assertUndoneAlone(driver, kv, refusedByPostgres);
			} finally {
				await kv.destroy(true);
				await pool.end();
			}
		},
	},
	{
		name: "driver: a sqlkit Driver over PGlite answers as the memory adapter does",
		raw: true,
		async fn() {
			const driver = await createPglite();
			const kv = createKVClient("p:", "postgres", { db: driver, tableName: TABLE });
			try {
				await kv.initialize();
				assert.deepEqual(await exercise(kv), await reference());
			} finally {
				await kv.destroy(true);
				await driver.close();
			}
		},
	},
	{
		name: "driver: on PGlite, operations join the host's transaction and transaction() is undone alone",
		raw: true,
		async fn() {
			const driver = await createPglite();
			const kv = createKVClient("x:", "postgres", { db: driver, tableName: TABLE });
			try {
				await kv.initialize();
				await assertJoins(driver, kv);
				await assertUndoneAlone(driver, kv, refusedByPostgres);
			} finally {
				await kv.destroy(true);
				await driver.close();
			}
		},
	},
	{
		name: "driver: incr on a non-number leaves the host's transaction usable",
		raw: true,
		async fn() {
			const pool = createPg();
			const lite = await createPglite();
			try {
				for (const driver of [createPgDriver(pool), lite]) {
					const kv = createKVClient("x:", "postgres", {
						db: driver,
						tableName: TABLE,
					});
					try {
						await kv.destroy(true);
						await kv.initialize();
						await assertIncrKeepsTransaction(driver, kv);
					} finally {
						await kv.destroy(true);
					}
				}
			} finally {
				await lite.close();
				await pool.end();
			}
		},
	},
	{
		name: "driver: a Driver without savepoint() is refused",
		raw: true,
		fn() {
			// what a sqlkit older than 0.3.0 built, passed past the type
			const old = {
				dialect: "pg",
				adapter: "stub",
				capabilities: {},
				query() {},
				exec() {},
				transaction() {},
			};
			assert.throws(
				() =>
					createKVClient("x:", "postgres", {
						db: old as any,
						tableName: TABLE,
					}),
				{ name: "TypeError", message: /sqlkit 0\.3\.0 or newer/ },
			);
		},
	},
	{
		name: "driver: one driver per pool, however many adapters share it",
		raw: true,
		async fn() {
			const pool = createPg();
			const adapters: AdapterPostgres[] = [];
			try {
				assert.equal(pool.listenerCount("error"), 0);
				for (const ns of ["a:", "b:", "c:"]) {
					adapters.push(
						createKVClient(ns, "postgres", { db: pool, tableName: TABLE }),
					);
				}
				assert.equal(pool.listenerCount("error"), 1);

				for (const kv of adapters) await kv.initialize();
				await Promise.all(adapters.map((kv, i) => kv.set("k", i)));
				for (const [i, kv] of adapters.entries()) {
					assert.equal(await kv.get("k"), i);
				}
			} finally {
				for (const kv of adapters) await kv.destroy(true);
				await pool.end();
			}
		},
	},
	{
		name: "driver: destroy() never closes what the host passed",
		raw: true,
		async fn() {
			const pool = createPg();
			const driver = createPgDriver(pool);
			const client = await connectPgClient();
			try {
				for (const db of [pool, driver, client]) {
					const kv = createKVClient("x:", "postgres", { db, tableName: TABLE });
					await kv.initialize();
					await kv.set("k", 1);
					await kv.destroy();
					await kv.destroy(true);
				}
				assert.equal((await pool.query("SELECT 1 AS one")).rows[0]?.one, 1);
				assert.equal((await driver.query("select 1 as one")).rows[0]?.one, 1);
				assert.equal((await client.query("SELECT 1 AS one")).rows[0]?.one, 1);
			} finally {
				await client.end();
				await pool.end();
			}
		},
	},
	{
		name: "driver: a driver of another dialect is refused",
		raw: true,
		async fn() {
			const lite = openSqlite();
			try {
				assert.throws(
					() =>
						createKVClient("x:", "postgres", { db: lite, tableName: TABLE }),
					{
						name: "TypeError",
						message: /runs on PostgreSQL: got a "sqlite" driver/,
					},
				);
			} finally {
				await lite.close();
			}
		},
	},
	{
		name: "driver: a statement the database refused rejects with a SqlError",
		raw: true,
		async fn() {
			const pool = createPg();
			const kv = createKVClient("x:", "postgres", { db: pool, tableName: TABLE });
			try {
				await kv.destroy(true);
				await kv.initialize();
				// jsonb refuses \u0000 inside a string
				const error = await kv.set("nul", "a\u0000b").then(
					() => undefined,
					(e: unknown) => e,
				);
				assert.ok(error instanceof SqlError, `got ${String(error)}`);
				assert.equal(error.code, "22P05");
				assert.ok(error.cause instanceof Error);
			} finally {
				await kv.destroy(true);
				await pool.end();
			}
		},
	},

	// ─── the sqlite adapter on a sqlkit Driver the host built ─────────────────────────
	{
		name: "driver: a sqlite Driver built by the host answers as the memory adapter does",
		raw: true,
		async fn() {
			const driver = openSqlite();
			const kv = createKVClient("p:", "sqlite", { db: driver, tableName: TABLE });
			try {
				await kv.initialize();
				assert.deepEqual(await exercise(kv), await reference());
			} finally {
				await kv.destroy(true);
				await driver.close();
			}
		},
	},
	{
		name: "driver: on a sqlite Driver, operations join the host's transaction and a failed unit is undone alone",
		raw: true,
		async fn() {
			const driver = openSqlite();
			const kv = createKVClient("x:", "sqlite", { db: driver, tableName: TABLE });
			try {
				await kv.initialize();
				await assertJoins(driver, kv);
				await assertUndoneAlone(driver, kv, incrOnAString);
			} finally {
				await kv.destroy(true);
				await driver.close();
			}
		},
	},
	{
		name: "driver: on a sqlite Driver, a call from elsewhere waits for the host's transaction and does not go with its rollback",
		raw: true,
		async fn() {
			const driver = openSqlite();
			const kv = createKVClient("x:", "sqlite", { db: driver, tableName: TABLE });
			try {
				await kv.initialize();
				await kv.set("n", 1);

				const order: string[] = [];
				const started = Promise.withResolvers<void>();
				const gate = Promise.withResolvers<void>();
				const boom = new Error("the host rolls back");
				const host = driver.transaction(async () => {
					await kv.set("h", 1); // issued inside: it goes with the rollback
					started.resolve();
					await gate.promise;
					order.push("host");
					throw boom;
				});
				await started.promise;

				// issued from outside the host's callback while its transaction is open: a
				// unit and a single statement
				const unit = kv.incr("n").then((v) => {
					order.push("unit");
					return v;
				});
				const single = kv.set("o", 1).then((v) => {
					order.push("single");
					return v;
				});
				await sleep(20);
				assert.deepEqual(order, [], "they must wait for the host's transaction");

				gate.resolve();
				await assert.rejects(host, (e) => e === boom);
				assert.equal(await unit, 2);
				assert.equal(await single, true);
				assert.equal(order[0], "host");
				assert.deepEqual(await kv.getMultiple(["h", "n", "o"]), {
					h: null,
					n: 2,
					o: 1,
				});
			} finally {
				await kv.destroy(true);
				await driver.close();
			}
		},
	},
	{
		name: "driver: the sqlite adapter refuses a Driver of another dialect, or one without a sync tier",
		raw: true,
		async fn() {
			const pool = createPg();
			try {
				assert.throws(
					() => createKVClient("x:", "sqlite", { db: createPgDriver(pool) }),
					{
						name: "TypeError",
						message:
							'The sqlite adapter runs on SQLite: got a "pg" driver (pg)',
					},
				);

				// sqlite drivers no sqlkit 0.3 builds, passed past the type
				const stub = {
					dialect: "sqlite",
					adapter: "stub",
					capabilities: {},
					query() {},
					exec() {},
					transaction() {},
					savepoint() {},
				};
				assert.throws(() => createKVClient("x:", "sqlite", { db: stub as any }), {
					name: "TypeError",
					message:
						/sync tier .*sqlkit 0\.3\.0 or newer: this one has no sync tier/,
				});
				const noSavepoint = { ...stub, savepoint: undefined, sync: {} };
				assert.throws(
					() => createKVClient("x:", "sqlite", { db: noSavepoint as any }),
					{ name: "TypeError", message: /this one has no savepoint\(\)/ },
				);
			} finally {
				await pool.end();
			}
		},
	},
	{
		name: "driver: destroy() never closes a sqlite Driver the host passed",
		raw: true,
		async fn() {
			const driver = openSqlite();
			try {
				const kv = createKVClient("x:", "sqlite", {
					db: driver,
					tableName: TABLE,
				});
				await kv.initialize();
				await kv.set("k", 1);
				await kv.destroy();
				await kv.destroy(true);
				assert.equal((await driver.query("select 1 as one")).rows[0]?.one, 1);
			} finally {
				await driver.close();
			}
		},
	},
]);
