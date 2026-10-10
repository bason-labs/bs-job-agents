// PM2 M5 (UC-03 a, §1.2 success 1, §7.4 / UC-02 a): one source waiting for Ba (a login, a CAPTCHA)
// never stalls the scan. The others continue to review cards; the waiting source is listed as
// "waiting for Ba", not as a failure; later scheduled scans are not skipped as an overlap; when Ba
// clicks Done and that scan finishes, its jobs get a follow-up pass in the same run
// (dedupe → fit → top → per-job branches).
import type { JobCandidate } from "@bs-job-agents/shared";
import { researchScanFixture } from "@bs-job-agents/shared/fixtures";
import { describe, expect, it } from "vitest";
import { createSchedule, getRun, getSchedule, getTask } from "../db/index.js";
import type { JoinStepOutput, MapStepOutput } from "./state.js";
import { fake } from "./testing/fake-runner.js";
import { createTestEngine, type TestEngine } from "./testing/harness.js";

const T0 = new Date("2026-10-10T08:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms).toISOString();
const HOUR = 3600_000;

const KITE: JobCandidate = {
  source: "linkedin",
  url: "https://www.linkedin.com/jobs/view/4012345678",
  title: "Frontend Engineer (React)",
  company: "Kite Labs",
  companyWebsite: null,
  location: "Ho Chi Minh City",
  workMode: "remote",
  salaryText: null,
  postedAt: null,
  language: "en",
  jdText: "Build React and Next.js product features with TypeScript. 3+ years.",
};

const isLinkedIn = (task: { input: unknown }) => (task.input as { source?: string }).source === "linkedin";

/** itviec answers at once; linkedin shows a sign-in wall the first time, then (after Done) `late`. */
async function scanWithLogin(late: () => ReturnType<typeof fake.ok> = () => fake.ok({ ...researchScanFixture, jobs: [KITE] })) {
  const t = await createTestEngine({ sources: ["itviec", "linkedin"] });
  t.runner.script({ bot: "research", kind: "scan", when: isLinkedIn, result: () => late() });
  t.runner.script({ bot: "research", kind: "scan", when: isLinkedIn, times: 1, result: fake.needsLogin("linkedin.com") });
  return t;
}

const linkedInTask = (t: TestEngine) => t.tasks("research.scan").find(isLinkedIn)!;

describe("a source waiting for Ba never stalls the scan (PM2 M5)", () => {
  it("probe P4: itviec's card appears while linkedin waits for a login, and the next scheduled slot fires", async () => {
    const t = await scanWithLogin();
    const s = createSchedule(t.db, { name: "Hourly", cron: "0 * * * *", workflowName: "job-scan", nextRunAt: at(0) });
    const first = t.engine.scheduler.tick().fired[0]!;
    await t.idle();

    // itviec's job reached its review card; linkedin waits for Ba (UC-17), it did not fail.
    expect(t.review(first.runId, 1)).toBeDefined();
    expect(t.events("review.ready").map((e) => e.company)).toEqual(["NovaPay"]);
    expect(getTask(t.db, linkedInTask(t).id)).toMatchObject({ status: "paused", pauseReason: "needs_login(linkedin.com)" });
    const scan = t.step(first.runId, "scan")!;
    expect(scan.status).toBe("done");
    expect((scan.output as MapStepOutput).items.map((i) => i.status)).toEqual(["done", "waiting"]);
    const join = t.step(first.runId, "scan-join")!;
    expect(join.output as JoinStepOutput).toMatchObject({ results: [expect.anything()], failures: [], waiting: [expect.objectContaining({ reason: "needs_login(linkedin.com)" })] });
    expect(t.events("step.finished").find((e) => e.stepKey === "scan-join")?.preview).toBe("1 ok, 1 waiting for Ba");
    expect(getRun(t.db, first.runId)?.status).toBe("waiting");

    // The next slot is not an overlap: the scan phase only waits for Ba.
    t.clock.advance(HOUR);
    expect(t.events("schedule.fired").map((e) => e.scheduleId)).toEqual([String(s.id), String(s.id)]);
    expect(t.events("schedule.skipped")).toEqual([]);
    expect(getSchedule(t.db, s.id)?.lastRunId).not.toBe(first.runId);
  });

  it("after Ba's Done the late scan's jobs get a follow-up pass in the same run: dedupe, fit, top and their own branch", async () => {
    const t = await scanWithLogin();
    const run = t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    const linkedin = linkedInTask(t);
    t.engine.resumeTask(linkedin.id);
    await t.idle();

    const pass = `late-${linkedin.id}`;
    expect(t.step(run.id, "scan", pass)).toMatchObject({ status: "done" });
    expect(t.step(run.id, "dedupe", pass)?.output).toMatchObject({ items: [expect.objectContaining({ company: "Kite Labs" })] });
    expect(t.step(run.id, "top", pass)?.output).toMatchObject({ items: [expect.objectContaining({ company: "Kite Labs" })] });
    // The main pass is left as it was: its scan now lists linkedin as done in that pass.
    expect((t.step(run.id, "scan")!.output as MapStepOutput).items.map((i) => [i.status, i.pass ?? null])).toEqual([
      ["done", null],
      ["done", pass],
    ]);
    // Kite Labs got its own branch and review card in run 1.
    const kite = t.events("review.ready").find((e) => e.company === "Kite Labs")!;
    expect(kite.runId).toBe(String(run.id));
    expect(t.review(run.id, Number(kite.jobId))).toBeDefined();
    expect(t.runner.callsFor("research.scan")).toHaveLength(3);
    expect(getRun(t.db, run.id)?.status).toBe("waiting");

    // Ba decides both cards: the run finishes with both jobs counted.
    t.engine.skip(1, { reason: "salary_low", note: null });
    t.engine.skip(Number(kite.jobId), { reason: "location", note: null });
    await t.idle();
    expect(t.events("run.finished")).toEqual([expect.objectContaining({ runId: String(run.id), status: "done", summary: "2 jobs, 2 skipped" })]);
  });

  it("the run stays open while a source waits, even when every other card is decided", async () => {
    const t = await scanWithLogin(() => fake.ok({ ...researchScanFixture, jobs: [] }));
    const run = t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    t.engine.skip(1, { reason: "salary_low", note: null });
    await t.idle();
    expect(getRun(t.db, run.id)?.status).toBe("waiting");
    expect(t.events("run.finished")).toEqual([]);

    t.engine.resumeTask(linkedInTask(t).id);
    await t.idle();
    // Zero results is a success with an empty list (UC-03 d): the late pass has nothing to do.
    expect(t.events("run.finished")).toEqual([expect.objectContaining({ status: "done", summary: "1 job, 1 skipped" })]);
  });

  it("a late scan that fails after Done is recorded as failed; the run finishes without a follow-up pass", async () => {
    const t = await scanWithLogin(() => fake.failed("LinkedIn layout changed"));
    const run = t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    const linkedin = linkedInTask(t);
    t.engine.resumeTask(linkedin.id);
    t.engine.skip(1, { reason: "salary_low", note: null });
    await t.idle();
    expect(getTask(t.db, linkedin.id)).toMatchObject({ status: "failed", attempt: 2 });
    expect((t.step(run.id, "scan")!.output as MapStepOutput).items.map((i) => i.status)).toEqual(["done", "failed"]);
    expect(t.step(run.id, "scan", `late-${linkedin.id}`)).toBeUndefined();
    expect(getRun(t.db, run.id)?.status).toBe("done");
  });

  it("when every source waits for Ba the scan waits too (no empty join), and it still does not block the next slot", async () => {
    const t = await createTestEngine({ sources: ["linkedin"] });
    t.runner.script({ bot: "research", kind: "scan", times: 1, result: fake.needsLogin("linkedin.com") });
    const s = createSchedule(t.db, { name: "Hourly", cron: "0 * * * *", workflowName: "job-scan", nextRunAt: at(0) });
    const first = t.engine.scheduler.tick().fired[0]!;
    await t.idle();
    expect(t.step(first.runId, "scan")?.status).toBe("running");
    expect(t.step(first.runId, "scan-join")).toBeUndefined();
    expect(getRun(t.db, first.runId)?.status).toBe("waiting");
    t.clock.advance(HOUR);
    expect(t.events("schedule.fired")).toHaveLength(2);
    expect(t.events("schedule.skipped")).toEqual([]);
    expect(s.id).toBeGreaterThan(0);
  });

  it("a source still scanning (not waiting for Ba) keeps the overlap rule", async () => {
    const t = await createTestEngine({ sources: ["itviec", "linkedin"] });
    t.runner.script({ bot: "research", kind: "scan", when: isLinkedIn, times: 1, delayMs: 2 * HOUR });
    const s = createSchedule(t.db, { name: "Hourly", cron: "0 * * * *", workflowName: "job-scan", nextRunAt: at(0) });
    t.engine.scheduler.tick();
    await t.flush();
    t.db.$client.prepare("UPDATE schedules SET next_run_at = ? WHERE id = ?").run(at(0), s.id);
    expect(t.engine.scheduler.tick()).toMatchObject({ fired: [], skipped: [{ scheduleId: s.id, reason: "overlap" }] });
  });
});
