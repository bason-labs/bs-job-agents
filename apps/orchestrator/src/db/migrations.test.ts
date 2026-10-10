// Upgrading a database that already holds data (QA phase 1, PM M4). Migrations may rebuild
// tables (SQLite cannot alter CHECK or NOT NULL), so an upgrade must keep every row, map
// legacy literals to the shared ones, keep child rows (no cascade on DROP), and keep the
// §9.1 triggers and the one-application-per-job index. Each case starts from a populated
// database left by an earlier migration and opens it with the current openDb().
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER, openDb } from "./client.js";
import { missingGuardedObjects } from "./schema-guard.js";

interface Journal {
  entries: { idx: number; tag: string }[];
}
const JOURNAL = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as Journal;
/** Migration tags in order: 0000_init, 0001_immutability_triggers, … */
const TAGS = JOURNAL.entries.map((e) => e.tag);
/** How many migrations a database has once it reached `tag`. */
const countAt = (tagPrefix: string): number => TAGS.findIndex((t) => t.startsWith(tagPrefix)) + 1;

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function tempDir(): string {
  dir = mkdtempSync(join(tmpdir(), "bsja-migrate-"));
  return dir;
}

/** A copy of the first `count` migrations. */
function migrationsUpTo(base: string, count: number): string {
  const folder = join(base, `migrations-${count}`);
  mkdirSync(join(folder, "meta"), { recursive: true });
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as Journal;
  journal.entries = journal.entries.filter((e) => e.idx < count);
  writeFileSync(join(folder, "meta", "_journal.json"), JSON.stringify(journal));
  for (const e of journal.entries) cpSync(join(MIGRATIONS_FOLDER, `${e.tag}.sql`), join(folder, `${e.tag}.sql`));
  return folder;
}

/**
 * The database as an older orchestrator left it: the first `count` migrations, applied the
 * way openDb() applies them (foreign keys off around the migrator). No schema guard: an
 * older build only knew the objects of its own head.
 */
function openAt(base: string, path: string, count: number): Database.Database {
  const client = new Database(path);
  client.pragma("journal_mode = WAL");
  client.pragma("foreign_keys = OFF");
  migrate(drizzle(client), { migrationsFolder: migrationsUpTo(base, count) });
  client.pragma("foreign_keys = ON");
  return client;
}

const T = "2026-10-10T08:00:00.000Z";
const T30 = "2026-10-10T08:00:30.000Z";
const SHA_NOVAPAY = "a".repeat(64);
const SHA_KOBE = "c".repeat(64);

/**
 * A realistic database for the schema after `count` migrations: a submitted application with
 * its frozen record, a paused one, chat, a run with a task, schedules, profiles and events.
 * Literals follow that schema (0000/0001 used `EN`/`VI`, room kind `consult` and free-text
 * engine pause reasons; 0002 moved them to the shared values).
 */
function populate(client: Database.Database, count: number): void {
  const shared = count >= countAt("0002");
  const [EN, VI] = shared ? ["en", "vi"] : ["EN", "VI"];
  // 0004 binds each token to its application (PM M2).
  const bound = count >= countAt("0004");
  const approvalsSql = bound
    ? `INSERT INTO approvals(token, job_id, cv_version_id, allowed_domains_json, expires_at, used_at, created_at, application_id) VALUES
      ('tok-novapay', 1, 1, '["itviec.com"]', '2026-10-11T08:00:00.000Z', '${T}', '${T}', 1),
      ('tok-kobe', 2, 3, '["topcv.vn"]', '2026-10-11T08:00:00.000Z', '${T}', '${T}', 2);`
    : `INSERT INTO approvals(token, job_id, cv_version_id, allowed_domains_json, expires_at, used_at, created_at) VALUES
      ('tok-novapay', 1, 1, '["itviec.com"]', '2026-10-11T08:00:00.000Z', '${T}', '${T}'),
      ('tok-kobe', 2, 3, '["topcv.vn"]', '2026-10-11T08:00:00.000Z', '${T}', '${T}');`;
  client.exec(`
    INSERT INTO bots(name, display_name, engine, trust_level) VALUES ('cv', 'CV', 'claude', 2), ('research', 'Research', 'codex', 2), ('apply', 'Apply', 'claude', 1);
    INSERT INTO prompt_versions(bot_name, version, role_md_hash, role_md_text, created_at) VALUES ('cv', 1, 'h1', '# CV', '${T}');
    INSERT INTO workflows(name, version, definition_yaml, created_at) VALUES ('job-scan', 1, 'name: job-scan', '${T}');
    INSERT INTO companies(name, name_key) VALUES ('NovaPay', 'novapay'), ('Kobe', 'kobe');
    INSERT INTO jobs(source, url, canonical_url, dedupe_hash, title, company_id, location, language, jd_text, status, first_seen_at) VALUES
      ('itviec', 'https://itviec.com/j/1', 'https://itviec.com/j/1', 'h1', 'Senior FE', 1, 'Ho Chi Minh City', 'en', 'JD one', 'applied', '${T}'),
      ('topcv', 'https://www.topcv.vn/j/2', 'https://www.topcv.vn/j/2', 'h2', 'Frontend Dev', 2, 'Ho Chi Minh City', 'vi', 'JD two', 'approved', '${T}');
    INSERT INTO cv_versions(job_id, language, round, figma_frame_url, pdf_path, pdf_sha256, master_version, prompt_version, created_at) VALUES
      (1, '${EN}', 1, 'https://www.figma.com/design/x?node-id=1-2', 'data/pdf/NOVAPAY_FE_EN_v1.pdf', '${SHA_NOVAPAY}', 1, 1, '${T}'),
      (1, '${VI}', 1, NULL, NULL, NULL, 1, 1, '${T}'),
      (2, '${VI}', 1, NULL, 'data/pdf/KOBE_FE_VI_v1.pdf', '${SHA_KOBE}', 1, 1, '${T}');
    INSERT INTO qa_reviews(cv_version_id, total, scores_json, hard_fails_json, fixes_json, passed, created_at) VALUES (1, 85, '{}', '[]', '[]', 1, '${T}');
    INSERT INTO applications(job_id, cv_version_id, submitted_at, status, origin, status_history_json, created_at) VALUES
      (1, 1, '${T30}', 'submitted', 'app', '[{"status":"approved","at":"${T}","note":null},{"status":"submitted","at":"${T30}","note":null}]', '${T}'),
      (2, 3, NULL, 'paused', 'app', '[{"status":"approved","at":"${T}","note":null},{"status":"paused","at":"${T30}","note":"notice period?"}]', '${T}');
    ${approvalsSql}
    INSERT INTO submissions(application_id, final_url, fields_json, intro_text, consent_ticked, consent_text, uploaded_filename, uploaded_sha256, uploaded_path, confirmation_text, approval_token, submitted_at) VALUES
      (1, 'https://itviec.com/applied/1', '[{"label":"Full name","name":"name","value":"Ba Huynh","source":"master_cv"}]', 'Hi NovaPay', 1, 'I agree', 'BA_HUYNH_NOVAPAY_EN.pdf', '${SHA_NOVAPAY}', 'data/applications/1/BA_HUYNH_NOVAPAY_EN.pdf', 'Application sent', 'tok-novapay', '${T30}');
    INSERT INTO job_snapshots(application_id, captured_at, url, title, company, jd_text, page_screenshot_path) VALUES
      (1, '${T30}', 'https://itviec.com/j/1', 'Senior FE', 'NovaPay', 'JD one', 'data/applications/1/jd.png');
    INSERT INTO saved_answers(key, label, answer, updated_at) VALUES ('notice period', 'Notice period?', '30 days', '${T}');
    INSERT INTO exports(created_at, path, application_count) VALUES ('${T}', 'data/exports/a.zip', 1);
    INSERT INTO rooms(name, kind, bot_name, created_at) VALUES ('consult:cv', '${shared ? "direct" : "consult"}', 'cv', '${T}');
    INSERT INTO room_members(room_id, bot_name) VALUES (1, 'cv');
    INSERT INTO messages(room_id, author, text, mentions_json, run_refs_json, created_at) VALUES (1, 'ba', 'hi', '[]', '[]', '${T}');
    INSERT INTO uploads(filename, mime, size, path, sha256, uploaded_at, message_id) VALUES ('jd.pdf', 'application/pdf', 10, 'data/uploads/1-jd.pdf', '${"b".repeat(64)}', '${T}', 1);
    INSERT INTO search_profiles(name, version, active, roles_json, locations_json, work_modes_json, seniority_json, sources_json, include_keywords_json, exclude_keywords_json, exclude_companies_json, company_types_json, languages_json, updated_at)
      VALUES ('Default', 1, 1, '["Frontend Engineer"]', '[]', '[]', '[]', '["topcv"]', '[]', '[]', '[]', '[]', '["en"]', '${T}');
    INSERT INTO runs(workflow_name, workflow_version, "trigger", params_json, status, created_at) VALUES ('job-scan', 1, 'chat', '{}', 'running', '${T}');
    INSERT INTO steps(run_id, step_key) VALUES (1, 'scan');
    INSERT INTO tasks(run_id, step_id, bot_name, kind, input_json, engine, created_at) VALUES (1, 1, 'research', 'scan', '{}', 'codex', '${T}');
    INSERT INTO memory_changes(bot_name, run_id, task_id, note, created_at) VALUES ('research', 1, 1, 'TopCV upload limit is 5MB', '${T}');
    INSERT INTO engine_state(engine, paused_until, reason) VALUES ('claude', '2026-10-10T09:00:00.000Z', '${shared ? "usage_limit" : "rate limited"}');
    INSERT INTO schedules(name, cron, workflow_name, params_json, created_at, updated_at) VALUES ('Weekdays', '0 9 * * 1-5', 'job-scan', '{}', '${T}', '${T}');
    INSERT INTO events(type, payload_json, created_at) VALUES ('run.started', '{"runId":"1"}', '${T}');
  `);
  if (count >= countAt("0003")) {
    // A dry run for the job whose real application is paused: outside the one-per-job index.
    client.exec(`
      INSERT INTO applications(job_id, cv_version_id, status, origin, status_history_json, dry_run, created_at) VALUES
        (2, 3, 'needs_check', 'app', '[{"status":"approved","at":"${T}","note":null},{"status":"needs_check","at":"${T30}","note":"dry run: form filled, not submitted"}]', 1, '${T}');
    `);
  }
}

type Row = Record<string, unknown>;

/** Every user table (not drizzle's bookkeeping) with its rows in primary-key order. */
function snapshot(client: Database.Database): Map<string, { columns: string[]; order: string; rows: Row[] }> {
  const tables = (
    client
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY name")
      .all() as { name: string }[]
  ).map((t) => t.name);
  const out = new Map<string, { columns: string[]; order: string; rows: Row[] }>();
  for (const table of tables) {
    const info = client.prepare(`PRAGMA table_info(\`${table}\`)`).all() as { name: string; pk: number }[];
    const columns = info.map((c) => c.name);
    const pk = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
    const order = pk.length > 0 ? pk.map((c) => `"${c.name}"`).join(", ") : "rowid";
    const rows = client.prepare(`SELECT * FROM \`${table}\` ORDER BY ${order}`).all() as Row[];
    out.set(table, { columns, order, rows });
  }
  return out;
}

/** What 0002 does to legacy literals (QA phase 1): the rows otherwise stay as they were. */
function expectedAfterUpgrade(table: string, row: Row, count: number): Row {
  if (count >= countAt("0002")) return row;
  if (table === "cv_versions") return { ...row, language: String(row.language).toLowerCase() };
  if (table === "rooms" && row.kind === "consult") return { ...row, kind: "direct" };
  if (table === "engine_state" && row.reason !== null && !["usage_limit", "manual"].includes(String(row.reason))) {
    return { ...row, reason: "usage_limit" };
  }
  return row;
}

const EARLIER = TAGS.slice(0, -1).map((tag, i) => [tag, i + 1] as const);

describe("upgrading a populated database from every earlier migration to head (PM M4)", () => {
  it("covers every migration before head", () => {
    expect(TAGS.length).toBeGreaterThanOrEqual(3);
    expect(EARLIER.map(([tag]) => tag)).toEqual(TAGS.slice(0, -1));
  });

  it.each(EARLIER)("from %s keeps every row and column value", (_tag, count) => {
    const base = tempDir();
    const path = join(base, "app.db");
    const old = openAt(base, path, count);
    populate(old, count);
    const before = snapshot(old);
    old.close();

    const db = openDb(path);
    const c = db.$client;
    for (const [table, { columns, order, rows }] of before) {
      const after = c.prepare(`SELECT ${columns.map((col) => `"${col}"`).join(", ")} FROM \`${table}\` ORDER BY ${order}`).all() as Row[];
      expect(after, table).toEqual(rows.map((r) => expectedAfterUpgrade(table, r, count)));
    }
    expect(c.pragma("foreign_key_check")).toEqual([]);
    expect(c.pragma("foreign_keys", { simple: true })).toBe(1);
    c.close();
  });

  it.each(EARLIER)("from %s ends with every guarded trigger and index, and they still work", (_tag, count) => {
    const base = tempDir();
    const path = join(base, "app.db");
    const old = openAt(base, path, count);
    populate(old, count);
    old.close();

    const db = openDb(path);
    const c = db.$client;
    expect(missingGuardedObjects(c)).toEqual([]);
    // §9.1: the record is frozen and the recorded application stays.
    expect(() => c.prepare("UPDATE submissions SET final_url = 'https://x.test' WHERE application_id = 1").run()).toThrow(/immutable/);
    expect(() => c.prepare("DELETE FROM submissions WHERE application_id = 1").run()).toThrow(/immutable/);
    expect(() => c.prepare("UPDATE job_snapshots SET jd_text = 'x' WHERE application_id = 1").run()).toThrow(/immutable/);
    expect(() => c.prepare("DELETE FROM job_snapshots WHERE application_id = 1").run()).toThrow(/immutable/);
    expect(() => c.prepare("DELETE FROM applications WHERE id = 1").run()).toThrow(/cannot be deleted/);
    expect(() => c.prepare("UPDATE applications SET cv_version_id = 2 WHERE id = 1").run()).toThrow(/only allow status/);
    expect(() => c.prepare("UPDATE applications SET status_history_json = '[]' WHERE id = 1").run()).toThrow(/append-only/);
    const rewritten = JSON.stringify([
      { status: "approved", at: T, note: "edited later" },
      { status: "submitted", at: T30, note: null },
    ]);
    expect(() => c.prepare("UPDATE applications SET status_history_json = ? WHERE id = 1").run(rewritten)).toThrow(/append-only/);
    expect(() => c.prepare("UPDATE applications SET created_at = ? WHERE id = 1").run(T30)).toThrow(/only allow status/);
    // UC-08: a used token stays used.
    expect(() => c.prepare("UPDATE approvals SET used_at = NULL WHERE token = 'tok-novapay'").run()).toThrow(/already used/);
    // PM M2: tokens are bound to their application; older ones only where a record cites them.
    expect(c.prepare("SELECT token, application_id AS app FROM approvals ORDER BY token").all()).toEqual([
      { token: "tok-kobe", app: count >= countAt("0004") ? 2 : null },
      { token: "tok-novapay", app: 1 },
    ]);
    // PM M2: approvals are immutable except used_at and growing domains, until a record cites them.
    expect(() => c.prepare("UPDATE approvals SET expires_at = '2027-01-01T00:00:00.000Z' WHERE token = 'tok-kobe'").run()).toThrow(
      /immutable/,
    );
    expect(() => c.prepare("UPDATE approvals SET application_id = 1 WHERE token = 'tok-kobe'").run()).toThrow(/immutable/);
    expect(() => c.prepare("DELETE FROM approvals WHERE token = 'tok-kobe'").run()).toThrow(/immutable/);
    const setDomains = c.prepare("UPDATE approvals SET allowed_domains_json = ? WHERE token = ?");
    expect(() => setDomains.run("[]", "tok-kobe")).toThrow(/only grow/);
    expect(() => setDomains.run('["itviec.com","novapay.breezy.hr"]', "tok-novapay")).toThrow(/only grow/);
    expect(() => setDomains.run('["topcv.vn","kobe.breezy.hr"]', "tok-kobe")).not.toThrow();
    // PM M1: an approved CV version keeps its PDF; a record must cite its own application's used token.
    expect(() => c.prepare("UPDATE cv_versions SET pdf_sha256 = ? WHERE id = 1").run("e".repeat(64))).toThrow(/approved/);
    expect(() => c.prepare("UPDATE cv_versions SET pdf_path = 'data/pdf/NOVAPAY_FE_VI_v1.pdf' WHERE id = 2").run()).not.toThrow();
    expect(() =>
      c
        .prepare("INSERT INTO submissions(application_id, fields_json, approval_token, uploaded_sha256, submitted_at) VALUES (2, '[]', 'tok-novapay', ?, ?)")
        .run(SHA_KOBE, T30),
    ).toThrow(/does not match its approval/);
    // PM M3: applications from before 0003 are real ones.
    if (count < countAt("0003")) {
      expect(c.prepare("SELECT count(*) AS n FROM applications WHERE dry_run = 1").get()).toEqual({ n: 0 });
    }
    // §10.2 rule 5: one application per job, unless "apply again"; dry runs never count.
    const insertApp = c.prepare(
      `INSERT INTO applications(job_id, cv_version_id, status, origin, status_history_json, reapply, dry_run, created_at) VALUES (1, 1, 'approved', 'app', '[]', ?, ?, '${T}')`,
    );
    expect(() => insertApp.run(0, 0)).toThrow(/UNIQUE/);
    expect(() => insertApp.run(1, 0)).not.toThrow();
    const dry = insertApp.run(0, 1);
    // PM M3: a dry run never reaches submitted.
    expect(() => c.prepare("UPDATE applications SET status = 'submitted' WHERE id = ?").run(dry.lastInsertRowid)).toThrow(/dry run/);
    c.close();
  });
});

describe("migration 0006 on a database with data", () => {
  it("adds runs.search_profile_id as NULL for older runs (ADD COLUMN, no rebuild)", () => {
    const base = tempDir();
    const path = join(base, "app.db");
    const old = openAt(base, path, countAt("0005"));
    populate(old, countAt("0005"));
    old.close();

    const db = openDb(path);
    const c = db.$client;
    expect(c.prepare("SELECT id, search_profile_id AS p FROM runs").all()).toEqual([{ id: 1, p: null }]);
    expect(() => c.prepare("UPDATE runs SET search_profile_id = 99 WHERE id = 1").run()).toThrow(/FOREIGN KEY/);
    expect(missingGuardedObjects(c)).toEqual([]);
    c.close();
  });
});

describe("migration 0002 on a database with data", () => {
  it("maps legacy literals and gives new columns their defaults", () => {
    const base = tempDir();
    const path = join(base, "app.db");
    const legacy = openAt(base, path, countAt("0001"));
    populate(legacy, countAt("0001"));
    legacy.close();

    const db = openDb(path);
    const c = db.$client;
    const one = <R>(sql: string) => c.prepare(sql).get() as R;
    expect(c.prepare("SELECT language FROM cv_versions ORDER BY id").all()).toEqual([{ language: "en" }, { language: "vi" }, { language: "vi" }]);
    expect(one<{ kind: string }>("SELECT kind FROM rooms").kind).toBe("direct");
    expect(one<{ reason: string }>("SELECT reason FROM engine_state").reason).toBe("usage_limit");
    expect(one<{ timezone: string }>("SELECT timezone FROM schedules").timezone).toBe("Asia/Ho_Chi_Minh");
    expect(one<{ dry_run: number }>("SELECT dry_run FROM submissions").dry_run).toBe(0);
    expect(one<{ f: number; c: string | null }>("SELECT injection_flagged AS f, injection_cleared_at AS c FROM jobs WHERE id = 1")).toEqual({ f: 0, c: null });
    expect(one<{ n: string; f: string }>("SELECT change_notes_json AS n, fact_requests_json AS f FROM cv_versions WHERE id = 1")).toEqual({ n: "[]", f: "[]" });
    c.close();
  });

  it("refuses to finish a migration that would leave broken foreign keys", () => {
    const base = tempDir();
    const path = join(base, "app.db");
    const legacy = openAt(base, path, countAt("0001"));
    // An orphan written while foreign keys were off (e.g. by an old tool).
    legacy.pragma("foreign_keys = OFF");
    legacy.exec(`INSERT INTO room_members(room_id, bot_name) VALUES (99, 'ghost');`);
    legacy.close();
    expect(() => openDb(path)).toThrow(/foreign key/);
  });
});
