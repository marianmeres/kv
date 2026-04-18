import { createKVClient } from "../src/kv.ts";
import { sleep } from "../src/utils/sleep.ts";
import { testsRunner } from "./_tests-runner.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { createRedis } from "./_redis.ts";

const k = "foo:bar";
const v = "baz";

testsRunner([
	{
		name: "info sanity check",
		fn({ clients }) {
			for (const [type, client] of Object.entries(clients)) {
				assertEquals(client.info().type, type);
			}
		},
		// only: true,
	},
	{
		name: "basic set/get works",
		async fn({ clients }) {
			for (const [_type, client] of Object.entries(clients)) {
				assert(await client.set(k, v));
				assertEquals(await client.get(k), v);
				// console.log(_type, await client.get(k));
			}
		},
		// only: true,
	},
	{
		name: "basics work",
		async fn({ clients }) {
			for (const [_type, client] of Object.entries(clients)) {
				// if (_type !== "redis") continue;
				assert(await client.set(k, v));
				assert(await client.set("hey", "ho"));
				assertEquals(await client.get(k), v);
				assertEquals(await client.ttl(k), null);
				assertEquals(await client.exists(k), true);
				assertEquals(await client.exists("asdf"), false);
				assertEquals(await client.keys("*"), ["foo:bar", "hey"]);
				assertEquals(await client.keys("foo:*"), ["foo:bar"]);
				// console.log(1234, await client.__debug_dump());

				// clear some
				assertEquals(await client.clear("foo:*"), 1);
				assertEquals(await client.clear("not-existing:*"), 0);
				assertEquals(await client.keys("*"), ["hey"]);
				assertEquals(await client.get(k), null);
				// console.log(await client.__debug_dump());

				assertEquals(await client.clear("*"), 1);
				assertEquals(await client.keys("*"), []);

				// set + delete
				assert(await client.set(k, v));
				assertEquals(await client.delete(k), true);

				if (_type !== "deno-kv") {
					assertEquals(await client.delete("not-existing"), false);
				}

				assertEquals(await client.clear("*"), 0);

				await client.set(k, v);
				await client.set("user:123:foo", "bar");
				await client.set("user:456:foo", "baz");
				await client.set("user:789:foo", "bat");

				assertEquals(await client.keys("*"), [
					"foo:bar",
					"user:123:foo",
					"user:456:foo",
					"user:789:foo",
				]);
				assertEquals(await client.keys("user:456:*"), ["user:456:foo"]);
				assertEquals(await client.clear("user:*"), 3);
				assertEquals(await client.keys("*"), ["foo:bar"]);
				//
				assertEquals(await client.clear("user:*"), 0);
				assertEquals(await client.clear("user:*"), 0);
				assertEquals(await client.clear("user:*"), 0);
			}
		},
		// only: true,
	},
	{
		name: "set complex object",
		async fn({ clients }) {
			for (const [_type, client] of Object.entries(clients)) {
				assert(await client.set(k, { hey: { ho: { lets: "go" } } }));
				assertEquals(await client.get(k), { hey: { ho: { lets: "go" } } });

				// console.log(await client.__debug_dump());
			}
		},
		// only: true,
	},
	{
		name: "set undefined get null",
		async fn({ clients }) {
			for (const [_type, client] of Object.entries(clients)) {
				// undef is returned as null
				await client.set("undef", undefined);
				assertEquals(await client.get("undef"), null);
				// console.log(await client.__debug_dump());
			}
		},
		// only: true,
	},
	{
		name: "expiration works",
		async fn({ clients }) {
			for (const [_type, client] of Object.entries(clients)) {
				// this is not supported in deno.kv
				if (["deno-kv"].includes(_type)) continue;

				const now = Date.now();
				await client.set(k, v, { ttl: 1 }); // 1 sec
				assertEquals(await client.get(k), v);
				assert(((await client.ttl(k)) as Date).valueOf() > now + 999);

				await sleep(1_001);

				// must be expired now
				assertEquals(await client.get(k), null);
				assertEquals(await client.keys("*"), []);
				// console.log(await client.__debug_dump());
			}
		},
		// only: true,
	},
	{
		name: "set/get multiple works",
		async fn({ clients }) {
			for (const [_type, client] of Object.entries(clients)) {
				await client.set(k, v);
				await client.setMultiple([
					["user:123:foo", "bar"],
					["user:456:foo", "baz"],
				]);

				// console.log(await client.__debug_dump());
				assertEquals(await client.keys("user:*"), [
					"user:123:foo",
					"user:456:foo",
				]);

				assertEquals(await client.getMultiple([k, "user:456:foo"]), {
					"foo:bar": "baz",
					"user:456:foo": "baz",
				});
			}
		},
		// only: true,
	},
	{
		name: "transaction works",
		async fn({ clients }) {
			for (const [_type, client] of Object.entries(clients)) {
				const res = await client.transaction([
					{ type: "set", key: "foo:1", value: { hey: "ho" } },
					{ type: "get", key: "foo:1" },
					{ type: "set", key: "foo:2", value: "baz" },
					{ type: "delete", key: "foo:1" },
				]);

				assertEquals(
					res,
					[true, { hey: "ho" }, true, true],
					`(Type: ${_type})`
				);
				assertEquals(await client.keys("foo:*"), ["foo:2"]);
				// console.log(await client.__debug_dump());
			}
		},
		// only: true,
	},
	{
		name: "cleanup works",
		async fn({ clients }) {
			for (const [_type, _client] of Object.entries(clients)) {
				// skip redis and deno here...
				if (["redis", "deno-kv"].includes(_type)) continue;

				const client = createKVClient("", _type as any, {
					defaultTtl: 1,
					ttlCleanupIntervalSec: 1,
					db: _client.options.db,
				});
				await client.initialize();
				await client.set(k, v);

				await sleep(1_010);

				// "false" means expired (but this is ttl related, not cleanup)
				assertEquals(await client.ttl(k), false);

				// if not cleaned up, it wouldn't be empty
				assertEquals(await client.__debug_dump(), {});

				await client.destroy();
			}
		},
		// only: true,
	},
	{
		name: "deno kv playground",
		async fn({ clients }) {
			for (const [_type, client] of Object.entries(clients)) {
				if (_type !== "deno-kv") continue;

				// set/get
				assert(await client.set(k, { foo: "bar" }));
				assertEquals((await client.get(k)).foo, "bar");

				// always null - not supported in Deno.Kv
				assertEquals(await client.ttl(k), null);

				//
				assert(await client.exists(k));
				assert(!(await client.exists("asdf")));

				assertEquals(await client.keys("foo:*"), [k]);

				//
				assert(await client.delete(k));
				assert(!(await client.exists(k)));

				// true even for non-existent key
				assert(await client.delete("asdf"));
			}
		},
		// only: true,
	},
	{
		name: "B3: getMultiple preserves falsy stored values",
		async fn({ clients }) {
			for (const [_type, client] of Object.entries(clients)) {
				await client.set("f", false);
				await client.set("z", 0);
				await client.set("s", "");
				await client.set("n", null);

				const got = await client.getMultiple(["f", "z", "s", "n", "missing"]);
				assertEquals(got.f, false, `(${_type}) false should round-trip`);
				assertEquals(got.z, 0, `(${_type}) 0 should round-trip`);
				assertEquals(got.s, "", `(${_type}) empty string should round-trip`);
				assertEquals(got.n, null, `(${_type}) null should round-trip`);
				assertEquals(got.missing, null, `(${_type}) missing -> null`);
			}
		},
	},
	{
		name: "B4: exists() returns true for stored null",
		async fn({ clients }) {
			for (const [_type, client] of Object.entries(clients)) {
				await client.set("nullish", null);
				assertEquals(
					await client.exists("nullish"),
					true,
					`(${_type}) key with null value must still exist`
				);
				assertEquals(
					await client.exists("never-set"),
					false,
					`(${_type}) missing key must not exist`
				);
			}
		},
	},
	{
		name: "B5/B8: keys() is sorted and literal regex/glob metachars are respected",
		async fn({ clients }) {
			for (const [_type, client] of Object.entries(clients)) {
				// Redis doesn't allow . ( ) [ ] in glob the same way, but all
				// adapters must treat these as literals in their key names.
				await client.set("a.1", 1);
				await client.set("a.2", 2);
				await client.set("b1", 3);

				assertEquals(
					await client.keys("*"),
					["a.1", "a.2", "b1"],
					`(${_type}) keys must be sorted`
				);

				// "." in the pattern is a literal, not a regex wildcard
				assertEquals(
					(await client.keys("a.*")).toSorted(),
					["a.1", "a.2"],
					`(${_type}) dot is literal`
				);

				// "a?1" matches "a.1" (? = any single char), not "b1"
				const q = (await client.keys("a?1")).toSorted();
				assertEquals(q, ["a.1"], `(${_type}) ? is single-char wildcard`);
			}
		},
	},
	{
		name: "B6: ttl:0 explicitly disables expiration (overrides defaultTtl)",
		async fn({ clients }) {
			for (const [_type, _client] of Object.entries(clients)) {
				if (_type === "deno-kv") continue; // ttl() not supported

				const client = createKVClient("app2:", _type as any, {
					defaultTtl: 60,
					db: _client.options.db,
				});
				await client.initialize();

				try {
					// implicit -> uses defaultTtl
					await client.set("a", "x");
					const tA = await client.ttl("a");
					assert(tA instanceof Date, `(${_type}) defaultTtl should apply`);

					// explicit ttl:0 -> no expiration
					await client.set("b", "x", { ttl: 0 });
					const tB = await client.ttl("b");
					assertEquals(tB, null, `(${_type}) ttl:0 must disable expiration`);
				} finally {
					await client.clear("*");
					await client.destroy();
				}
			}
		},
	},
	{
		name: "B7: postgres keys/clear treat literal % and _ as literals",
		async fn({ clients }) {
			const client = clients.postgres;
			await client.set("under_score", 1);
			await client.set("under-score", 2);
			await client.set("with%pct", 3);
			await client.set("withXpct", 4);

			// "_" in the pattern should match ONLY literal "_", not any char
			const underscores = await client.keys("under_score");
			assertEquals(underscores, ["under_score"]);

			// "%" in the pattern should match ONLY literal "%", not any chars
			const percents = await client.keys("with%pct");
			assertEquals(percents, ["with%pct"]);
		},
	},
	{
		name: "B2: transaction() honors per-op TTL",
		async fn({ clients }) {
			for (const [_type, client] of Object.entries(clients)) {
				if (_type === "deno-kv") continue; // ttl() not queryable

				await client.transaction([
					{ type: "set", key: "tx:ttl", value: "v", options: { ttl: 120 } },
				]);
				const t = await client.ttl("tx:ttl");
				assert(
					t instanceof Date,
					`(${_type}) transaction must honor options.ttl`
				);
				// within a few seconds of now + 120s
				const diff = (t as Date).valueOf() - Date.now();
				assert(
					diff > 100_000 && diff < 130_000,
					`(${_type}) expected ~120s, got ${diff}ms`
				);
			}
		},
	},
	{
		name: "B1: postgres transaction rolls back on error",
		async fn({ clients }) {
			const client = clients.postgres;
			const longKey = "x".repeat(600); // exceeds VARCHAR(512)

			await assertRejects(
				() =>
					client.transaction([
						{ type: "set", key: "rollback:good", value: "keep-me" },
						{ type: "set", key: longKey, value: "boom" },
					]),
				Error
			);

			// The first set must have been rolled back with the second's failure.
			assertEquals(
				await client.get("rollback:good"),
				null,
				"postgres transaction must roll back prior set on error"
			);
		},
	},
	{
		name: "B9: memory get() returns a real Promise",
		async fn({ clients }) {
			const client = clients.memory;
			await client.set("p", { a: 1 });
			const p = client.get("p");
			// Must be Promise-chainable — not a raw object
			assert(p && typeof (p as any).then === "function", "get() must return a Promise");
			const v = await p;
			assertEquals(v, { a: 1 });
		},
	},
	{
		name: "B11: redis __debug_dump is scoped to namespace",
		async fn() {
			// Two independent adapters with different namespaces but sharing
			// the same underlying Redis DB.
			const dbA = await createRedis();
			await dbA.connect();

			const dbB = await createRedis();
			await dbB.connect();

			const a = createKVClient("nsA:", "redis", { db: dbA });
			const b = createKVClient("nsB:", "redis", { db: dbB });
			await a.initialize();
			await b.initialize();

			try {
				await a.clear("*");
				await b.clear("*");

				await a.set("alpha", 1);
				await a.set("beta", 2);
				await b.set("gamma", 3);

				const dumpA = await a.__debug_dump();
				assertEquals(Object.keys(dumpA).toSorted(), ["alpha", "beta"]);

				const dumpB = await b.__debug_dump();
				assertEquals(Object.keys(dumpB), ["gamma"]);
			} finally {
				await a.clear("*");
				await b.clear("*");
				await a.destroy();
				await b.destroy();
				if (dbA.isOpen) await dbA.destroy();
				if (dbB.isOpen) await dbB.destroy();
			}
		},
	},
	{
		name: "B1: postgres transactions isolate on a Pool",
		async fn({ clients, dbPg }) {
			const client = clients.postgres;

			// Two concurrent transactions writing to the same key on the same Pool.
			// On a broken implementation, queries within a tx could hop connections
			// and one tx's intermediate state could leak into the other.
			const results = await Promise.all([
				client.transaction([
					{ type: "set", key: "iso:k", value: "a" },
					{ type: "get", key: "iso:k" },
				]),
				client.transaction([
					{ type: "set", key: "iso:k", value: "b" },
					{ type: "get", key: "iso:k" },
				]),
			]);

			// Each transaction must observe its own write inside the read.
			assert(
				(results[0][1] === "a" && results[1][1] === "b") ||
					(results[0][1] === "b" && results[1][1] === "a"),
				`Each transaction must observe its own set: ${JSON.stringify(results)}`
			);

			// Also verify the Pool is not leaking clients (idle count returns to baseline).
			await sleep(50);
			const pool = dbPg as any;
			if (typeof pool.totalCount === "number") {
				assert(
					pool.totalCount < 10,
					`pool should not leak: totalCount=${pool.totalCount}`
				);
			}
		},
	},
	{
		name: "B10: redis adapter owns only connections it opened",
		async fn() {
			// Case A: caller pre-opens — adapter must NOT close on destroy.
			const dbA = await createRedis();
			await dbA.connect();
			const a = createKVClient("own1:", "redis", { db: dbA });
			await a.initialize();
			await a.set("k", "v");
			await a.destroy();
			assert(dbA.isOpen, "caller-owned connection must remain open after destroy");
			await dbA.destroy();

			// Case B: adapter opens — adapter MUST close on destroy.
			const dbB = await createRedis();
			const b = createKVClient("own2:", "redis", { db: dbB });
			await b.initialize();
			assert(dbB.isOpen, "adapter should have opened the connection");
			await b.destroy();
			assert(
				!dbB.isOpen,
				"adapter-opened connection must be closed on destroy"
			);
		},
	},
	{
		name: "D12: redis initialize() does not stack error listeners",
		async fn() {
			const db = await createRedis();
			await db.connect();
			const client = createKVClient("listener:", "redis", { db });

			try {
				await client.initialize();
				const before = db.listenerCount?.("error") ?? 0;
				// Re-initialize a few times — listener count must not grow.
				await client.initialize();
				await client.initialize();
				await client.initialize();
				const after = db.listenerCount?.("error") ?? 0;
				assertEquals(after, before, "error listener must not stack");
			} finally {
				await client.destroy();
				if (db.isOpen) await db.destroy();
			}
		},
	},
]);
