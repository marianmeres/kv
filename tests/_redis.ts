import process from "node:process";
import { createClient } from "redis";

const REDIS_URL = process.env.TEST_REDIS_URL || "redis://localhost:6379/13";

export function createRedis() {
	return createClient({ url: REDIS_URL });
}
