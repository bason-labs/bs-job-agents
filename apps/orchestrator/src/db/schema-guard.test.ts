// PM phase 1, M4: openDb() refuses to start when a §9.1 trigger or the one-application-per-job
// index is missing, e.g. because a migration rebuilt a table (SQLite drops a table's triggers
// and indexes with it, silently).
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER, openDb, openTestDb } from "./client.js";
import { SchemaGuardError } from "./errors.js";
import { GUARDED_SCHEMA_OBJECTS } from "./schema-guard.js";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function tempDir(): string {
  dir = mkdtempSync(join(tmpdir(), "bsja-guard-"));
  return dir;
}

/** The bundled migrations plus one extra (a "future" migration written in a test). */
function migrationsWithExtra(base: string, tag: string, sql: string): string {
  const folder = join(base, "migrations");
  cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
  };
  const last = journal.entries.at(-1)!;
  journal.entries.push({ ...last, idx: last.idx + 1, when: last.when + 1000, tag });
  writeFileSync(journalPath, JSON.stringify(journal));
  writeFileSync(join(folder, `${tag}.sql`), sql);
  return folder;
}

describe("the guarded schema objects (PM M4)", () => {
  it("lists the eight §9.1 triggers and the one-application-per-job index", () => {
    const listed = GUARDED_SCHEMA_OBJECTS.map((o) => `${o.type} ${o.name} on ${o.table}`);
    expect(listed).toEqual(
      expect.arrayContaining([
        "trigger submissions_no_update on submissions",
        "trigger submissions_no_delete on submissions",
        "trigger job_snapshots_no_update on job_snapshots",
        "trigger job_snapshots_no_delete on job_snapshots",
        "trigger applications_no_delete_recorded on applications",
        "trigger applications_frozen_after_record on applications",
        "trigger applications_history_append_only on applications",
        "trigger approvals_single_use on approvals",
        "index applications_job_uq on applications",
      ]),
    );
  });

  it("covers every trigger the migrations create, so a new trigger cannot go unguarded", () => {
    const db = openTestDb();
    const triggers = (
      db.$client.prepare("SELECT name, tbl_name AS tbl FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all() as {
        name: string;
        tbl: string;
      }[]
    ).map((t) => `${t.name} on ${t.tbl}`);
    db.$client.close();
    const guarded = GUARDED_SCHEMA_OBJECTS.filter((o) => o.type === "trigger").map((o) => `${o.name} on ${o.table}`);
    expect(triggers.length).toBeGreaterThanOrEqual(8);
    expect([...guarded].sort()).toEqual(triggers);
  });
});

describe("openDb refuses to start without the guarded objects (PM M4)", () => {
  it.each(GUARDED_SCHEMA_OBJECTS.map((o) => [`${o.type} ${o.name}`, o] as const))(
    "throws SchemaGuardError when the %s is missing",
    (_label, object) => {
      const path = join(tempDir(), "app.db");
      const db = openDb(path);
      db.$client.exec(`DROP ${object.type.toUpperCase()} \`${object.name}\``);
      db.$client.close();

      let caught: unknown;
      try {
        openDb(path).$client.close();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(SchemaGuardError);
      const err = caught as SchemaGuardError;
      expect(err.missing).toEqual([object]);
      expect(err.message).toContain(object.name);
    },
  );

  it("fails closed after a future migration rebuilds `applications` the way drizzle-kit does", () => {
    // Build the rebuild from the live definition, so the test follows future columns.
    const probe = openTestDb();
    const objects = probe.$client
      .prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = 'applications' AND sql IS NOT NULL")
      .all() as { type: string; name: string; sql: string }[];
    probe.$client.close();
    const table = objects.find((o) => o.type === "table")!.sql;
    const indexes = objects.filter((o) => o.type === "index").map((o) => o.sql);
    const rebuild = [
      table.replace("CREATE TABLE `applications`", "CREATE TABLE `__new_applications`"),
      "INSERT INTO `__new_applications` SELECT * FROM `applications`",
      "DROP TABLE `applications`",
      "ALTER TABLE `__new_applications` RENAME TO `applications`",
      ...indexes,
    ].join(";\n--> statement-breakpoint\n");

    const base = tempDir();
    const migrationsFolder = migrationsWithExtra(base, "9999_rebuild_applications", rebuild);
    let caught: unknown;
    try {
      openDb(join(base, "app.db"), { migrationsFolder }).$client.close();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SchemaGuardError);
    const missing = (caught as SchemaGuardError).missing.map((o) => o.name);
    expect(missing).toEqual(
      expect.arrayContaining(["applications_no_delete_recorded", "applications_frozen_after_record", "applications_history_append_only"]),
    );
    // The index came back with the rebuild; only triggers went missing, all on applications.
    expect(missing).not.toContain("applications_job_uq");
    expect((caught as SchemaGuardError).missing.every((o) => o.type === "trigger" && o.table === "applications")).toBe(true);
  });

  it("accepts a fully migrated database and keeps accepting it on every reopen", () => {
    const path = join(tempDir(), "app.db");
    openDb(path).$client.close();
    expect(() => openDb(path).$client.close()).not.toThrow();
  });
});
