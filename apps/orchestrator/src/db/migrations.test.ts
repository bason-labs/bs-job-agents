// Upgrading a database that already holds data (QA phase 1). Migration 0002 rebuilds
// tables (SQLite cannot alter CHECK or NOT NULL), so it must keep every row, map legacy
// literals to the shared ones, keep child rows (no cascade on DROP) and keep triggers.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER, openDb } from "./client.js";

/** A copy of the first `count` migrations, as the database looked before 0002. */
function legacyMigrations(dir: string, count: number): string {
  const folder = join(dir, "legacy-migrations");
  mkdirSync(join(folder, "meta"), { recursive: true });
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as {
    entries: { idx: number; tag: string }[];
  };
  journal.entries = journal.entries.filter((e) => e.idx < count);
  writeFileSync(join(folder, "meta", "_journal.json"), JSON.stringify(journal));
  for (const e of journal.entries) cpSync(join(MIGRATIONS_FOLDER, `${e.tag}.sql`), join(folder, `${e.tag}.sql`));
  return folder;
}

const T = "2026-10-10T08:00:00.000Z";

const LEGACY_ROWS = `
  INSERT INTO bots(name, display_name, engine, trust_level) VALUES ('cv', 'CV', 'claude', 2), ('research', 'Research', 'codex', 2);
  INSERT INTO companies(name, name_key) VALUES ('NovaPay', 'novapay');
  INSERT INTO jobs(source, url, canonical_url, dedupe_hash, title, company_id, location, language, jd_text, status, first_seen_at)
    VALUES ('itviec', 'https://itviec.com/j/1', 'https://itviec.com/j/1', 'h1', 'Senior FE', 1, 'Ho Chi Minh City', 'en', 'JD', 'applied', '${T}');
  INSERT INTO cv_versions(job_id, language, round, created_at) VALUES (1, 'EN', 1, '${T}'), (1, 'VI', 1, '${T}');
  INSERT INTO qa_reviews(cv_version_id, total, scores_json, hard_fails_json, fixes_json, passed, created_at)
    VALUES (1, 85, '{}', '[]', '[]', 1, '${T}');
  INSERT INTO approvals(token, job_id, cv_version_id, allowed_domains_json, expires_at, used_at, created_at)
    VALUES ('tok', 1, 1, '["itviec.com"]', '2026-10-11T08:00:00.000Z', '${T}', '${T}');
  INSERT INTO applications(job_id, cv_version_id, submitted_at, status, origin, status_history_json, created_at)
    VALUES (1, 1, '${T}', 'submitted', 'app', '[{"status":"submitted","at":"${T}"}]', '${T}');
  INSERT INTO submissions(application_id, fields_json, approval_token, submitted_at) VALUES (1, '[]', 'tok', '${T}');
  INSERT INTO job_snapshots(application_id, captured_at, url, title, company, jd_text) VALUES (1, '${T}', 'https://itviec.com/j/1', 'Senior FE', 'NovaPay', 'JD');
  INSERT INTO rooms(name, kind, bot_name, created_at) VALUES ('consult:cv', 'consult', 'cv', '${T}');
  INSERT INTO room_members(room_id, bot_name) VALUES (1, 'cv');
  INSERT INTO messages(room_id, author, text, mentions_json, run_refs_json, created_at) VALUES (1, 'ba', 'hi', '[]', '[]', '${T}');
  INSERT INTO runs(workflow_name, workflow_version, "trigger", params_json, status, created_at) VALUES ('job-scan', 1, 'chat', '{}', 'running', '${T}');
  INSERT INTO steps(run_id, step_key) VALUES (1, 'scan');
  INSERT INTO tasks(run_id, step_id, bot_name, kind, input_json, engine, created_at) VALUES (1, 1, 'research', 'scan', '{}', 'codex', '${T}');
  INSERT INTO memory_changes(bot_name, run_id, task_id, note, created_at) VALUES ('research', 1, 1, 'TopCV upload limit is 5MB', '${T}');
  INSERT INTO engine_state(engine, paused_until, reason) VALUES ('claude', '2026-10-10T09:00:00.000Z', 'rate limited');
  INSERT INTO schedules(name, cron, workflow_name, params_json, created_at, updated_at) VALUES ('Weekdays', '0 9 * * 1-5', 'job-scan', '{}', '${T}', '${T}');
`;

describe("migration 0002 on a database with data", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("keeps every row, maps legacy literals and keeps the immutability triggers", () => {
    dir = mkdtempSync(join(tmpdir(), "bsja-migrate-"));
    const path = join(dir, "app.db");
    const legacy = openDb(path, { migrationsFolder: legacyMigrations(dir, 2) });
    legacy.$client.exec(LEGACY_ROWS);
    legacy.$client.close();

    const db = openDb(path);
    const c = db.$client;
    const one = <T>(sql: string) => c.prepare(sql).get() as T;
    const count = (table: string) => one<{ n: number }>(`SELECT count(*) AS n FROM ${table}`).n;

    // Legacy literals now use the shared values.
    expect(c.prepare("SELECT language FROM cv_versions ORDER BY id").all()).toEqual([{ language: "en" }, { language: "vi" }]);
    expect(one<{ kind: string }>("SELECT kind FROM rooms").kind).toBe("direct");
    expect(one<{ reason: string }>("SELECT reason FROM engine_state").reason).toBe("usage_limit");
    // New columns got their defaults.
    expect(one<{ timezone: string }>("SELECT timezone FROM schedules").timezone).toBe("Asia/Ho_Chi_Minh");
    expect(one<{ dry_run: number }>("SELECT dry_run FROM submissions").dry_run).toBe(0);
    expect(one<{ f: number; c: string | null }>("SELECT injection_flagged AS f, injection_cleared_at AS c FROM jobs")).toEqual({ f: 0, c: null });
    expect(one<{ n: string; f: string }>("SELECT change_notes_json AS n, fact_requests_json AS f FROM cv_versions WHERE id = 1")).toEqual({ n: "[]", f: "[]" });

    // Child rows survive the parent rebuilds (no ON DELETE CASCADE fired on DROP TABLE).
    for (const table of ["room_members", "messages", "tasks", "memory_changes", "qa_reviews", "approvals", "applications", "submissions", "job_snapshots"]) {
      expect(count(table), table).toBeGreaterThan(0);
    }
    expect(count("cv_versions")).toBe(2);
    expect(c.pragma("foreign_key_check")).toEqual([]);
    expect(c.pragma("foreign_keys", { simple: true })).toBe(1);

    // §9.1 triggers are still in place.
    expect(() => c.prepare("UPDATE submissions SET final_url = 'https://x.test'").run()).toThrow(/immutable/);
    expect(() => c.prepare("DELETE FROM job_snapshots").run()).toThrow(/immutable/);
    expect(() => c.prepare("DELETE FROM applications").run()).toThrow(/cannot be deleted/);
    expect(() => c.prepare("UPDATE approvals SET used_at = NULL").run()).toThrow(/already used/);
    c.close();
  });

  it("refuses to finish a migration that would leave broken foreign keys", () => {
    dir = mkdtempSync(join(tmpdir(), "bsja-migrate-"));
    const path = join(dir, "app.db");
    const legacy = openDb(path, { migrationsFolder: legacyMigrations(dir, 2) });
    // An orphan written while foreign keys were off (e.g. by an old tool).
    legacy.$client.pragma("foreign_keys = OFF");
    legacy.$client.exec(`INSERT INTO room_members(room_id, bot_name) VALUES (99, 'ghost');`);
    legacy.$client.close();
    expect(() => openDb(path)).toThrow(/foreign key/);
  });
});
