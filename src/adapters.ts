import pg from "pg";
import type { ServiceConfig } from "./config.js";
export function createPostgresPool(config: ServiceConfig) {
  return new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
  });
}
