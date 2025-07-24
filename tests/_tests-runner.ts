// deno-lint-ignore-file no-explicit-any

import type pg from "pg";
import { createPg } from "./_pg.ts";
import { createKVClient } from "../src/kv.ts";
import type { AdapterMemory } from "../src/adapter/memory.ts";
import type { AdapterPostgres } from "../src/adapter/postgres.ts";

export function testsRunner(
	tests: {
		name: string;
		fn: (ctx: {
			dbPg: pg.Pool | pg.Client;
			clients: {
				memory: AdapterMemory;
				postgres: AdapterPostgres;
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
						const ns = "app:";

						const clients = {
							memory: createKVClient("memory", ns),
							postgres: createKVClient("postgres", ns, { db: dbPg }),
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
						}
				  }
		);
	}
}
