// deno-lint-ignore-file no-explicit-any

import type pg from "pg";
import { createPg } from "./_pg.ts";
import { createKVClient } from "../src/kv.ts";
import type { AdapterMemory } from "../src/adapter/memory.ts";
import type { AdapterPostgres } from "../src/adapter/postgres.ts";
import type { AdapterRedis } from "../src/adapter/redis.ts";
import type { AdapterDenoKv } from "../src/adapter/deno-kv.ts";
import { createRedis } from "./_redis.ts";

export function testsRunner(
	tests: {
		name: string;
		fn: (ctx: {
			dbPg: pg.Pool | pg.Client;
			clients: {
				memory: AdapterMemory;
				postgres: AdapterPostgres;
				redis: AdapterRedis;
				"deno-kv": AdapterDenoKv;
			};
		}) => void | Promise<void>;
		only?: boolean;
		ignore?: boolean;
		raw?: boolean;
	}[]
) {
	for (const def of tests) {
		const { name, ignore, only } = def;
		if (typeof def.fn !== "function") continue;
		Deno.test(
			{ name, ignore, only },
			def.raw
				? () => def.fn({ dbPg: null as any, clients: null as any })
				: async () => {
						const dbPg = await createPg();

						// redis init
						const dbRedis = await createRedis();
						await dbRedis.connect();
						// flushDb is often disabled on shared Redis instances;
						// delete keys via SCAN + UNLINK scoped to this test run instead
						{
							const stale: string[] = [];
							let cursor = "0";
							do {
								const r = await dbRedis.scan(cursor, {
									MATCH: "*",
									COUNT: 500,
								});
								cursor = `${r.cursor}`;
								stale.push(...r.keys.map((k: unknown) => String(k)));
							} while (cursor !== "0");
							if (stale.length > 0) await dbRedis.unlink(stale);
						}

						//
						const dbDenoKv = await Deno.openKv(":memory:");

						const ns = "app:";

						const clients = {
							memory: createKVClient(ns, "memory"),
							postgres: createKVClient(ns, "postgres", { db: dbPg }),
							redis: createKVClient(ns, "redis", { db: dbRedis }),
							"deno-kv": createKVClient(ns, "deno-kv", { db: dbDenoKv }),
						};

						for (const client of Object.values(clients)) {
							await client.destroy(true);
							await client.initialize();
						}

						try {
							await def.fn({ dbPg, clients });
						} catch (e) {
							throw e;
						} finally {
							for (const client of Object.values(clients)) {
								await client.destroy();
							}
							await dbPg?.end();
							await dbRedis?.destroy();
							await dbDenoKv?.close();
						}
				  }
		);
	}
}
