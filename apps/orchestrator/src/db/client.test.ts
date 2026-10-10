import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, openTestDb, type Db } from "./client.js";

// Every table listed in spec §9 (rooms / room_members / messages are one row there).
const SPEC_TABLES = [
  "bots",
  "prompt_versions",
  "memory_changes",
  "workflows",
  "runs",
  "steps",
  "tasks",
  "jobs",
  "companies",
  "cv_versions",
  "qa_reviews",
  "approvals",
  "applications",
  "submissions",
  "job_snapshots",
  "exports",
  "saved_answers",
  "uploads",
  "search_profiles",
  "schedules",
  "rooms",
  "room_members",
  "messages",
  "engine_state",
  "events",
];

function tableNames(db: Db): string[] {
  return (
    db.$client
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[]
  ).map((r) => r.name);
}

function columns(db: Db, table: string): string[] {
  return (db.$client.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (r) => r.name,
  );
}

describe("openTestDb", () => {
  it("applies all migrations to an empty in-memory database", () => {
    const db = openTestDb();
    const names = tableNames(db);
    for (const t of SPEC_TABLES) expect(names).toContain(t);
    db.$client.close();
  });

  it("turns foreign keys on", () => {
    const db = openTestDb();
    expect(db.$client.pragma("foreign_keys", { simple: true })).toBe(1);
    db.$client.close();
  });

  it("creates the exact §9 columns for key tables", () => {
    const db = openTestDb();
    expect(columns(db, "submissions")).toEqual(
      expect.arrayContaining([
        "application_id",
        "final_url",
        "fields_json",
        "intro_text",
        "consent_ticked",
        "consent_text",
        "uploaded_filename",
        "uploaded_sha256",
        "uploaded_path",
        "pre_submit_screenshot_path",
        "confirmation_screenshot_path",
        "confirmation_text",
        "approval_token",
        "submitted_at",
      ]),
    );
    expect(columns(db, "job_snapshots")).toEqual(
      expect.arrayContaining([
        "application_id",
        "captured_at",
        "url",
        "title",
        "company",
        "salary_text",
        "jd_text",
        "page_screenshot_path",
      ]),
    );
    expect(columns(db, "search_profiles")).toEqual(
      expect.arrayContaining([
        "id",
        "name",
        "version",
        "active",
        "roles_json",
        "locations_json",
        "work_modes_json",
        "min_salary",
        "currency",
        "seniority_json",
        "sources_json",
        "include_keywords_json",
        "exclude_keywords_json",
        "exclude_companies_json",
        "company_types_json",
        "languages_json",
        "max_jobs",
        "fit_threshold",
        "salary_policy",
        "salary_amount",
        "updated_at",
      ]),
    );
    expect(columns(db, "schedules")).toEqual(
      expect.arrayContaining([
        "id",
        "name",
        "cron",
        "workflow_name",
        "search_profile_id",
        "params_json",
        "enabled",
        "last_run_id",
        "next_run_at",
        "deleted_at",
      ]),
    );
    expect(columns(db, "tasks")).toEqual(
      expect.arrayContaining([
        "id",
        "run_id",
        "step_id",
        "bot_name",
        "kind",
        "input_json",
        "output_json",
        "status",
        "pause_reason",
        "attempt",
        "engine",
        "prompt_version",
        "transcript_path",
        "started_at",
        "finished_at",
      ]),
    );
    expect(columns(db, "engine_state")).toEqual(["engine", "paused_until", "reason"]);
    db.$client.close();
  });
});

describe("openDb (file)", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("opens with WAL, foreign keys and busy_timeout, and migrates idempotently", () => {
    dir = mkdtempSync(join(tmpdir(), "bsja-db-"));
    const path = join(dir, "nested", "app.db");
    const db = openDb(path);
    expect(db.$client.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.$client.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.$client.pragma("busy_timeout", { simple: true })).toBeGreaterThanOrEqual(5000);
    db.$client.close();

    // Re-opening runs migrations again without error and keeps the tables.
    const again = openDb(path);
    expect(tableNames(again)).toEqual(expect.arrayContaining(SPEC_TABLES));
    again.$client.close();
  });
});
