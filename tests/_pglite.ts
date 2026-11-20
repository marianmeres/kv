import { after } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Driver } from "@marianmeres/sqlkit";
import { createPgliteDriver } from "@marianmeres/sqlkit/pglite";

// PGlite is Postgres compiled to WebAssembly: a database in this process, in memory,
// with nothing to install or connect to. The postgres adapter runs on it through a
// sqlkit Driver.

let shared: Promise<Driver> | undefined;

/**
 * The test file's one PGlite, as a sqlkit `Driver`. Starting one takes about half a
 * second, and each test drops and creates its own table, so the file shares it.
 */
export function sharedPglite(): Promise<Driver> {
	shared ??= createPglite();
	return shared;
}

/** A PGlite of its own, for a test that ends what it built: `driver.close()`. */
export async function createPglite(): Promise<Driver> {
	return createPgliteDriver(await PGlite.create());
}

// registered while the file loads, so it runs once, after the file's last test
after(async () => {
	await (await shared)?.close();
});
