import { createKVClient } from "../src/kv.ts";
import { sleep } from "../src/utils/sleep.ts";
import { testsRunner } from "./_tests-runner.ts";
import { assert, assertEquals } from "@std/assert";

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
				assertEquals(await client.delete("not-existing"), false);
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
					{ type: "delete", key: "asdf" }, // false
				]);

				assertEquals(
					res,
					[true, { hey: "ho" }, true, true, false],
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
				// skip redis here...
				if (_type === "redis") continue;

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
]);
