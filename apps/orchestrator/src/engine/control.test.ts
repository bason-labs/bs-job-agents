// UC-23: pause, cancel or re-run, on a fake clock.
import { describe, expect, it } from "vitest";
import { getApplication, getRun, getTask, listSteps } from "../db/index.js";
import { fake } from "./testing/fake-runner.js";
import { createTestEngine } from "./testing/harness.js";

async function startScan(t: Awaited<ReturnType<typeof createTestEngine>>) {
  return t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
}

describe("pause, cancel and re-run (UC-23)", () => {
  it("pause: running tasks finish, nothing new starts; resume continues", async () => {
    const t = await createTestEngine();
    t.runner.script({ bot: "research", kind: "scan", delayMs: 1000 });
    const run = await startScan(t);
    await t.flush();
    t.engine.pauseRun(run.id);
    expect(t.events("run.updated").at(-1)).toMatchObject({ status: "paused" });
    t.clock.advance(1000);
    await t.idle();
    expect(t.tasks("research.scan")[0]?.status).toBe("done");
    expect(t.tasks("research.fit")).toEqual([]);
    expect(getRun(t.db, run.id)?.status).toBe("paused");

    t.engine.resumeRun(run.id);
    await t.idle();
    expect(t.review(run.id, 1)).toBeDefined();
  });

  it("cancel: the running task is killed, queued ones fail, steps and the run are cancelled", async () => {
    const t = await createTestEngine({ sources: ["itviec", "topcv"] });
    t.runner.script({ bot: "research", kind: "scan", delayMs: 1000 });
    const run = await startScan(t);
    await t.flush();
    const [first, second] = t.tasks("research.scan");
    expect([first?.status, second?.status]).toEqual(["running", "queued"]); // browser lock
    expect(t.engine.cancelRun(run.id)).toEqual([first!.id]);
    await t.idle();
    expect(getTask(t.db, first!.id)).toMatchObject({ status: "failed", error: "cancelled" });
    expect(getTask(t.db, second!.id)).toMatchObject({ status: "failed", error: "run cancelled" });
    expect(getRun(t.db, run.id)?.status).toBe("cancelled");
    expect(listSteps(t.db, run.id).every((s) => s.status === "cancelled")).toBe(true);
    expect(t.events("run.finished")).toEqual([expect.objectContaining({ status: "cancelled" })]);
  });

  it("cancel while Apply runs: it may have submitted → needs_check; a queued Apply's application → failed", async () => {
    const t = await createTestEngine();
    const run = await startScan(t);
    await t.idle();
    const card = t.review(run.id, 1)!;
    t.runner.script({ bot: "apply", kind: "submit", delayMs: 1000 });
    const { applicationId } = t.engine.approve(1, { cvVersionId: card.cvVersions[0]!.cvVersionId, introText: null });
    await t.flush();
    t.engine.cancelRun(run.id);
    await t.idle();
    expect(getApplication(t.db, applicationId!)?.status).toBe("needs_check");

    const u = await createTestEngine();
    const run2 = await startScan(u);
    await u.idle();
    u.browser.set("claude", false);
    const queued = u.engine.approve(1, { cvVersionId: u.review(run2.id, 1)!.cvVersions[0]!.cvVersionId, introText: null });
    await u.idle(); // waits as needs_browser: never spawned
    u.engine.cancelRun(run2.id);
    expect(getApplication(u.db, queued.applicationId!)?.status).toBe("failed");
  });

  it("re-run a failed step: it and the later steps of its branch run again", async () => {
    const t = await createTestEngine();
    t.runner.script({ bot: "research", kind: "company", times: 2, result: fake.failed("site down") });
    const run = await startScan(t);
    await t.idle();
    const company = t.step(run.id, "company", "1")!;
    expect(company.status).toBe("failed");
    expect(getRun(t.db, run.id)?.status).toBe("failed");

    t.engine.rerunStep(company.id);
    await t.idle();
    expect(t.step(run.id, "company", "1")?.status).toBe("done");
    expect(t.review(run.id, 1)).toBeDefined();
    expect(getRun(t.db, run.id)?.status).toBe("waiting");
  });

  it("Apply and record steps are never re-run; nothing re-runs once Apply started for the job", async () => {
    const t = await createTestEngine();
    const run = await startScan(t);
    await t.idle();
    t.engine.approve(1, { cvVersionId: t.review(run.id, 1)!.cvVersions[0]!.cvVersionId, introText: null });
    await t.idle();
    expect(() => t.engine.rerunStep(t.step(run.id, "apply", "1")!.id)).toThrow(/never re-run/);
    expect(() => t.engine.rerunStep(t.step(run.id, "record", "1")!.id)).toThrow(/never re-run/);
    expect(() => t.engine.rerunStep(t.step(run.id, "company", "1")!.id)).toThrow(/Apply already started/);
    expect(() => t.engine.rerunStep(t.step(run.id, "fit")!.id)).toThrow(/Apply already started/);
  });

  it("only a finished or failed step can be re-run", async () => {
    const t = await createTestEngine();
    t.runner.script({ bot: "research", kind: "scan", delayMs: 1000 });
    const run = await startScan(t);
    await t.flush();
    expect(() => t.engine.rerunStep(t.step(run.id, "scan")!.id)).toThrow(/failed or finished/);
  });
});
