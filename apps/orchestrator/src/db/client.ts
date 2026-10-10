import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database, { type RunResult } from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import * as schema from "./schema.js";
import { assertGuardedSchema } from "./schema-guard.js";

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

/**
 * Apply pending migrations. SQLite can only change CHECK / NOT NULL by rebuilding a
 * table (create new, copy, drop old, rename), and that recipe needs foreign keys OFF:
 * with them on, DROP TABLE fails on referenced rows or fires ON DELETE CASCADE on child
 * rows. `PRAGMA foreign_keys` is a no-op inside the migrator's transaction, so it is
 * switched here, around the whole migration, followed by `foreign_key_check`.
 */
function runMigrations(client: Database.Database, db: Db, migrationsFolder: string): void {
  client.pragma("foreign_keys = OFF");
  try {
    migrate(db, { migrationsFolder });
    const broken = client.pragma("foreign_key_check") as unknown[];
    if (broken.length > 0) {
      throw new Error(`database has ${broken.length} broken foreign key reference(s): ${JSON.stringify(broken.slice(0, 5))}`);
    }
  } finally {
    client.pragma("foreign_keys = ON");
  }
}

/**
 * Migrate, then check that every guarded trigger and index exists (PM M4). On any failure
 * the connection is closed and the error is rethrown, so the orchestrator does not start.
 */
function wrap(client: Database.Database, options: OpenDbOptions): Db {
  try {
    const db = drizzle(client, { schema }) as Db;
    runMigrations(client, db, options.migrationsFolder ?? MIGRATIONS_FOLDER);
    assertGuardedSchema(client);
    return db;
  } catch (err) {
    client.close();
    throw err;
  }
}

/**
 * Open (creating if needed) the SQLite database at `path` with WAL, foreign keys
 * and a busy timeout, then apply pending migrations. Typically `data/app.db`.
 * Throws SchemaGuardError (and does not open) if a §9.1 trigger or the
 * one-application-per-job index is missing after migrating.
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
