// The task queue (§5.5, §10.1, §10.3): caps, locks, bridge waits, attempts, timeouts, and the
// CV task's Figma flow (§6.2, coordinator B) with its guard hooks (coordinator A, E).
import { qaFailFixture, researchScanFixture } from "@bs-job-agents/shared/fixtures";
import { describe, expect, it } from "vitest";
import { getRun, getTask, listTasks, updateBot } from "../db/index.js";
import { defaultFakeResult, fake, fakeFrameName } from "./testing/fake-runner.js";
import { createTestEngine, type TestEngineOptions } from "./testing/harness.js";

const NOVAPAY = researchScanFixture.jobs[0]!;
const pass = (item: string) => ({ item, passed: true, note: null });

/** A scan output with `n` distinct jobs. */
function manyJobs(n: number) {
  return fake.ok({
    jobs: Array.from({ length: n }, (_, i) => ({ ...NOVAPAY, url: `https://itviec.com/it-jobs/frontend-${i + 1}`, title: `Frontend Engineer ${i + 1}` })),
    pageViews: n,
    blocked: null,
    selfCheck: [pass("Every job has a reachable URL")],
    memoryNotes: [],
  });
}

async function scan(opts: TestEngineOptions = {}) {
  const t = await createTestEngine(opts);
  const run = t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
  return { t, run };
}

describe("concurrency (§10.3)", () => {
  it("at most 2 sessions per engine by default", async () => {
    const t = await createTestEngine({ start: true });
    t.runner.script({ bot: "research", kind: "scan", result: manyJobs(3) });
    t.runner.script({ bot: "research", kind: "fit", delayMs: 1000 });
    t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(listTasks(t.db, { status: "running" }).map((x) => x.kind)).toEqual(["fit", "fit"]);
    expect(t.engine.queue.running("codex")).toBe(2);
    t.clock.advance(1000);
    await new Promise((r) => setImmediate(r));
    t.clock.advance(1000);
    await t.idle();
    expect(t.runner.maxConcurrent("research.fit")).toBe(2);
    expect(t.tasks("research.fit")).toHaveLength(3);
  });

  it("a task runs on the engine it was queued on, even if Ba switches the bot's engine meanwhile", async () => {
    const t = await createTestEngine();
    t.browser.set("codex", false);
    t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    updateBot(t.db, "research", { engine: "claude" });
    t.browser.set("codex", true);
    t.clock.advance(15_000);
    await t.idle();
    expect(t.runner.callsFor("research.scan")[0]!.bot.engine).toBe("codex");
    // Tasks queued after the switch use the new engine.
    expect(t.tasks("research.fit")[0]?.engine).toBe("claude");
    expect(t.runner.callsFor("research.fit")[0]!.bot.engine).toBe("claude");
  });

  it("caps are configurable", async () => {
    const t = await createTestEngine({ config: { engineCaps: { claude: 2, codex: 1 } } });
    t.runner.script({ bot: "research", kind: "scan", result: manyJobs(3) });
    t.runner.script({ bot: "research", kind: "fit", delayMs: 10 });
    t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setImmediate(r));
      t.clock.advance(10);
    }
    await t.idle();
    expect(t.runner.maxConcurrent("research.fit")).toBe(1);
  });

  it("the browser lock runs one Chrome task at a time, even under the cap", async () => {
    const { t } = await scan({ sources: ["topcv", "itviec", "linkedin"] });
    t.runner.script({ bot: "research", kind: "scan", delayMs: 100 });
    // The first scan was claimed before the script; release it, then step the clock.
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setImmediate(r));
      t.clock.advance(100);
    }
    await t.idle();
    expect(t.runner.maxConcurrent("research.scan")).toBe(1);
    expect(t.tasks("research.scan").every((x) => x.status === "done")).toBe(true);
  });

  it("the Figma lock runs one CV task at a time (VI JD: VI and EN gates)", async () => {
    const t = await createTestEngine({ sources: ["topcv"] });
    t.runner.script({ bot: "cv", kind: "tailor", delayMs: 50 });
    t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setImmediate(r));
      t.clock.advance(50);
    }
    await t.idle();
    expect(t.tasks("cv.tailor")).toHaveLength(2);
    expect(t.runner.maxConcurrent("cv.tailor")).toBe(1);
    // The lock also covered the orchestrator's own calls: one export per CV, in turn.
    expect(t.figma.calls.filter((c) => c.startsWith("export:"))).toHaveLength(2);
  });
});

describe("bridge waits (§4.4, §6.2, §10.3, UC-17)", () => {
  it("Chrome not connected: the scan waits as needs_browser and starts by itself on reconnect", async () => {
    const t = await createTestEngine();
    t.browser.set("codex", false);
    const run = t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    const task = t.tasks("research.scan")[0]!;
    expect(task).toMatchObject({ status: "paused", pauseReason: "needs_browser" });
    expect(t.events("bridge.status")).toEqual([expect.objectContaining({ bridge: "chrome", engine: "codex", connected: false })]);
    expect(getRun(t.db, run.id)?.status).toBe("waiting");
    expect(t.runner.calls).toHaveLength(0);

    t.clock.advance(15_000); // still down
    await t.idle();
    expect(getTask(t.db, task.id)?.status).toBe("paused");

    t.browser.set("codex", true);
    t.clock.advance(15_000);
    await t.idle();
    expect(getTask(t.db, task.id)).toMatchObject({ status: "done", attempt: 1 });
    expect(t.events("bridge.status").at(-1)).toMatchObject({ connected: true });
    expect(t.events("task.resumed").map((e) => e.taskId)).toContain(String(task.id));
  });

  it("Figma not connected: the CV task waits as needs_figma with the bridge's message", async () => {
    const t = await createTestEngine();
    t.figma.connected = false;
    t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    const cv = t.tasks("cv.tailor")[0]!;
    expect(cv).toMatchObject({ status: "paused", pauseReason: "needs_figma" });
    expect(t.events("task.paused").at(-1)).toMatchObject({ reason: { code: "needs_figma", detail: expect.stringMatching(/Desktop Bridge/) } });
    t.figma.connected = true;
    t.clock.advance(15_000);
    await t.idle();
    expect(getTask(t.db, cv.id)?.status).toBe("done");
    expect(t.review(1, 1)).toBeDefined();
  });

  it("Figma going away during the orchestrator's export: needs_figma, then the CV task runs again (no attempt used)", async () => {
    const t = await createTestEngine();
    t.figma.unavailableOnce = "export";
    t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    const cv = t.tasks("cv.tailor")[0]!;
    expect(cv).toMatchObject({ status: "paused", pauseReason: "needs_figma", output: { figmaBeforeHash: expect.any(String) } });
    t.clock.advance(15_000);
    await t.idle();
    expect(getTask(t.db, cv.id)).toMatchObject({ status: "done", attempt: 1 });
    expect(t.runner.callsFor("cv.tailor")).toHaveLength(2);
  });
});

describe("attempts (§5.5 step 6, §10.1)", () => {
  it("a failed attempt is retried once; the second attempt can succeed", async () => {
    const t = await createTestEngine();
    t.runner.script({ bot: "research", kind: "fit", times: 1, result: fake.invalidOutput() });
    t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    expect(t.tasks("research.fit")[0]).toMatchObject({ status: "done", attempt: 2 });
    expect(t.events("task.finished").filter((e) => e.botName === "research" && e.status === "failed")).toEqual([
      expect.objectContaining({ attempt: 1, error: expect.stringMatching(/invalid output/) }),
    ]);
  });

  it("two failed attempts fail the task; a job's only fit failing ends the run (UC-04, §7.1 join)", async () => {
    const t = await createTestEngine();
    t.runner.script({ bot: "research", kind: "fit", result: fake.selfCheckFailed({}, ["Every reason cites master data"]) });
    const run = t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    expect(t.runner.callsFor("research.fit")).toHaveLength(2);
    expect(t.tasks("research.fit")[0]).toMatchObject({ status: "failed", attempt: 2, error: expect.stringMatching(/self-check failed/) });
    expect(getRun(t.db, run.id)).toMatchObject({ status: "failed", error: expect.stringMatching(/^fit-join/) });
  });

  it("attempts are not QA rounds: a timed-out round 2 is retried inside the round", async () => {
    const t = await createTestEngine();
    t.runner.script({ bot: "qa", kind: "review", times: 1, result: fake.ok(qaFailFixture) });
    t.runner.script({ bot: "cv", kind: "tailor", when: (task) => (task.input as { round: number }).round === 2 && task.attempt === 1, result: fake.timeout() });
    t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    const tailors = t.tasks("cv.tailor");
    expect(tailors.map((x) => [(x.input as { round: number }).round, x.attempt, x.status])).toEqual([
      [1, 1, "done"],
      [2, 2, "done"],
    ]);
    expect(t.step(1, "tailor", "1:en")?.output).toMatchObject({ outcome: "passed", rounds: [expect.objectContaining({ round: 1 }), expect.objectContaining({ round: 2 })] });
  });

  it("a runner that never returns is stopped after its timeout and counts as a timed-out attempt", async () => {
    const t = await createTestEngine();
    t.runner.script({ bot: "research", kind: "fit", times: 1, delayMs: 24 * 3600_000 });
    t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(t.tasks("research.fit")[0]?.status).toBe("running");
    t.clock.advance(600_000 + 30_000);
    await t.idle();
    expect(t.events("task.finished").find((e) => e.botName === "research" && e.status === "failed")).toMatchObject({ error: "timed out", attempt: 1 });
    expect(t.tasks("research.fit")[0]).toMatchObject({ status: "done", attempt: 2 });
  });

  it("runner events become task.progress events, and the spawned pid is kept for recovery", async () => {
    const t = await createTestEngine();
    t.runner.script({
      bot: "research",
      kind: "company",
      events: [
        { type: "progress", text: "Reading the careers page" },
        { type: "tool", name: "web_search", status: "started", summary: "NovaPay reviews" },
      ],
    });
    t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    const company = t.tasks("research.company")[0]!;
    expect(t.events("task.progress").filter((e) => e.taskId === String(company.id)).map((e) => [e.kind, e.text, e.tool])).toEqual([
      ["status", "Research started on codex", null],
      ["text", "Reading the careers page", null],
      ["tool_use", "NovaPay reviews", "web_search"],
    ]);
    expect(company.transcriptPath).toBe(`transcripts/${company.id}-1.jsonl`);
  });
});

describe("the CV task's Figma flow (§6.2, coordinator B)", () => {
  it("templates from the before-fingerprint go in the input; the Figma guard is set up for the task", async () => {
    const { t } = await scan();
    await t.idle();
    const call = t.runner.callsFor("cv.tailor")[0]!;
    expect(call.input).toMatchObject({ templates: [expect.objectContaining({ id: "459:1767", width: 595, height: 842 })] });
    expect(t.figma.calls.slice(0, 3)).toEqual(["status", "ensureDraftsPage", "fingerprint"]);
    expect(t.guards.figmaCalls).toEqual([
      { dir: `/data/tasks/${call.taskId}`, logFile: `/data/transcripts/${call.taskId}-1.guard.jsonl`, draftsPageId: "900:1", fingerprintHash: expect.any(String) },
    ]);
    expect(call.hookSettings).toMatchObject({ hooks: { PreToolUse: [expect.objectContaining({ matcher: "mcp__figma__.*" })] } });
    expect(call.readDirs).toEqual([`/data/tasks/${call.taskId}`]);
    expect(t.files.read(`/data/tasks/${call.taskId}/master-cv.yaml`)).toMatch(/facts/);
    // Research runs on Codex: no hook mechanism there (§4.4, prompt-only allowlist).
    expect(t.runner.callsFor("research.scan")[0]!.hookSettings).toBeUndefined();
    expect(t.runner.callsFor("research.scan")[0]!.allowedSites).toEqual(["topcv.vn", "itviec.com", "linkedin.com"]);
  });

  it("a protected page changed during the CV task: the task fails, no retry, safety.denied with the diff, Ba is alerted", async () => {
    const { t, run } = await scan();
    t.runner.script({
      bot: "cv",
      kind: "tailor",
      result: (task) => {
        t.figma.changeProtectedText("Hacked title");
        return defaultFakeResult(task);
      },
    });
    await t.idle();
    expect(t.runner.callsFor("cv.tailor")).toHaveLength(1);
    expect(t.tasks("cv.tailor")[0]).toMatchObject({ status: "failed", error: expect.stringMatching(/change.* on protected pages/) });
    expect(t.events("safety.denied")).toEqual([expect.objectContaining({ reason: "protected_page_changed", detail: expect.stringMatching(/Professional title/) })]);
    expect(getRun(t.db, run.id)?.status).toBe("failed");
    // Ba is alerted in the Lead chat.
    expect(t.events("message.created").at(-1)).toMatchObject({ message: { author: { type: "bot", bot: "lead" }, text: expect.stringMatching(/protected Figma page changed/) } });
  });

  it("an export that is not one A4 page fails the attempt (UC-06 a)", async () => {
    const { t } = await scan();
    t.figma.onePageA4 = false;
    t.figma.pageCount = 2;
    await t.idle();
    expect(t.tasks("cv.tailor")[0]).toMatchObject({ status: "failed", attempt: 2, error: expect.stringMatching(/not one A4 portrait page \(2 page/) });
  });

  it("the bot's frame must be on the Drafts page", async () => {
    const t = await createTestEngine();
    t.figma.missingFrames.add(fakeFrameName({ jobId: "1", job: { company: "NovaPay", title: NOVAPAY.title }, language: "en", round: 1 }));
    t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    expect(t.tasks("cv.tailor")[0]).toMatchObject({ status: "failed", error: expect.stringMatching(/is not on the Drafts page/) });
  });

  it("every block a guard hook logged becomes a safety.denied event; the runner's copy of it is not repeated", async () => {
    const { t } = await scan();
    t.runner.script({
      bot: "cv",
      kind: "tailor",
      result: (task) => {
        t.guards.logBlock(`/data/transcripts/${task.taskId}-${task.attempt}.guard.jsonl`, {
          guard: "figma",
          tool: "mcp__figma__figma_execute",
          rule: "figma_page_name",
          reason: "Only the Drafts page may be changed",
          target: "resume",
        });
        return defaultFakeResult(task);
      },
    });
    await t.idle();
    expect(t.events("safety.denied")).toEqual([
      expect.objectContaining({ reason: "protected_page_blocked", action: "mcp__figma__figma_execute", detail: "figma_page_name · resume · Only the Drafts page may be changed" }),
    ]);
    // A blocked call does not end the session: the CV still made it to the review card.
    expect(t.review(1, 1)).toBeDefined();
  });
});
