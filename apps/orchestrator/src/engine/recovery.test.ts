// UC-18 and PM S2: a crash mid-run, then a restart. Every finished step was persisted, so the run
// continues from there; an interrupted task re-runs as a new attempt; an interrupted Apply is
// never re-run: its application needs a check. A "crash" here abandons the first engine (its
// in-memory state is lost) and starts a new one on the same database.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSearchProfile, getApplication, getRun, getSubmissionRecord, getTask, openDb } from "../db/index.js";
import { seedBots } from "../db/test-helpers.js";
import { FakeClock } from "./testing/fake-clock.js";
import { createTestEngine } from "./testing/harness.js";

const T0 = new Date("2026-10-10T08:00:00.000Z");

async function settleSomeWork(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

describe("crash recovery (UC-18)", () => {
  it("a run continues from its last finished step; the interrupted task re-runs as attempt 2", async () => {
    // The first process: CV is running when it dies (its clock never moves again).
    const first = await createTestEngine({ clock: new FakeClock(T0) });
    first.runner.script({ bot: "cv", kind: "tailor", delayMs: 3600_000 });
    const run = first.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await settleSomeWork();
    const cv = first.tasks("cv.tailor")[0]!;
    expect(cv.status).toBe("running");
    const before = first.runner.calls.map((c) => `${c.bot.name}.${c.kind}`);
    expect(before).toEqual(["research.scan", "research.fit", "research.company", "cv.tailor"]);

    const killed: number[] = [];
    const second = await createTestEngine({ db: first.db, files: first.files, clock: new FakeClock(new Date(T0.getTime() + 60_000)), processes: { killGroup: (pid) => killed.push(pid) } });
    await second.idle();
    // Nothing that finished ran again; only the CV task did, as a new attempt.
    expect(second.runner.calls.map((c) => `${c.bot.name}.${c.kind}`)).toEqual(["cv.tailor", "qa.review"]);
    expect(getTask(second.db, cv.id)).toMatchObject({ status: "done", attempt: 2 });
    expect(second.events("task.finished").find((e) => e.taskId === String(cv.id))).toMatchObject({ status: "interrupted", attempt: 1 });
    // The CLI the first process spawned is stopped by its pid (W2b `started` event).
    expect(killed).toEqual([40_004]);
    expect(second.review(run.id, 1)).toMatchObject({ qaPassed: true });
    expect(getRun(second.db, run.id)?.status).toBe("waiting");
  });

  it("an interrupted Apply is never re-run: needs_check, no record, the run finishes (PM S2, FYI c)", async () => {
    const first = await createTestEngine({ clock: new FakeClock(T0) });
    const run = first.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await first.idle();
    // It had opened the job's page (a navigate) when the restart came.
    first.runner.script({ bot: "apply", kind: "submit", delayMs: 3600_000, events: [{ type: "tool", name: "mcp__claude-in-chrome__navigate", status: "started", summary: null }] });
    const { applicationId, taskId } = first.engine.approve(1, { cvVersionId: first.review(run.id, 1)!.cvVersions[0]!.cvVersionId, introText: null });
    await settleSomeWork();
    expect(getTask(first.db, taskId!)?.status).toBe("running");

    const second = await createTestEngine({ db: first.db, files: first.files, clock: new FakeClock(new Date(T0.getTime() + 60_000)), start: false });
    const report = await second.engine.start();
    await second.idle();
    expect(report).toMatchObject({ needsCheck: [taskId], needsCheckApplications: [applicationId], requeued: [], exhausted: [] });
    // A second start would mark this engine's own running tasks interrupted: refused.
    await expect(second.engine.start()).rejects.toThrow(/already started/);
    expect(second.runner.callsFor("apply.submit")).toEqual([]);
    expect(getTask(second.db, taskId!)?.status).toBe("interrupted");
    expect(getApplication(second.db, applicationId!)).toMatchObject({
      status: "needs_check",
      statusHistory: expect.arrayContaining([expect.objectContaining({ status: "needs_check", note: "interrupted by restart; it may already have been submitted" })]),
    });
    expect(getSubmissionRecord(second.db, applicationId!)?.submission).toBeUndefined();
    expect(second.step(run.id, "apply", "1")).toMatchObject({ status: "done", output: expect.objectContaining({ outcome: "needs_check" }) });
    expect(second.step(run.id, "record", "1")?.status).toBe("skipped");
    expect(getRun(second.db, run.id)?.status).toBe("done");
  });

  it("live 2026-10-20: an Apply a restart stopped before it opened any job-site page is not submitted (failed, Apply again), never needs_check", async () => {
    const first = await createTestEngine({ clock: new FakeClock(T0) });
    const run = first.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await first.idle();
    // Chrome never answered: tabs_context_mcp timed out twice, tabs_create_mcp had just started.
    const chrome = (name: string, status: "started" | "error") => ({ type: "tool" as const, name: `mcp__claude-in-chrome__${name}`, status, summary: null });
    first.runner.script({ bot: "apply", kind: "submit", delayMs: 3600_000, events: [chrome("tabs_context_mcp", "started"), chrome("tabs_context_mcp", "error"), chrome("tabs_context_mcp", "started"), chrome("tabs_context_mcp", "error"), chrome("tabs_create_mcp", "started")] });
    const { applicationId, taskId } = first.engine.approve(1, { cvVersionId: first.review(run.id, 1)!.cvVersions[0]!.cvVersionId, introText: null });
    await settleSomeWork();

    const second = await createTestEngine({ db: first.db, files: first.files, clock: new FakeClock(new Date(T0.getTime() + 60_000)), start: false });
    await second.engine.start();
    await second.idle();
    expect(second.runner.callsFor("apply.submit")).toEqual([]);
    expect(getTask(second.db, taskId!)?.status).toBe("interrupted");
    const app = getApplication(second.db, applicationId!)!;
    expect(app.status).toBe("failed");
    expect(app.statusHistory.map((h) => h.status)).not.toContain("needs_check");
    expect(second.step(run.id, "apply", "1")).toMatchObject({ status: "failed", output: expect.objectContaining({ outcome: "not_started" }) });
    const texts = second.events("message.created").map((e) => e.message.text);
    expect(texts.some((t) => /was not submitted: a restart stopped Apply before it opened any page of the job site\. Open Applications and use Apply again\./.test(t))).toBe(true);
    expect(texts.some((t) => /needs a check/.test(t))).toBe(false);
  });

  it("probe P5: a crash after a CV attempt changed a protected page is caught at start-up: safety event, Lead alert, no new attempt (PM2 S4)", async () => {
    const first = await createTestEngine({ clock: new FakeClock(T0) });
    first.runner.script({ bot: "cv", kind: "tailor", delayMs: 3600_000 });
    first.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await settleSomeWork();
    const cv = first.tasks("cv.tailor")[0]!;
    expect(cv.status).toBe("running");
    // The bot changed a template, then the orchestrator died before its after-check.
    first.figma.changeProtectedText("Hacked title");

    const second = await createTestEngine({ db: first.db, files: first.files, clock: new FakeClock(new Date(T0.getTime() + 60_000)), start: false });
    second.figma.pages = structuredClone(first.figma.pages); // Figma itself kept the change
    await second.engine.start();
    await second.idle();
    expect(second.runner.callsFor("cv.tailor")).toEqual([]);
    expect(getTask(second.db, cv.id)).toMatchObject({ status: "failed", error: expect.stringMatching(/protected Figma pages changed/) });
    expect(second.events("safety.denied")).toEqual([expect.objectContaining({ taskId: String(cv.id), reason: "protected_page_changed" })]);
    expect(second.events("message.created").map((e) => e.message.text)).toContainEqual(expect.stringMatching(/protected Figma page/));
  });

  it("an unchanged Figma file after a crash lets the CV task run again as attempt 2 (PM2 S4)", async () => {
    const first = await createTestEngine({ clock: new FakeClock(T0) });
    first.runner.script({ bot: "cv", kind: "tailor", delayMs: 3600_000 });
    first.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await settleSomeWork();
    const cv = first.tasks("cv.tailor")[0]!;
    const second = await createTestEngine({ db: first.db, files: first.files, clock: new FakeClock(new Date(T0.getTime() + 60_000)) });
    await second.idle();
    expect(getTask(second.db, cv.id)).toMatchObject({ status: "done", attempt: 2 });
    expect(second.events("safety.denied")).toEqual([]);
  });

  it("with Figma closed at start-up, the CV task's next spawn compares against the persisted before-hash (PM2 S4)", async () => {
    const first = await createTestEngine({ clock: new FakeClock(T0) });
    first.runner.script({ bot: "cv", kind: "tailor", delayMs: 3600_000 });
    first.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await settleSomeWork();
    const cv = first.tasks("cv.tailor")[0]!;
    first.figma.changeProtectedText("Hacked title");

    const second = await createTestEngine({ db: first.db, files: first.files, clock: new FakeClock(new Date(T0.getTime() + 60_000)), start: false });
    second.figma.pages = structuredClone(first.figma.pages);
    second.figma.connected = false;
    await second.engine.start();
    await second.idle();
    expect(getTask(second.db, cv.id)?.status).toBe("paused");
    second.figma.connected = true;
    second.clock.advance(15_000);
    await second.idle();
    expect(second.runner.callsFor("cv.tailor")).toEqual([]);
    expect(getTask(second.db, cv.id)).toMatchObject({ status: "failed" });
    expect(second.events("safety.denied")).toEqual([expect.objectContaining({ reason: "protected_page_changed" })]);
  });

  it("the CLI sessions a crash left behind are removed: the runners kept them only for a repair (UC-18)", async () => {
    const first = await createTestEngine({ clock: new FakeClock(T0) });
    first.runner.script({ bot: "cv", kind: "tailor", delayMs: 3600_000 });
    first.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await settleSomeWork();
    const cv = first.tasks("cv.tailor")[0]!;
    expect(cv.status).toBe("running");

    const second = await createTestEngine({ db: first.db, files: first.files, clock: new FakeClock(new Date(T0.getTime() + 60_000)), start: false });
    const removing: Array<{ engine: string; sessionId: string }> = [];
    second.runner.removeSession = async (sessionId) => {
      removing.push({ engine: "fake", sessionId });
    };
    const report = await second.engine.start();
    await second.idle();
    // Only the crashed attempt's session: the finished tasks' runners removed theirs themselves.
    expect(removing).toEqual([{ engine: "fake", sessionId: `fake-${cv.id}-1` }]);
    expect(report.orphanSessions).toEqual([`fake-${cv.id}-1`]);
  });

  it("a failing session cleanup never stops the start-up", async () => {
    const first = await createTestEngine({ clock: new FakeClock(T0) });
    first.runner.script({ bot: "research", kind: "fit", delayMs: 3600_000 });
    first.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await settleSomeWork();
    const second = await createTestEngine({ db: first.db, files: first.files, clock: new FakeClock(new Date(T0.getTime() + 60_000)), start: false });
    second.runner.removeSession = async () => {
      throw new Error("disk full");
    };
    await expect(second.engine.start()).resolves.toMatchObject({ requeued: [first.tasks("research.fit")[0]!.id] });
    await second.idle();
    expect(second.tasks("research.fit")[0]!.status).toBe("done");
  });

  it("works across a real restart of a file database", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bsja-engine-recover-"));
    try {
      const path = join(dir, "app.db");
      const db1 = openDb(path);
      seedBots(db1);
      const first = await createTestEngine({ db: db1, clock: new FakeClock(T0) });
      // A profile is needed on this fresh file database.
      createSearchProfile(db1, { roles: ["Frontend Engineer"], locations: ["Ho Chi Minh City"], sources: ["itviec"] });
      first.runner.script({ bot: "research", kind: "fit", delayMs: 3600_000 });
      const run = first.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
      await settleSomeWork();
      first.engine.stop();
      db1.$client.close(); // the crash

      const db2 = openDb(path);
      const second = await createTestEngine({ db: db2, files: first.files, clock: new FakeClock(new Date(T0.getTime() + 60_000)) });
      await second.idle();
      expect(second.runner.calls.map((c) => `${c.bot.name}.${c.kind}`)).toEqual(["research.fit", "research.company", "cv.tailor", "qa.review"]);
      expect(second.review(run.id, 1)).toBeDefined();
      db2.$client.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
