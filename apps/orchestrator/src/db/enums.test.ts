// Drift guard (QA phase 1): the shared Zod enums are the single source of truth for
// every enum literal stored in SQLite. This reads the CHECK constraints of the fully
// migrated database, so a migration that drifts from packages/shared fails here.
import {
  APPLICATION_STATUSES,
  ApplicationOriginSchema,
  CompanyConfidenceSchema,
  CurrencySchema,
  CvLanguageSchema,
  EnginePauseReasonSchema,
  EngineSchema,
  JOB_STATUSES,
  RoomKindSchema,
  RUN_STATUSES,
  RunTriggerSchema,
  SKIP_REASONS,
  STEP_STATUSES,
  SalaryPolicySchema,
  TASK_STATUSES,
  TrustLevelSchema,
  WorkModeSchema,
} from "@bs-job-agents/shared";
import { describe, expect, it } from "vitest";
import { openTestDb } from "./client.js";
import * as dbEnums from "./enums.js";

/** `<table>.<column>` → the shared literals its CHECK constraint must allow. */
const EXPECTED: Record<string, readonly (string | number)[]> = {
  "bots.engine": EngineSchema.options,
  "bots.trust_level": [0, 1, 2],
  "runs.trigger": RunTriggerSchema.options,
  "runs.status": RUN_STATUSES,
  "steps.status": STEP_STATUSES,
  "tasks.status": TASK_STATUSES,
  "tasks.engine": EngineSchema.options,
  "companies.confidence": CompanyConfidenceSchema.options,
  "jobs.status": JOB_STATUSES,
  "jobs.skip_reason": SKIP_REASONS,
  "jobs.work_mode": WorkModeSchema.options,
  "cv_versions.language": CvLanguageSchema.options,
  "applications.status": APPLICATION_STATUSES,
  "applications.origin": ApplicationOriginSchema.options,
  "rooms.kind": RoomKindSchema.options,
  "search_profiles.currency": CurrencySchema.options,
  "search_profiles.salary_policy": SalaryPolicySchema.options,
  "engine_state.engine": EngineSchema.options,
  "engine_state.reason": EnginePauseReasonSchema.options,
};

/** Every `CHECK("col" IS NULL OR "col" IN (...))` in the live schema, keyed `table.column`. */
function liveEnumChecks(): Map<string, (string | number)[]> {
  const db = openTestDb();
  const tables = db.$client
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL")
    .all() as { name: string; sql: string }[];
  db.$client.close();
  const out = new Map<string, (string | number)[]>();
  const re = /CHECK\s*\(\s*"(\w+)" IS NULL OR "\1" IN \(([^)]*)\)\s*\)/g;
  for (const { name, sql } of tables) {
    for (const m of sql.matchAll(re)) {
      const values = m[2]!.split(",").map((v) => {
        const t = v.trim();
        return t.startsWith("'") ? t.slice(1, -1) : Number(t);
      });
      out.set(`${name}.${m[1]}`, values);
    }
  }
  return out;
}

describe("DB enum literals come from @bs-job-agents/shared", () => {
  const live = liveEnumChecks();

  it.each(Object.entries(EXPECTED))("%s CHECK allows exactly the shared values", (key, expected) => {
    expect(live.get(key), `no CHECK constraint found for ${key}`).toBeDefined();
    expect([...live.get(key)!].sort()).toEqual([...expected].sort());
  });

  it("every enum CHECK in the database is covered by this test", () => {
    expect([...live.keys()].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it("the TypeScript lists are the shared ones", () => {
    expect(dbEnums.ENGINES).toEqual(EngineSchema.options);
    expect(dbEnums.RUN_TRIGGERS).toEqual(RunTriggerSchema.options);
    expect(dbEnums.RUN_STATUSES).toBe(RUN_STATUSES);
    expect(dbEnums.STEP_STATUSES).toBe(STEP_STATUSES);
    expect(dbEnums.TASK_STATUSES).toBe(TASK_STATUSES);
    expect(dbEnums.JOB_STATUSES).toBe(JOB_STATUSES);
    expect(dbEnums.SKIP_REASONS).toBe(SKIP_REASONS);
    expect(dbEnums.APPLICATION_STATUSES).toBe(APPLICATION_STATUSES);
    expect(dbEnums.CV_LANGUAGES).toEqual(CvLanguageSchema.options);
    expect(dbEnums.ROOM_KINDS).toEqual(RoomKindSchema.options);
    expect(dbEnums.SALARY_POLICIES).toEqual(SalaryPolicySchema.options);
    expect(dbEnums.CURRENCIES).toEqual(CurrencySchema.options);
    expect(dbEnums.WORK_MODES).toEqual(WorkModeSchema.options);
    expect(dbEnums.ENGINE_PAUSE_REASONS).toEqual(EnginePauseReasonSchema.options);
    for (const level of dbEnums.TRUST_LEVELS) expect(TrustLevelSchema.safeParse(level).success).toBe(true);
    expect(dbEnums.TRUST_LEVELS).toEqual([0, 1, 2]);
  });

  it("terminal and active subsets only use shared literals", () => {
    for (const s of [...dbEnums.TERMINAL_RUN_STATUSES, ...dbEnums.ACTIVE_RUN_STATUSES]) expect(RUN_STATUSES).toContain(s);
    for (const s of dbEnums.TERMINAL_STEP_STATUSES) expect(STEP_STATUSES).toContain(s);
    for (const s of dbEnums.TERMINAL_TASK_STATUSES) expect(TASK_STATUSES).toContain(s);
  });
});
