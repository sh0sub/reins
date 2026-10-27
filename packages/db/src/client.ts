import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "./schema.ts";

export type ReinsDb = ReturnType<typeof drizzle<typeof schema>>;

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), "../drizzle");

/** Opens a libsql database. ":memory:" for tests, "file:./.local/reins.db" locally. */
export function createDb(url = process.env.DATABASE_URL ?? "file:./.local/reins.db"): ReinsDb {
  if (url.startsWith("file:")) {
    mkdirSync(dirname(url.slice("file:".length)), { recursive: true });
  }
  const client = createClient({ url });
  return drizzle(client, { schema });
}

/** Applies drizzle migrations. Bundlers (Next.js) should pass the folder explicitly. */
export async function migrateDb(db: ReinsDb, migrationsFolder = process.env.REINS_MIGRATIONS_DIR ?? MIGRATIONS): Promise<void> {
  await migrate(db, { migrationsFolder });
}

/** In-memory database with migrations applied. */
export async function createTestDb(): Promise<ReinsDb> {
  const db = createDb(":memory:");
  await migrateDb(db);
  return db;
}
