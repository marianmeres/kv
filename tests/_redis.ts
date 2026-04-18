import { createClient } from "redis";

const REDIS_URL = Deno.env.get("TEST_REDIS_URL") || "redis://localhost:6379/13";

export function createRedis() {
	return createClient({ url: REDIS_URL });
}
