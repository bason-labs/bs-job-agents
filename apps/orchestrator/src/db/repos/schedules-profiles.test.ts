import { beforeEach, describe, expect, it } from "vitest";
import { openTestDb, type Db } from "../client.js";
import { NotFoundError } from "../errors.js";
import { at, seedBots, T0 } from "../test-helpers.js";
import { createRun, getRun, updateRunStatus } from "./runs.js";
import {
  createSchedule,
  dueSchedules,
  getSchedule,
  hasActiveRun,
  listSchedules,
  purgeDeletedSchedules,
  recordScheduleFired,
  restoreSchedule,
  setScheduleEnabled,
  softDeleteSchedule,
  updateSchedule,
  UNDO_WINDOW_MS,
} from "./schedules.js";
import {
  createSearchProfile,
  getActiveSearchProfile,
  getSearchProfile,
  listSearchProfileVersions,
  resolveSearchProfile,
  setActiveSearchProfile,
  updateSearchProfile,
  type SearchProfileInput,
} from "./search-profiles.js";

let db: Db;
beforeEach(() => {
  db = openTestDb();
  seedBots(db);
});

const CRITERIA: SearchProfileInput = {
  roles: ["Frontend Engineer", "Software Engineer (React/Node)"],
  locations: ["Ho Chi Minh City", "Remote (VN)"],
  minSalary: 25_000_000,
  currency: "VND",
  includeKeywords: ["React", "Next.js", "TypeScript"],
  excludeKeywords: ["PHP", "WordPress"],
  companyTypes: ["product", "AI"],
};

describe("search profiles (§7.5, UC-21b)", () => {
  it("creates v1 with §7.5 defaults and makes it active", () => {
    const p = createSearchProfile(db, CRITERIA, { now: T0 });
    expect(p).toMatchObject({
      name: "Default",
      version: 1,
      active: true,
      workModes: ["onsite", "hybrid", "remote"],
      seniority: ["mid", "senior"],
      sources: ["topcv", "itviec", "linkedin"],
      excludeCompanies: [],
      languages: ["en"],
      maxJobs: 5,
      fitThreshold: 60,
      salaryPolicy: "blank_if_optional",
      salaryAmount: null,
      updatedAt: T0.toISOString(),
    });
    expect(getActiveSearchProfile(db)?.id).toBe(p.id);
  });

  it("saving creates a new active version; the old one is kept for runs that started with it", () => {
    const v1 = createSearchProfile(db, CRITERIA, { now: T0 });
    const v2 = updateSearchProfile(db, { locations: [...CRITERIA.locations, "Đà Nẵng"], salaryPolicy: "fixed", salaryAmount: 30_000_000 }, { now: at(60) });
    expect(v2).toMatchObject({ version: 2, active: true, salaryPolicy: "fixed", salaryAmount: 30_000_000, updatedAt: at(60).toISOString() });
    expect(v2.locations).toContain("Đà Nẵng");
    expect(v2.roles).toEqual(CRITERIA.roles);
    expect(getSearchProfile(db, v1.id)).toMatchObject({ version: 1, active: false });
    expect(getActiveSearchProfile(db)?.id).toBe(v2.id);
    expect(listSearchProfileVersions(db, "Default").map((p) => p.version)).toEqual([2, 1]);
  });

  it("allows only one active profile row (partial unique index)", () => {
    createSearchProfile(db, CRITERIA);
    expect(() =>
      db.$client
        .prepare(
          `INSERT INTO search_profiles (name, version, active, roles_json, locations_json, work_modes_json, seniority_json, sources_json,
             include_keywords_json, exclude_keywords_json, exclude_companies_json, company_types_json, languages_json, updated_at)
           VALUES ('Other', 1, 1, '[]','[]','[]','[]','[]','[]','[]','[]','[]','[]','now')`,
        )
        .run(),
    ).toThrow(/UNIQUE/);
  });

  it("rejects unknown salary policies and currencies (CHECK)", () => {
    expect(() => createSearchProfile(db, { ...CRITERIA, currency: "EUR" as "VND" })).toThrow(/CHECK/);
    expect(() => createSearchProfile(db, { ...CRITERIA, salaryPolicy: "whatever" as "ask" })).toThrow(/CHECK/);
  });

  it("switches the active profile and resolves schedule references to the latest version", () => {
    const def = createSearchProfile(db, CRITERIA);
    const other = createSearchProfile(db, { ...CRITERIA, roles: ["AI Engineer"] }, { name: "AI roles", activate: false });
    expect(getActiveSearchProfile(db)?.id).toBe(def.id);
    setActiveSearchProfile(db, other.id);
    expect(getActiveSearchProfile(db)?.id).toBe(other.id);
    const otherV2 = updateSearchProfile(db, { fitThreshold: 70 }, { name: "AI roles" });
    // A schedule pointing at v1 of "AI roles" follows the profile to its latest version.
    expect(resolveSearchProfile(db, other.id)?.id).toBe(otherV2.id);
    // NULL means "the active profile".
    expect(resolveSearchProfile(db, null)?.id).toBe(otherV2.id);
  });

  it("updateSearchProfile throws when there is no profile yet", () => {
    expect(() => updateSearchProfile(db, { maxJobs: 3 })).toThrow(NotFoundError);
  });
});

describe("schedules (§7.4, UC-21)", () => {
  const WEEKDAYS = { name: "Weekday morning scan", cron: "0 9 * * 1-5", workflowName: "job-scan" };

  it("creates, reads and updates a schedule", () => {
    const s = createSchedule(db, { ...WEEKDAYS, nextRunAt: "2026-10-13T02:00:00.000Z" }, { now: T0 });
    expect(s).toMatchObject({ enabled: true, params: {}, searchProfileId: null, deletedAt: null, lastRunId: null });
    const edited = updateSchedule(db, s.id, { cron: "0 9 * * *", params: { maxJobs: 3 } }, { now: at(1) });
    expect(edited).toMatchObject({ cron: "0 9 * * *", params: { maxJobs: 3 }, updatedAt: at(1).toISOString() });
    expect(setScheduleEnabled(db, s.id, false).enabled).toBe(false);
    expect(getSchedule(db, s.id)?.enabled).toBe(false);
  });

  it("keeps the cron's time zone, Asia/Ho_Chi_Minh by default (§11 Schedules, §15.2)", () => {
    expect(createSchedule(db, WEEKDAYS).timezone).toBe("Asia/Ho_Chi_Minh");
    const s = createSchedule(db, { ...WEEKDAYS, name: "Tokyo", timezone: "Asia/Tokyo" });
    expect(s.timezone).toBe("Asia/Tokyo");
    expect(updateSchedule(db, s.id, { timezone: "Asia/Ho_Chi_Minh" }).timezone).toBe("Asia/Ho_Chi_Minh");
  });

  it("soft-deletes, hides from the list, and Undo restores it", () => {
    const s = createSchedule(db, WEEKDAYS);
    const deleted = softDeleteSchedule(db, s.id, { now: at(10) });
    expect(deleted.deletedAt).toBe(at(10).toISOString());
    expect(listSchedules(db)).toEqual([]);
    expect(listSchedules(db, { includeDeleted: true })).toHaveLength(1);
    expect(getSchedule(db, s.id)).toBeUndefined();
    expect(getSchedule(db, s.id, { includeDeleted: true })?.id).toBe(s.id);
    expect(() => updateSchedule(db, s.id, { name: "x" })).toThrow(NotFoundError);

    const restored = restoreSchedule(db, s.id);
    expect(restored.deletedAt).toBeNull();
    expect(listSchedules(db).map((x) => x.id)).toEqual([s.id]);
  });

  it("purges soft-deleted schedules after the undo window, keeping past runs", () => {
    const keep = createSchedule(db, { ...WEEKDAYS, name: "keep" });
    const gone = createSchedule(db, WEEKDAYS);
    const run = createRun(db, { workflowName: "job-scan", workflowVersion: 1, trigger: "schedule", params: {}, scheduleId: gone.id });
    recordScheduleFired(db, gone.id, { runId: run.id, nextRunAt: null });
    softDeleteSchedule(db, gone.id, { now: T0 });

    expect(UNDO_WINDOW_MS).toBe(6000);
    expect(purgeDeletedSchedules(db, { now: at(5) })).toBe(0);
    expect(purgeDeletedSchedules(db, { now: at(6) })).toBe(1);
    expect(getSchedule(db, gone.id, { includeDeleted: true })).toBeUndefined();
    expect(() => restoreSchedule(db, gone.id)).toThrow(NotFoundError);
    expect(getRun(db, run.id)).toMatchObject({ scheduleId: null });
    expect(getSchedule(db, keep.id)).toBeDefined();
  });

  it("records the fired run and detects overlap (UC-02a)", () => {
    const s = createSchedule(db, WEEKDAYS);
    expect(hasActiveRun(db, s.id)).toBe(false);
    const run = createRun(db, { workflowName: "job-scan", workflowVersion: 1, trigger: "schedule", params: {}, scheduleId: s.id });
    const fired = recordScheduleFired(db, s.id, { runId: run.id, nextRunAt: "2026-10-14T02:00:00.000Z" });
    expect(fired).toMatchObject({ lastRunId: run.id, nextRunAt: "2026-10-14T02:00:00.000Z" });
    expect(hasActiveRun(db, s.id)).toBe(true);
    updateRunStatus(db, run.id, "done");
    expect(hasActiveRun(db, s.id)).toBe(false);
  });

  it("lists due schedules: enabled, not deleted, next_run_at reached", () => {
    const due = createSchedule(db, { ...WEEKDAYS, nextRunAt: at(0).toISOString() });
    createSchedule(db, { ...WEEKDAYS, name: "later", nextRunAt: at(100).toISOString() });
    createSchedule(db, { ...WEEKDAYS, name: "off", nextRunAt: at(0).toISOString(), enabled: false });
    const del = createSchedule(db, { ...WEEKDAYS, name: "deleted", nextRunAt: at(0).toISOString() });
    softDeleteSchedule(db, del.id);
    expect(dueSchedules(db, { now: at(1) }).map((s) => s.id)).toEqual([due.id]);
  });

  it("references a search profile", () => {
    const p = createSearchProfile(db, CRITERIA);
    const s = createSchedule(db, { ...WEEKDAYS, searchProfileId: p.id });
    expect(resolveSearchProfile(db, s.searchProfileId)?.id).toBe(p.id);
  });
});
