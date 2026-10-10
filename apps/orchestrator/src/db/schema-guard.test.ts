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

// Every temp folder a test made (one test opens two migrated databases).
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bsja-guard-"));
  dirs.push(dir);
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

  /**
   * A future migration that rebuilds `table` the way drizzle-kit does (create new, copy, drop,
   * rename, re-create its indexes), built from the live definition so it follows new columns.
   * `legacyAlter` gets past SQLite's trigger check on RENAME; `extra` runs at the end.
   */
  function rebuildMigration(table: string, opts: { legacyAlter?: boolean; extra?: string[] } = {}): string {
    const probe = openTestDb();
    const objects = probe.$client
      .prepare("SELECT type, sql FROM sqlite_master WHERE tbl_name = ? AND sql IS NOT NULL")
      .all(table) as { type: string; sql: string }[];
    probe.$client.close();
    const create = objects.find((o) => o.type === "table")!.sql;
    return [
      ...(opts.legacyAlter ? ["PRAGMA legacy_alter_table = ON"] : []),
      create.replace(new RegExp(`^CREATE TABLE [\`"]?${table}[\`"]?`), `CREATE TABLE \`__new_${table}\``),
      `INSERT INTO \`__new_${table}\` SELECT * FROM \`${table}\``,
      `DROP TABLE \`${table}\``,
      `ALTER TABLE \`__new_${table}\` RENAME TO \`${table}\``,
      ...objects.filter((o) => o.type === "index").map((o) => o.sql),
      ...(opts.legacyAlter ? ["PRAGMA legacy_alter_table = OFF"] : []),
      ...(opts.extra ?? []),
    ].join(";\n--> statement-breakpoint\n");
  }

  function openWithMigration(tag: string, sql: string): unknown {
    const base = tempDir();
    try {
      openDb(join(base, "app.db"), { migrationsFolder: migrationsWithExtra(base, tag, sql) }).$client.close();
    } catch (err) {
      return err;
    }
    return undefined;
  }

  it("a drizzle-kit rebuild of `applications` cannot even run: the triggers that name it stop the RENAME", () => {
    const err = openWithMigration("9999_rebuild_applications", rebuildMigration("applications"));
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error & { cause?: unknown }).cause ?? err)).toMatch(/error in trigger/);
  });

  it("fails closed when a rebuild of `applications` gets past that check and drops its triggers", () => {
    const err = openWithMigration("9999_rebuild_applications", rebuildMigration("applications", { legacyAlter: true }));
    expect(err).toBeInstanceOf(SchemaGuardError);
    const missing = (err as SchemaGuardError).missing;
    expect(missing.map((o) => o.name)).toEqual(
      expect.arrayContaining(["applications_no_delete_recorded", "applications_frozen_after_record", "applications_history_append_only"]),
    );
    // The index came back with the rebuild; only triggers went missing, all on applications.
    expect(missing.map((o) => o.name)).not.toContain("applications_job_uq");
    expect(missing.every((o) => o.type === "trigger" && o.table === "applications")).toBe(true);
  });

  it("a rebuild of `cv_versions` (e.g. a CHECK change) must re-create its trigger before openDb accepts it", () => {
    const err = openWithMigration("9999_rebuild_cv_versions", rebuildMigration("cv_versions"));
    expect(err).toBeInstanceOf(SchemaGuardError);
    expect((err as SchemaGuardError).missing).toEqual([
      { type: "trigger", name: "cv_versions_pdf_frozen_once_approved", table: "cv_versions" },
    ]);

    const probe = openTestDb();
    const trigger = (
      probe.$client.prepare("SELECT sql FROM sqlite_master WHERE name = 'cv_versions_pdf_frozen_once_approved'").get() as { sql: string }
    ).sql;
    probe.$client.close();
    expect(openWithMigration("9999_rebuild_cv_versions", rebuildMigration("cv_versions", { extra: [trigger] }))).toBeUndefined();
  });

  it("accepts a fully migrated database and keeps accepting it on every reopen", () => {
    const path = join(tempDir(), "app.db");
    openDb(path).$client.close();
    expect(() => openDb(path).$client.close()).not.toThrow();
  });
});
