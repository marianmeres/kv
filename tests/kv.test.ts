import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createKVClient } from "../src/kv.ts";
import { sleep } from "../src/utils/sleep.ts";
import { createRedis } from "./_redis.ts";
import { testsRunner } from "./_tests-runner.ts";

const k = "foo:bar";
const v = "baz";

testsRunner([
	{
		name: "info sanity check",
		fn({ clients }) {
			for (const [type, client] of Object.entries(clients)) {
				assert.deepEqual(client.info().type, type);
			}
		},
		// only: true,
	},
	{
		name: "basic set/get works",
		async fn({ clients }) {
			for (const [_type, client] of Object.entries(clients)) {
				assert(await client.set(k, v));
				assert.deepEqual(await client.get(k), v);
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
				assert.deepEqual(await client.get(k), v);
				assert.deepEqual((await client.ttl(k)).state, "no-ttl");
				assert.deepEqual(await client.exists(k), true);
				assert.deepEqual(await client.exists("asdf"), false);
				assert.deepEqual(await client.keys("*"), ["foo:bar", "hey"]);
				assert.deepEqual(await client.keys("foo:*"), ["foo:bar"]);
				// console.log(1234, await client.__debug_dump());

				// clear some
				assert.deepEqual(await client.clear("foo:*"), 1);
				assert.deepEqual(await client.clear("not-existing:*"), 0);
				assert.deepEqual(await client.keys("*"), ["hey"]);
				assert.deepEqual(await client.get(k), null);
				// console.log(await client.__debug_dump());

				assert.deepEqual(await client.clear("*"), 1);
				assert.deepEqual(await client.keys("*"), []);

				// set + delete
				assert(await client.set(k, v));
				assert.deepEqual(await client.delete(k), true);
				assert.deepEqual(await client.delete("not-existing"), false);

				assert.deepEqual(await client.clear("*"), 0);

				await client.set(k, v);
				await client.set("user:123:foo", "bar");
				await client.set("user:456:foo", "baz");
				await client.set("user:789:foo", "bat");

				assert.deepEqual(await client.keys("*"), [
					"foo:bar",
					"user:123:foo",
					"user:456:foo",
					"user:789:foo",
				]);
				assert.deepEqual(await client.keys("user:456:*"), ["user:456:foo"]);
				assert.deepEqual(await client.clear("user:*"), 3);
				assert.deepEqual(await client.keys("*"), ["foo:bar"]);
				//
				assert.deepEqual(await client.clear("user:*"), 0);
				assert.deepEqual(await client.clear("user:*"), 0);
				assert.deepEqual(await client.clear("user:*"), 0);
			}
		},
		// only: true,
	},
	{
		name: "set complex object",
		async fn({ clients }) {
			for (const [_type, client] of Object.entries(clients)) {
				assert(await client.set(k, { hey: { ho: { lets: "go" } } }));
				assert.deepEqual(await client.get(k), { hey: { ho: { lets: "go" } } });

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
				assert.deepEqual(await client.get("undef"), null);
				// console.log(await client.__debug_dump());
			}
		},
		// only: true,
	},
	{
		name: "expiration works",
		async fn({ clients }) {
			for (const [_type, client] of Object.entries(clients)) {
				const now = Date.now();
				await client.set(k, v, { ttl: 1 }); // 1 sec
				assert.deepEqual(await client.get(k), v);
				const t = await client.ttl(k);
				assert(t.state === "expires" && t.at.valueOf() > now + 999);

				await sleep(1_001);

				// must be expired now
				assert.deepEqual(await client.get(k), null);
				assert.deepEqual(await client.keys("*"), []);
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
				assert.deepEqual(await client.keys("user:*"), [
					"user:123:foo",
					"user:456:foo",
				]);

				assert.deepEqual(await client.getMultiple([k, "user:456:foo"]), {
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

				assert.deepEqual(
					res,
					[true, { hey: "ho" }, true, true],
					`(Type: ${_type})`,
				);
				assert.deepEqual(await client.keys("foo:*"), ["foo:2"]);
				// console.log(await client.__debug_dump());
			}
		},
		// only: true,
	},
	{
		name: "cleanup works",
		async fn({ clients }) {
			for (const [_type, _client] of Object.entries(clients)) {
				// skip redis here...
				if (_type === "redis") continue;

				const client = createKVClient("", _type as any, {
					defaultTtl: 1,
					ttlCleanupIntervalSec: 1,
					db: _client.options.db,
				});
				// destroy even on a failed assertion: a live cleanup timer keeps the test
				// process from exiting, and the run hangs instead of failing
				try {
					await client.initialize();
					await client.set(k, v);

					// The cleanup clock starts at initialize(), not at set(), so the key
					// (expiring 1s after set) can miss the first tick by a millisecond and
					// wait for the second, up to 2s after set.
					await sleep(2_500);

					// "missing" means expired-or-gone (ttl-related, not cleanup)
					assert.deepEqual((await client.ttl(k)).state, "missing");

					// if not cleaned up, it wouldn't be empty
					assert.deepEqual(await client.__debug_dump(), {});
				} finally {
					await client.destroy();
				}
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
				assert.deepEqual(got.f, false, `(${_type}) false should round-trip`);
				assert.deepEqual(got.z, 0, `(${_type}) 0 should round-trip`);
				assert.deepEqual(got.s, "", `(${_type}) empty string should round-trip`);
				assert.deepEqual(got.n, null, `(${_type}) null should round-trip`);
				assert.deepEqual(got.missing, null, `(${_type}) missing -> null`);
			}
		},
	},
	{
		name: "B4: exists() returns true for stored null",
		async fn({ clients }) {
			for (const [_type, client] of Object.entries(clients)) {
				await client.set("nullish", null);
				assert.deepEqual(
					await client.exists("nullish"),
					true,
					`(${_type}) key with null value must still exist`,
				);
				assert.deepEqual(
					await client.exists("never-set"),
					false,
					`(${_type}) missing key must not exist`,
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

				assert.deepEqual(
					await client.keys("*"),
					["a.1", "a.2", "b1"],
					`(${_type}) keys must be sorted`,
				);

				// "." in the pattern is a literal, not a regex wildcard
				assert.deepEqual(
					(await client.keys("a.*")).toSorted(),
					["a.1", "a.2"],
					`(${_type}) dot is literal`,
				);

				// "a?1" matches "a.1" (? = any single char), not "b1"
				const q = (await client.keys("a?1")).toSorted();
				assert.deepEqual(q, ["a.1"], `(${_type}) ? is single-char wildcard`);
			}
		},
	},
	{
		name: "B6: ttl:0 explicitly disables expiration (overrides defaultTtl)",
		async fn({ clients }) {
			for (const [_type, _client] of Object.entries(clients)) {
				const client = createKVClient("app2:", _type as any, {
					defaultTtl: 60,
					db: _client.options.db,
				});
				await client.initialize();

				try {
					// implicit -> uses defaultTtl
					await client.set("a", "x");
					const tA = await client.ttl("a");
					assert.deepEqual(
						tA.state,
						"expires",
						`(${_type}) defaultTtl should apply`,
					);

					// explicit ttl:0 -> no expiration
					await client.set("b", "x", { ttl: 0 });
					const tB = await client.ttl("b");
					assert.deepEqual(
						tB.state,
						"no-ttl",
						`(${_type}) ttl:0 must disable expiration`,
					);
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
			assert.deepEqual(underscores, ["under_score"]);

			// "%" in the pattern should match ONLY literal "%", not any chars
			const percents = await client.keys("with%pct");
			assert.deepEqual(percents, ["with%pct"]);
		},
	},
	{
		name: "B2: transaction() honors per-op TTL",
		async fn({ clients }) {
			for (const [_type, client] of Object.entries(clients)) {
				await client.transaction([
					{ type: "set", key: "tx:ttl", value: "v", options: { ttl: 120 } },
				]);
				const t = await client.ttl("tx:ttl");
				assert(
					t.state === "expires",
					`(${_type}) transaction must honor options.ttl`,
				);
				// within a few seconds of now + 120s
				const diff = t.at.valueOf() - Date.now();
				assert(
					diff > 100_000 && diff < 130_000,
					`(${_type}) expected ~120s, got ${diff}ms`,
				);
			}
		},
	},
	{
		name: "B1: postgres transaction rolls back on error",
		async fn({ clients }) {
			const client = clients.postgres;
			const longKey = "x".repeat(600); // exceeds VARCHAR(512)

			await assert.rejects(
				() =>
					client.transaction([
						{ type: "set", key: "rollback:good", value: "keep-me" },
						{ type: "set", key: longKey, value: "boom" },
					]),
				Error,
			);

			// The first set must have been rolled back with the second's failure.
			assert.deepEqual(
				await client.get("rollback:good"),
				null,
				"postgres transaction must roll back prior set on error",
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
			assert(
				p && typeof (p as any).then === "function",
				"get() must return a Promise",
			);
			const v = await p;
			assert.deepEqual(v, { a: 1 });
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
				assert.deepEqual(Object.keys(dumpA).toSorted(), ["alpha", "beta"]);

				const dumpB = await b.__debug_dump();
				assert.deepEqual(Object.keys(dumpB), ["gamma"]);
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
				`Each transaction must observe its own set: ${JSON.stringify(results)}`,
			);

			// Also verify the Pool is not leaking clients (idle count returns to baseline).
			await sleep(50);
			const pool = dbPg as any;
			if (typeof pool.totalCount === "number") {
				assert(
					pool.totalCount < 10,
					`pool should not leak: totalCount=${pool.totalCount}`,
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
			assert(!dbB.isOpen, "adapter-opened connection must be closed on destroy");
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
				assert.deepEqual(after, before, "error listener must not stack");
			} finally {
				await client.destroy();
				if (db.isOpen) await db.destroy();
			}
		},
	},

	// ─── v2.1: atomic primitives ──────────────────────────────────────────

	{
		name: "setIfAbsent: sets when missing, refuses when present",
		async fn({ clients }) {
			for (const [_type, client] of Object.entries(clients)) {
				await client.clear("*");
				assert.deepEqual(
					await client.setIfAbsent("lock", "a"),
					true,
					`(${_type}) first set must succeed`,
				);
				assert.deepEqual(
					await client.setIfAbsent("lock", "b"),
					false,
					`(${_type}) second set must fail`,
				);
				assert.deepEqual(
					await client.get("lock"),
					"a",
					`(${_type}) value must not have been overwritten`,
				);
			}
		},
	},
	{
		name: "setIfAbsent: replaces expired keys",
		async fn({ clients }) {
			for (const [_type, client] of Object.entries(clients)) {
				await client.clear("*");
				await client.set("exp", "old", { ttl: 1 });
				await sleep(1_100);
				assert.deepEqual(
					await client.setIfAbsent("exp", "new"),
					true,
					`(${_type}) setIfAbsent should succeed on expired key`,
				);
				assert.deepEqual(await client.get("exp"), "new");
			}
		},
	},
	{
		name: "setIfAbsent: concurrent — exactly one wins",
		async fn({ clients }) {
			for (const [_type, client] of Object.entries(clients)) {
				await client.clear("*");
				const N = 50;
				const results = await Promise.all(
					Array.from({ length: N }, (_, i) => client.setIfAbsent("winner", i)),
				);
				const wins = results.filter(Boolean).length;
				assert.deepEqual(
					wins,
					1,
					`(${_type}) expected exactly one winner, got ${wins}`,
				);
			}
		},
	},
	{
		name: "incr/decr: basic semantics",
		async fn({ clients }) {
			for (const [_type, client] of Object.entries(clients)) {
				await client.clear("*");

				// missing key -> creates with delta
				assert.deepEqual(await client.incr("c"), 1, `(${_type}) initial incr`);
				assert.deepEqual(await client.incr("c"), 2);
				assert.deepEqual(await client.incr("c", 5), 7);
				assert.deepEqual(await client.decr("c"), 6);
				assert.deepEqual(await client.decr("c", 3), 3);
				assert.deepEqual(await client.get("c"), 3);
			}
		},
	},
	{
		name: "incr: rejects non-numeric values",
		async fn({ clients }) {
			for (const [_type, client] of Object.entries(clients)) {
				await client.clear("*");
				await client.set("s", "hello");
				await assert.rejects(
					() => client.incr("s"),
					{ name: "TypeError", message: /not a number/ },
					`(${_type}) incr on string must throw TypeError`,
				);
			}
		},
	},
	{
		name: "incr: 100 parallel increments sum correctly",
		async fn({ clients }) {
			for (const [_type, client] of Object.entries(clients)) {
				await client.clear("*");
				const N = 100;
				await Promise.all(
					Array.from({ length: N }, () => client.incr("counter")),
				);
				assert.deepEqual(
					await client.get("counter"),
					N,
					`(${_type}) ${N} parallel increments should sum to ${N}`,
				);
			}
		},
	},
	{
		name: "getSet: returns previous value and replaces",
		async fn({ clients }) {
			for (const [_type, client] of Object.entries(clients)) {
				await client.clear("*");

				// missing -> null; now stored as new
				assert.deepEqual(
					await client.getSet("k", 1),
					null,
					`(${_type}) getSet missing returns null`,
				);
				assert.deepEqual(await client.get("k"), 1);

				// existing -> previous value
				assert.deepEqual(await client.getSet("k", 2), 1);
				assert.deepEqual(await client.get("k"), 2);

				// falsy round-trip
				await client.set("zero", 0);
				assert.deepEqual(await client.getSet("zero", "x"), 0);
				await client.set("empty", "");
				assert.deepEqual(await client.getSet("empty", "x"), "");
				await client.set("falseFlag", false);
				assert.deepEqual(await client.getSet("falseFlag", "x"), false);
			}
		},
	},
	{
		name: "cas: swap on match, no-op on mismatch, always false on missing",
		async fn({ clients }) {
			for (const [_type, client] of Object.entries(clients)) {
				await client.clear("*");

				// missing key -> always false, even expected null
				assert.deepEqual(
					await client.cas("x", null, "new"),
					false,
					`(${_type}) missing key must fail cas even with expected=null`,
				);

				await client.set("x", "a");

				// mismatch -> no swap
				assert.deepEqual(await client.cas("x", "z", "b"), false);
				assert.deepEqual(await client.get("x"), "a");

				// match -> swap
				assert.deepEqual(await client.cas("x", "a", "b"), true);
				assert.deepEqual(await client.get("x"), "b");

				// complex values: deep-equal
				await client.set("obj", { n: 1 });
				assert.deepEqual(await client.cas("obj", { n: 1 }, { n: 2 }), true);
				assert.deepEqual(await client.cas("obj", { n: 1 }, { n: 3 }), false);
				assert.deepEqual(await client.get("obj"), { n: 2 });
			}
		},
	},

	// ─── v2.2: quality-of-life ───────────────────────────────────────────

	{
		name: "keysIter: iterates matching keys",
		async fn({ clients }) {
			for (const [_type, client] of Object.entries(clients)) {
				await client.clear("*");
				await client.set("a", 1);
				await client.set("b", 2);
				await client.set("c", 3);

				const collected: string[] = [];
				for await (const k of client.keysIter("*")) {
					collected.push(k);
				}
				assert.deepEqual(
					collected.toSorted(),
					["a", "b", "c"],
					`(${_type}) keysIter must yield all matches`,
				);
			}
		},
	},
	{
		name: "keysIter: early break does not leak resources",
		async fn({ clients, dbPg }) {
			const client = clients.postgres;
			await client.clear("*");
			// Insert 30 keys
			await client.setMultiple(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));

			// Open 20 iterators, break out of each after 1 yield
			for (let i = 0; i < 20; i++) {
				for await (const _ of client.keysIter("*")) {
					break;
				}
			}

			// Pool must not have ballooned
			await sleep(50);
			const pool = dbPg as any;
			if (typeof pool.totalCount === "number") {
				assert(
					pool.totalCount < 10,
					`pool should not leak on early break: totalCount=${pool.totalCount}`,
				);
			}
		},
	},
	{
		name: "setMultiple: per-pair ttl overrides batch ttl",
		async fn({ clients }) {
			for (const [_type, client] of Object.entries(clients)) {
				await client.clear("*");

				await client.setMultiple(
					[["long", "v"], { key: "short", value: "v", ttl: 2 }],
					{ ttl: 300 },
				);

				const tLong = await client.ttl("long");
				const tShort = await client.ttl("short");

				assert(
					tLong.state === "expires" &&
						tLong.at.valueOf() > Date.now() + 200_000,
					`(${_type}) batch TTL should apply to "long"`,
				);
				assert(
					tShort.state === "expires" &&
						tShort.at.valueOf() < Date.now() + 5_000,
					`(${_type}) per-pair ttl=2s should override batch ttl for "short"`,
				);
			}
		},
	},
	{
		name: "setMultiple: legacy tuple input still works",
		async fn({ clients }) {
			for (const [_type, client] of Object.entries(clients)) {
				await client.clear("*");
				await client.setMultiple([
					["a", 1],
					["b", 2],
				]);
				assert.deepEqual(await client.get("a"), 1, `(${_type})`);
				assert.deepEqual(await client.get("b"), 2, `(${_type})`);
			}
		},
	},
	{
		name: "validateKeys: empty/null-char/oversize rejected by default",
		async fn({ clients }) {
			for (const [_type, client] of Object.entries(clients)) {
				await assert.rejects(
					() => client.set("", "v"),
					{ name: "TypeError", message: /non-empty/ },
					`(${_type}) empty key must throw`,
				);
				await assert.rejects(
					() => client.set("bad\0key", "v"),
					{ name: "TypeError", message: /null characters/ },
					`(${_type}) null-char key must throw`,
				);
				await assert.rejects(
					() => client.set("x".repeat(600), "v"),
					{ name: "RangeError", message: /512-char/ },
					`(${_type}) oversize key must throw`,
				);
			}
		},
	},
	{
		name: "validateKeys: false opts out of validation",
		async fn({ clients }) {
			// only memory: empty key can be stored when validation is off
			const db = clients.memory.options.db;
			const c = createKVClient("opt:", "memory", {
				db,
				validateKeys: false,
			});
			await c.initialize();
			try {
				// should not throw (though storing "" as a key is odd, it's the caller's problem)
				await c.set("ok", "v");
				assert.deepEqual(await c.get("ok"), "v");
			} finally {
				await c.destroy();
			}
		},
	},
	{
		name: "feature matrix: every public method is implemented on every adapter",
		async fn({ clients }) {
			const methods = [
				"set",
				"setIfAbsent",
				"getSet",
				"incr",
				"decr",
				"cas",
				"get",
				"delete",
				"exists",
				"keys",
				"keysIter",
				"clear",
				"setMultiple",
				"getMultiple",
				"transaction",
				"expire",
				"ttl",
				"info",
			];
			for (const [type, client] of Object.entries(clients)) {
				for (const m of methods) {
					assert(
						typeof (client as any)[m] === "function",
						`(${type}) missing method: ${m}`,
					);
				}
			}
		},
	},

	// ─── v3.0 regression: TtlResult state coverage ────────────────────────

	{
		name: "ttl(): covers all three states",
		async fn({ clients }) {
			for (const [_type, client] of Object.entries(clients)) {
				await client.clear("*");

				// missing
				assert.deepEqual((await client.ttl("ghost")).state, "missing");

				// existing, no ttl
				await client.set("plain", "v");
				assert.deepEqual(
					(await client.ttl("plain")).state,
					"no-ttl",
					`(${_type}) set without ttl should be no-ttl`,
				);

				// existing, with ttl
				await client.set("tick", "v", { ttl: 60 });
				const t = await client.ttl("tick");
				assert(
					t.state === "expires" && t.at instanceof Date,
					`(${_type}) ttl-bearing key should be "expires"`,
				);
			}
		},
	},

	// ─── v3.1: sqlite adapter ─────────────────────────────────────────────

	{
		name: "keys() is case-sensitive",
		async fn({ clients }) {
			for (const [_type, client] of Object.entries(clients)) {
				await client.set("abc", 1);
				await client.set("Abc", 2);
				assert.deepEqual(await client.keys("a*"), ["abc"], `(${_type})`);
				assert.deepEqual(await client.keys("A*"), ["Abc"], `(${_type})`);
			}
		},
	},
	{
		name: "expired keys read as missing in every primitive",
		async fn({ clients }) {
			for (const [_type, client] of Object.entries(clients)) {
				await client.clear("*");
				// expire(k, -1) leaves a row already past its expiry in the SQL
				// adapters — the not-yet-cleaned state — without sleeping
				for (const key of ["g", "i", "gs", "sia", "c"]) {
					await client.set(key, 41);
					await client.expire(key, -1);
				}
				assert.deepEqual(await client.get("g"), null, `(${_type}) get`);
				assert.deepEqual(await client.exists("g"), false, `(${_type}) exists`);
				assert.deepEqual((await client.ttl("g")).state, "missing", `(${_type})`);
				assert.deepEqual(await client.keys("*"), [], `(${_type}) keys`);

				assert.deepEqual(await client.incr("i"), 1, `(${_type}) incr restarts`);
				assert.deepEqual(
					(await client.ttl("i")).state,
					"no-ttl",
					`(${_type}) incr must not inherit the expired row's ttl`,
				);
				assert.deepEqual(await client.getSet("gs", 1), null, `(${_type}) getSet`);
				assert.deepEqual(await client.setIfAbsent("sia", 1), true, `(${_type})`);
				assert.deepEqual(await client.cas("c", 41, 42), false, `(${_type}) cas`);
			}
		},
	},
	{
		name: "sqlite: keys/clear treat [ and namespace wildcards as literals",
		async fn({ clients }) {
			const client = clients.sqlite;
			await client.set("a[b]c", 1);
			await client.set("abc", 2);
			// unescaped, GLOB would read [b] as a character class matching "abc"
			assert.deepEqual(await client.keys("a[b]c"), ["a[b]c"]);
			assert.deepEqual(await client.keys("a[*"), ["a[b]c"]);

			// the namespace is a literal prefix: "n*:" must not reach into "nX:"
			const { db } = client.options;
			const star = createKVClient("n*:", "sqlite", { db });
			const plain = createKVClient("nX:", "sqlite", { db });
			await star.initialize();
			await plain.initialize();
			await star.set("k", 1);
			await plain.set("k", 2);
			assert.deepEqual(await star.keys("*"), ["k"]);
			assert.deepEqual(await star.clear("*"), 1);
			assert.deepEqual(await plain.get("k"), 2);
		},
	},
	{
		name: "sqlite: transaction rolls back on error",
		async fn({ clients }) {
			const client = clients.sqlite;
			await assert.rejects(
				() =>
					client.transaction([
						{ type: "set", key: "rollback:good", value: "keep-me" },
						{ type: "set", key: "x".repeat(600), value: "boom" },
					]),
				RangeError,
			);
			assert.deepEqual(await client.get("rollback:good"), null);
			assert(!client.options.db.isTransaction, "no transaction may be left open");
		},
	},
	{
		name: "sqlite: joins a transaction the caller opened on the same handle",
		async fn({ clients }) {
			const client = clients.sqlite;
			const { db } = client.options;

			// the caller's ROLLBACK undoes the adapter's writes, atomic ones included
			db.exec("BEGIN");
			await client.set("a", 1);
			assert.deepEqual(await client.getSet("a", 2), 1);
			await client.incr("n");
			await client.setMultiple([["b", 1]]);
			db.exec("ROLLBACK");
			assert.deepEqual(await client.keys("*"), []);

			// a failed kv transaction undoes only itself; the caller's stays open
			db.exec("BEGIN");
			await client.set("keep", 1);
			await assert.rejects(
				() =>
					client.transaction([
						{ type: "set", key: "gone", value: 1 },
						{ type: "set", key: "", value: 1 },
					]),
				TypeError,
			);
			assert(db.isTransaction, "the caller's transaction must still be open");
			db.exec("COMMIT");
			assert.deepEqual(await client.keys("*"), ["keep"]);
		},
	},
	{
		name: "sqlite: keysIter pages past the page size",
		async fn({ clients }) {
			const client = clients.sqlite;
			const pad = (i: number) => String(i).padStart(4, "0");
			const a = Array.from({ length: 1000 }, (_, i) => `a:${pad(i)}`);
			const b = Array.from({ length: 3 }, (_, i) => `b:${pad(i)}`);
			await client.setMultiple([...a, ...b].map((k) => [k, 1]));

			// exactly two full pages, then an empty one
			const seenA: string[] = [];
			for await (const k of client.keysIter("a:*")) seenA.push(k);
			assert.deepEqual(seenA, a);

			// two full pages and a partial one
			const seenAll: string[] = [];
			for await (const k of client.keysIter("*")) seenAll.push(k);
			assert.deepEqual(seenAll, [...a, ...b]);
		},
	},
	{
		name: "sqlite: persists to a file across handles; validates options",
		raw: true,
		async fn() {
			assert.throws(() => createKVClient("x:", "sqlite", {}), /Missing sqlite/);

			const dir = mkdtempSync(join(tmpdir(), "kv-sqlite-"));
			const path = join(dir, "kv.db");
			try {
				const db1 = new DatabaseSync(path);
				assert.throws(
					() =>
						createKVClient("x:", "sqlite", { db: db1, tableName: "main.kv" }),
					/Invalid tableName/,
				);
				const c1 = createKVClient("x:", "sqlite", { db: db1, tableName: "kv" });
				await c1.initialize();
				await c1.set("k", { v: 1 }, { ttl: 60 });
				await c1.destroy();
				assert(db1.isOpen, "destroy() must leave the caller's handle open");
				db1.close();

				const db2 = new DatabaseSync(path);
				const c2 = createKVClient("x:", "sqlite", { db: db2, tableName: "kv" });
				await c2.initialize();
				assert.deepEqual(await c2.get("k"), { v: 1 });
				assert.deepEqual((await c2.ttl("k")).state, "expires");
				await c2.destroy();
				db2.close();
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	},
]);
