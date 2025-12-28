/**
 * @module
 *
 * Key-value storage abstraction layer with support for multiple backend adapters.
 *
 * This module provides a unified API for key-value operations across different storage backends:
 * - **memory** - In-memory storage (default, not persisted)
 * - **redis** - Redis server
 * - **postgres** - PostgreSQL database
 * - **deno-kv** - Deno KV (Deno runtime only)
 *
 * @example
 * ```typescript
 * import { createKVClient } from "@marianmeres/kv";
 *
 * // Create an in-memory client
 * const client = createKVClient("myapp:", "memory");
 * await client.initialize();
 *
 * // Basic operations
 * await client.set("user:123", { name: "John" });
 * const user = await client.get("user:123");
 * await client.delete("user:123");
 *
 * // Pattern matching
 * const keys = await client.keys("user:*");
 * await client.clear("session:*");
 *
 * // Cleanup
 * await client.destroy();
 * ```
 */

export * from "./kv.ts";
