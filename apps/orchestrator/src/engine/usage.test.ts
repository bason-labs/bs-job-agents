// UC-16 and §1.2 success 4: a usage limit pauses that engine and the work continues by itself
// after the reset. Fake clock; no engine switching.
import { describe, expect, it } from "vitest";
import { getEngineState, getRun, getTask, listTasks } from "../db/index.js";
import { fake } from "./testing/fake-runner.js";
import { createTestEngine } from "./testing/harness.js";

const T0 = new Date("2026-10-10T08:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms).toISOString();
const MIN = 60_000;

describe("usage-limit watcher (UC-16)", () => {
  it("a usage limit pauses the engine until the reset, holds its tasks, then the run continues by itself", async () => {
    const t = await createTestEngine({ sources: ["itviec"] });
    t.runner.script({ bot: "research", kind: "fit", times: 1, result: fake.usageLimit("codex", at(90 * MIN)) });
    const run = t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();

    expect(getEngineState(t.db, "codex")).toMatchObject({ pausedUntil: at(90 * MIN), reason: "usage_limit" });
    expect(t.events("engine.paused")).toEqual([expect.objectContaining({ engine: "codex", until: at(90 * MIN), reason: "usage_limit" })]);
    const fit = t.tasks("research.fit")[0]!;
    // Not the task's fault: the same attempt waits for the reset (UC-16 step 3).
    expect(fit).toMatchObject({ status: "waiting_limit", attempt: 1 });
    expect(t.events("task.paused").at(-1)).toMatchObject({ taskId: String(fit.id), reason: { code: "usage_limit" } });
    expect(getRun(t.db, run.id)?.status).toBe("waiting");

    t.clock.advance(89 * MIN);
    await t.idle();
    expect(getTask(t.db, fit.id)?.status).toBe("waiting_limit");

    t.clock.advance(1 * MIN);
    await t.idle();
    expect(t.events("engine.resumed")).toEqual([expect.objectContaining({ engine: "codex" })]);
    expect(getTask(t.db, fit.id)).toMatchObject({ status: "done", attempt: 1 });
    expect(t.review(run.id, 1)).toBeDefined();
  });

  it("an unknown reset time retries every 30 minutes (UC-16 step 2)", async () => {
    const t = await createTestEngine();
    t.runner.script({ bot: "research", kind: "fit", times: 2, result: fake.usageLimit("codex", null) });
    t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    expect(getEngineState(t.db, "codex").pausedUntil).toBe(at(30 * MIN));
    t.clock.advance(30 * MIN);
    await t.idle();
    // Still limited: paused again for another 30 minutes.
    expect(getEngineState(t.db, "codex").pausedUntil).toBe(at(60 * MIN));
    t.clock.advance(30 * MIN);
    await t.idle();
    expect(t.tasks("research.fit")[0]).toMatchObject({ status: "done", attempt: 1 });
    expect(t.events("engine.paused")).toHaveLength(2);
  });

  it("pauses before the wall at 95 % utilization; the running task still finishes (UC-16 step 1)", async () => {
    const t = await createTestEngine();
    t.runner.script({
      bot: "research",
      kind: "scan",
      events: [{ type: "usage", engine: "codex", usage: { fiveHour: 0.96, sevenDay: 0.3, resetsAt: at(45 * MIN) }, limited: false }],
    });
    t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    expect(t.events("engine.usage")).toEqual([expect.objectContaining({ engine: "codex", usage: expect.objectContaining({ fiveHour: 0.96 }) })]);
    expect(t.tasks("research.scan")[0]?.status).toBe("done");
    expect(t.tasks("research.fit")[0]?.status).toBe("waiting_limit");
    t.clock.advance(45 * MIN);
    await t.idle();
    expect(t.tasks("research.fit")[0]?.status).toBe("done");
  });

  it("a usage event marked limited pauses the engine even when the task's own result is ok", async () => {
    const t = await createTestEngine();
    t.runner.script({ bot: "research", kind: "scan", events: [{ type: "usage", engine: "codex", usage: { fiveHour: 0.5, sevenDay: null, resetsAt: null }, limited: true }] });
    t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    expect(getEngineState(t.db, "codex")).toMatchObject({ pausedUntil: at(30 * MIN), reason: "usage_limit" });
    expect(t.tasks("research.scan")[0]?.status).toBe("done");
  });

  it("only that engine pauses: Claude tasks keep running while Codex waits (no engine switching)", async () => {
    const t = await createTestEngine();
    t.runner.script({ bot: "research", kind: "company", times: 1, result: fake.usageLimit("codex", at(60 * MIN)) });
    t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    expect(t.tasks("research.company")[0]?.engine).toBe("codex");
    expect(t.tasks("cv.tailor")).toHaveLength(0);
    expect(getEngineState(t.db, "claude").pausedUntil).toBeNull();
    t.clock.advance(60 * MIN);
    await t.idle();
    expect(listTasks(t.db).every((x) => x.status === "done")).toBe(true);
  });

  it("after a restart, a pause that expired is lifted and one still running is re-armed", async () => {
    const first = await createTestEngine();
    first.runner.script({ bot: "research", kind: "fit", times: 1, result: fake.usageLimit("codex", at(20 * MIN)) });
    first.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await first.idle();
    first.engine.stop();

    // The orchestrator restarts 5 minutes later: the pause is re-armed for the remaining 15.
    const second = await createTestEngine({ db: first.db, files: first.files, clock: first.clock });
    first.clock.advance(5 * MIN);
    await second.idle();
    expect(getEngineState(second.db, "codex").pausedUntil).toBe(at(20 * MIN));
    first.clock.advance(15 * MIN);
    await second.idle();
    expect(second.tasks("research.fit")[0]?.status).toBe("done");
  });

  it("Resume now (Ba switched accounts): clears the pause before the reset, releases held tasks, emits engine.resumed", async () => {
    const t = await createTestEngine({ sources: ["itviec"] });
    t.runner.script({ bot: "research", kind: "fit", times: 1, result: fake.usageLimit("codex", at(90 * MIN)) });
    const run = t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    const fit = t.tasks("research.fit")[0]!;
    expect(fit.status).toBe("waiting_limit");

    t.clock.advance(5 * MIN);
    t.engine.resumeEngineNow("codex");
    await t.idle();
    expect(getEngineState(t.db, "codex")).toMatchObject({ pausedUntil: null, reason: null });
    expect(t.events("engine.resumed")).toEqual([expect.objectContaining({ engine: "codex" })]);
    expect(getTask(t.db, fit.id)).toMatchObject({ status: "done", attempt: 1 });
    expect(t.review(run.id, 1)).toBeDefined();
    expect(t.events("message.created").map((e) => e.message.text)).toContainEqual(expect.stringMatching(/ChatGPT.*resumed.*you/i));
    // The old reset timer does not fire a second resume.
    t.clock.advance(90 * MIN);
    await t.idle();
    expect(t.events("engine.resumed")).toHaveLength(1);
  });

  it("Resume now on an engine that is not paused is refused (invalid state)", async () => {
    const t = await createTestEngine();
    expect(() => t.engine.resumeEngineNow("claude")).toThrow(/not paused/);
    expect(t.events("engine.resumed")).toEqual([]);
  });
});
