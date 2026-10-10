import { beforeEach, describe, expect, it } from "vitest";
import { openTestDb, type Db } from "../client.js";
import { at, seedBots, seedCv, seedJob, seedRun, seedTask, T0 } from "../test-helpers.js";
import {
  appendMemoryChange,
  getBot,
  getWorkflow,
  latestPromptVersion,
  listBots,
  listMemoryChanges,
  recordPromptVersion,
  saveWorkflow,
  updateBot,
  upsertBot,
} from "./bots.js";
import { createCvVersion, createQaReview, latestCvVersion, latestQaReview, listCvVersions, listQaReviews } from "./cv.js";
import {
  enginesDueToResume,
  getEngineState,
  isEnginePaused,
  listEngineStates,
  pauseEngine,
  resumeEngine,
} from "./engine-state.js";

let db: Db;
beforeEach(() => {
  db = openTestDb();
  seedBots(db);
});

describe("cv_versions and qa_reviews (UC-06 / UC-07)", () => {
  it("numbers rounds per job and language", () => {
    const job = seedJob(db);
    const v1 = seedCv(db, job);
    const v2 = createCvVersion(db, { jobId: job.id, language: "EN" });
    const vi = createCvVersion(db, { jobId: job.id, language: "VI" });
    expect([v1.round, v2.round, vi.round]).toEqual([1, 2, 1]);
    expect(latestCvVersion(db, job.id, "EN")?.id).toBe(v2.id);
    expect(listCvVersions(db, job.id)).toHaveLength(3);
    expect(v1.pdfSha256).toBe("a".repeat(64));
  });

  it("applies the QA pass rule: total ≥ 80 and no hard fails", () => {
    const cv = seedCv(db, seedJob(db));
    const scores = { jdMatch: 36, companyTone: 17, formatAts: 19, clarity: 16 };
    const pass = createQaReview(db, { cvVersionId: cv.id, total: 88, scores, hardFails: [], fixes: [], injectionSuspected: false });
    const hard = createQaReview(db, { cvVersionId: cv.id, total: 90, scores, hardFails: ["invented skill"], fixes: [], injectionSuspected: false });
    const low = createQaReview(db, { cvVersionId: cv.id, total: 79, scores, hardFails: [], fixes: ["x"], injectionSuspected: true });
    expect([pass.passed, hard.passed, low.passed]).toEqual([true, false, false]);
    expect(low.injectionSuspected).toBe(true);
    expect(listQaReviews(db, cv.id)).toHaveLength(3);
    expect(latestQaReview(db, cv.id)?.id).toBe(low.id);
  });
});

describe("bots, prompt versions, memory, workflows", () => {
  it("upserts bots from bot.json and updates trust / engine", () => {
    expect(listBots(db).map((b) => b.name)).toEqual(["apply", "cv", "lead", "qa", "research"]);
    upsertBot(db, { name: "research", displayName: "Research", engine: "claude", trustLevel: 2, promptVersion: 2 });
    expect(getBot(db, "research")).toMatchObject({ engine: "claude", promptVersion: 2, enabled: true });
    expect(updateBot(db, "apply", { trustLevel: 0 }).trustLevel).toBe(0);
    expect(() => updateBot(db, "apply", { trustLevel: 3 as 0 })).toThrow(/CHECK/);
  });

  it("stores prompt versions idempotently", () => {
    const v1 = recordPromptVersion(db, { botName: "cv", version: 1, roleMdHash: "h1", roleMdText: "# CV" }, { now: T0 });
    expect(recordPromptVersion(db, { botName: "cv", version: 1, roleMdHash: "h1", roleMdText: "# CV" }).id).toBe(v1.id);
    recordPromptVersion(db, { botName: "cv", version: 2, roleMdHash: "h2", roleMdText: "# CV v2" });
    expect(latestPromptVersion(db, "cv")?.version).toBe(2);
  });

  it("appends memory changes in order (§5.4)", () => {
    const ctx = seedRun(db);
    const task = seedTask(db, ctx);
    appendMemoryChange(db, { botName: "research", note: "TopCV upload limit is 5MB", runId: ctx.run.id, taskId: task.id }, { now: at(1) });
    appendMemoryChange(db, { botName: "research", note: "LinkedIn: ≤ 40 page views" }, { now: at(2) });
    expect(listMemoryChanges(db, "research").map((m) => m.note)).toEqual(["TopCV upload limit is 5MB", "LinkedIn: ≤ 40 page views"]);
  });

  it("versions workflows", () => {
    saveWorkflow(db, { name: "job-scan", version: 1, definitionYaml: "steps: []" });
    saveWorkflow(db, { name: "job-scan", version: 2, definitionYaml: "steps: [scan]" });
    expect(saveWorkflow(db, { name: "job-scan", version: 1, definitionYaml: "steps: []" }).version).toBe(1);
    expect(() => saveWorkflow(db, { name: "job-scan", version: 1, definitionYaml: "changed" })).toThrow();
    expect(getWorkflow(db, "job-scan")?.version).toBe(2);
    expect(getWorkflow(db, "job-scan", 1)?.definitionYaml).toBe("steps: []");
    expect(getWorkflow(db, "nope")).toBeUndefined();
  });
});

describe("engine_state (UC-16)", () => {
  it("defaults to unpaused for both engines", () => {
    expect(listEngineStates(db)).toEqual([
      { engine: "claude", pausedUntil: null, reason: null },
      { engine: "codex", pausedUntil: null, reason: null },
    ]);
  });

  it("pauses until a reset time, reports due engines, and resumes", () => {
    pauseEngine(db, "claude", { until: at(3600), reason: "utilization 0.96" });
    expect(getEngineState(db, "claude")).toEqual({ engine: "claude", pausedUntil: at(3600).toISOString(), reason: "utilization 0.96" });
    expect(isEnginePaused(db, "claude", { now: at(10) })).toBe(true);
    expect(isEnginePaused(db, "codex", { now: at(10) })).toBe(false);
    expect(enginesDueToResume(db, { now: at(10) })).toEqual([]);
    expect(enginesDueToResume(db, { now: at(3600) })).toEqual(["claude"]);
    expect(isEnginePaused(db, "claude", { now: at(3601) })).toBe(false);
    resumeEngine(db, "claude");
    expect(getEngineState(db, "claude").pausedUntil).toBeNull();
    expect(enginesDueToResume(db, { now: at(9999) })).toEqual([]);
  });
});
