import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database, { type RunResult } from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import * as schema from "./schema.js";

export type Schema = typeof schema;
export type Db = BetterSQLite3Database<Schema> & { $client: Database.Database };
/**
 * What repository functions accept: the Drizzle handle or a transaction from
 * `db.transaction(tx => …)`, so callers can compose several repository calls
 * atomically.
 */
export type Conn = BaseSQLiteDatabase<"sync", RunResult, Schema>;

/** apps/orchestrator/drizzle (same relative path from src/db and dist/db). */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

export const BUSY_TIMEOUT_MS = 5000;

export interface OpenDbOptions {
  /** Defaults to the bundled migrations folder. */
  migrationsFolder?: string;
}

function configure(client: Database.Database, inMemory: boolean): void {
  if (!inMemory) client.pragma("journal_mode = WAL");
  client.pragma("foreign_keys = ON");
  client.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  client.pragma("synchronous = NORMAL");
}

function wrap(client: Database.Database, options: OpenDbOptions): Db {
  const db = drizzle(client, { schema }) as Db;
  migrate(db, { migrationsFolder: options.migrationsFolder ?? MIGRATIONS_FOLDER });
  return db;
}

/**
 * Open (creating if needed) the SQLite database at `path` with WAL, foreign keys
 * and a busy timeout, then apply pending migrations. Typically `data/app.db`.
 */
export function openDb(path: string, options: OpenDbOptions = {}): Db {
  mkdirSync(dirname(path), { recursive: true });
  const client = new Database(path);
  configure(client, false);
  return wrap(client, options);
}

/** In-memory database with every migration applied, for tests. */
export function openTestDb(options: OpenDbOptions = {}): Db {
  const client = new Database(":memory:");
  configure(client, true);
  return wrap(client, options);
}
