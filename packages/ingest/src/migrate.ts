import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { migrate as migrateDir } from "@alerting/config";

const DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

/** Create the `events` table (reuses the config package's migration runner and its schema_migrations table). */
export function migrate(pool: Pool): Promise<string[]> {
  return migrateDir(pool, DIR);
}
