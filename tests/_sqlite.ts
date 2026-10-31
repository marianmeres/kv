import { DatabaseSync } from "node:sqlite";

export function createSqlite() {
	return new DatabaseSync(":memory:");
}
