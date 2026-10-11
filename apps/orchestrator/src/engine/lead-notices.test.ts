// PM2 S1 (decision 4): Lead's messages for engine events, posted in the transaction of the state
// change (a crash cannot lose them), one per event class and never one per attempt: the UC-17 card,
// one note per bridge wait, a task that failed for good (§5.5 step 6, UC-03 b), Apply's needs_check
// (also after a crash), the usage-limit pause and resume (UC-16), and the run summary when its
// cards are ready or, without cards, when it ends (UC-02, UC-04 a).
import type { Message, MessageCard } from "@bs-job-agents/shared";
import { applyOutputFixture, researchScanFixture } from "@bs-job-agents/shared/fixtures";
import { describe, expect, it } from "vitest";
import { createSchedule, getTask } from "../db/index.js";
import { fake } from "./testing/fake-runner.js";
import { FakeClock } from "./testing/fake-clock.js";
import { createTestEngine, type TestEngine } from "./testing/harness.js";

const T0 = new Date("2026-10-10T08:00:00.000Z");
const HOUR = 3600_000;
const scanParams = { workflow: "job-scan", params: { searchProfileId: null, overrides: null } } as const;

/** Lead's messages in the Lead chat, as the UI gets them (message.created). */
const lead = (t: TestEngine): Message[] => t.events("message.created").map((e) => e.message).filter((m) => m.author.type === "bot" && m.author.bot === "lead");
const texts = (t: TestEngine) => lead(t).map((m) => m.text);
const cardsOf = (t: TestEngine, type: MessageCard["type"]) => lead(t).flatMap((m) => m.cards.filter((c) => c.type === type));

async function review(opts: Parameters<typeof createTestEngine>[0] = {}) {
  const t = await createTestEngine({ sources: ["itviec"], ...opts });
  const run = t.engine.startWorkflow(scanParams, { trigger: "chat" });
  await t.idle();
  return { t, run, cvVersionId: t.review(run.id, 1)!.cvVersions[0]!.cvVersionId };
}

describe("UC-17 pause cards (S1)", () => {
  it("a source behind a login gets one card with Done; a retry or another source posts nothing more", async () => {
    const t = await createTestEngine({ sources: ["itviec", "linkedin"] });
    t.runner.script({ bot: "research", kind: "scan", when: (task) => (task.input as { source: string }).source === "linkedin", times: 1, result: fake.needsLogin("linkedin.com") });
    t.engine.startWorkflow(scanParams, { trigger: "chat" });
    await t.idle();
    const task = t.tasks("research.scan").find((x) => (x.input as { source: string }).source === "linkedin")!;
    expect(cardsOf(t, "pause")).toEqual([{ type: "pause", taskId: String(task.id), reason: "needs_login(linkedin.com)" }]);
    expect(texts(t)).toContainEqual(expect.stringMatching(/log in to linkedin\.com in your Chrome.*LinkedIn scan.*then click Done/));
  });

  it("a login site the bot names off its allowlist is never put in Lead's mouth: the card names the source's site", async () => {
    const t = await createTestEngine({ sources: ["itviec", "linkedin"] });
    t.runner.script({ bot: "research", kind: "scan", when: (task) => (task.input as { source: string }).source === "linkedin", times: 1, result: fake.needsLogin("https://linkedin-secure-login.com/session") });
    t.engine.startWorkflow(scanParams, { trigger: "chat" });
    await t.idle();
    expect(cardsOf(t, "pause")).toEqual([expect.objectContaining({ reason: "needs_login(linkedin.com)" })]);
    expect(texts(t).join("\n")).not.toMatch(/linkedin-secure-login/);
  });

  it("Apply's login site off its approved domains: the card names the job's site", async () => {
    const { t, cvVersionId } = await review();
    t.runner.script({ bot: "apply", kind: "submit", times: 1, result: fake.applyPaused({ reason: "needs_login", site: "itviec-login.example" }) });
    t.engine.approve(1, { cvVersionId, introText: null });
    await t.idle();
    expect(cardsOf(t, "pause")).toEqual([expect.objectContaining({ reason: "needs_login(itviec.com)" })]);
    expect(texts(t).join("\n")).not.toMatch(/itviec-login/);
  });

  it("Apply's login, CAPTCHA and domain_confirm pauses each get a card; the domain card asks with the host", async () => {
    const { t, cvVersionId } = await review();
    t.runner.script({
      bot: "apply",
      kind: "submit",
      times: 1,
      result: (task) => {
        t.guards.logBlock(`/data/transcripts/${task.taskId}-${task.attempt}.guard.jsonl`, { guard: "site", tool: "mcp__claude-in-chrome__navigate", rule: "navigate_host", reason: "blocked", target: "novapay.breezy.hr" });
        return fake.applyPaused({ reason: "domain_confirm", site: "novapay.breezy.hr" });
      },
    });
    const { taskId } = t.engine.approve(1, { cvVersionId, introText: null });
    await t.idle();
    expect(cardsOf(t, "pause")).toEqual([{ type: "pause", taskId: String(taskId), reason: "domain_confirm(novapay.breezy.hr)" }]);
    expect(texts(t)).toContainEqual("Apply tried to open novapay.breezy.hr, which is not the employer's job site. Allow it for this application?");
  });
});

describe("bridge waits: one note per wait (S1)", () => {
  it("Chrome closed: one note for every task that waits; a new note only after Chrome came back and went away again", async () => {
    const t = await createTestEngine({ sources: ["itviec", "topcv"] });
    t.browser.set("codex", false);
    t.engine.startWorkflow(scanParams, { trigger: "chat" });
    await t.idle();
    expect(t.tasks("research.scan").map((x) => x.pauseReason)).toEqual(["needs_browser", "needs_browser"]);
    expect(texts(t).filter((x) => /Chrome/.test(x))).toEqual([expect.stringMatching(/Chrome is closed or its ChatGPT extension is not connected.*start as soon as/)]);

    t.browser.set("codex", true);
    t.clock.advance(15_000);
    await t.idle();
    expect(texts(t).filter((x) => /Chrome/.test(x))).toHaveLength(1);
  });

  it("Figma not running: one note with what Ba should do", async () => {
    const t = await createTestEngine({ sources: ["topcv"] });
    t.figma.connected = false;
    t.engine.startWorkflow(scanParams, { trigger: "chat" });
    await t.idle();
    // A VI JD: the VI and EN CV tasks both wait for Figma; one note.
    expect(t.tasks("cv.tailor").map((x) => x.pauseReason)).toEqual(["needs_figma", "needs_figma"]);
    expect(texts(t).filter((x) => /Figma/.test(x))).toEqual([expect.stringMatching(/CV steps are waiting.*Desktop Bridge/)]);
  });
});

describe("tasks that failed for good (§5.5 step 6, UC-03 b, S1)", () => {
  it("a source that fails twice: one '<source> scan failed' message, nothing for the first attempt", async () => {
    const t = await createTestEngine({ sources: ["itviec", "topcv"] });
    t.runner.script({ bot: "research", kind: "scan", when: (task) => (task.input as { source: string }).source === "topcv", result: fake.failed("connection reset") });
    t.engine.startWorkflow(scanParams, { trigger: "chat" });
    await t.idle();
    expect(texts(t).filter((x) => /TopCV/.test(x))).toEqual(["TopCV scan failed: connection reset. The other sources go on."]);
  });

  it("an adapter whose self-check fails is reported as broken (UC-03 b)", async () => {
    const t = await createTestEngine({ sources: ["itviec", "topcv"] });
    t.runner.script({
      bot: "research",
      kind: "scan",
      when: (task) => (task.input as { source: string }).source === "topcv",
      result: fake.selfCheckFailed({ ...researchScanFixture, jobs: [] }, ["Every job has full JD text (not a snippet)"]),
    });
    t.engine.startWorkflow(scanParams, { trigger: "chat" });
    await t.idle();
    expect(texts(t).filter((x) => /TopCV/.test(x))).toEqual([expect.stringMatching(/^TopCV adapter broken: Every job has full JD text \(not a snippet\)\. The other sources go on\.$/)]);
  });

  it("a branch's task that fails for good names the job", async () => {
    const t = await createTestEngine({ sources: ["itviec"] });
    t.runner.script({ bot: "research", kind: "company", result: fake.timeout() });
    t.engine.startWorkflow(scanParams, { trigger: "chat" });
    await t.idle();
    expect(texts(t).filter((x) => /NovaPay/.test(x) && /could not/.test(x))).toEqual([expect.stringMatching(/^Research could not profile NovaPay for Senior Frontend Engineer \(React\/Next\.js\): timed out\./)]);
  });
});

describe("Apply needs_check (S1)", () => {
  it("after a timeout, one message that the application needs a check", async () => {
    const { t, cvVersionId } = await review();
    t.runner.script({ bot: "apply", kind: "submit", result: fake.timeout() });
    t.engine.approve(1, { cvVersionId, introText: null });
    await t.idle();
    expect(texts(t).filter((x) => /needs a check/.test(x))).toEqual([expect.stringMatching(/^NovaPay – Senior Frontend Engineer \(React\/Next\.js\) needs a check: .*timed out.*Applications/)]);
  });

  it("screenshots not captured: the record is kept and Ba is told why", async () => {
    const { t, cvVersionId } = await review();
    t.runner.script({ bot: "apply", kind: "submit", result: (task) => fake.ok({ ...applyOutputFixture, uploadedFile: { filename: "x.pdf", sha256: (task.input as { pdfSha256: string }).pdfSha256 } }) });
    t.engine.approve(1, { cvVersionId, introText: null });
    await t.idle();
    expect(texts(t).filter((x) => /needs a check/.test(x))).toEqual([expect.stringMatching(/needs a check: screenshots not captured/)]);
  });

  it("a dry run reports its own way", async () => {
    const { t, cvVersionId } = await review();
    t.engine.approve(1, { cvVersionId, introText: null, dryRun: true });
    await t.idle();
    expect(texts(t).filter((x) => /[Dd]ry run/.test(x))).toEqual([expect.stringMatching(/^Dry run finished for NovaPay.*nothing was submitted/)]);
  });

  it("a dry run that reports submitted is never called harmless: it may really have been sent", async () => {
    const { t, cvVersionId } = await review();
    t.runner.script({
      bot: "apply",
      kind: "submit",
      times: 1,
      result: (task) => {
        const input = task.input as { pdfPath: string; pdfSha256: string };
        return fake.ok({ ...applyOutputFixture, status: "submitted", uploadedFile: { filename: input.pdfPath.split("/").pop()!, sha256: input.pdfSha256 } });
      },
    });
    t.engine.approve(1, { cvVersionId, introText: null, dryRun: true });
    await t.idle();
    // PM2 S8: Apply is also demoted for it, in its own message.
    expect(texts(t)).toContainEqual(expect.stringMatching(/^I moved Apply from L1 to L0 after a dry run reported submitted/));
    const dry = texts(t).filter((x) => /[Dd]ry run/.test(x) && !/^I moved/.test(x));
    expect(dry).toEqual([expect.stringMatching(/^Dry run for NovaPay.*reported that it submitted.*may really have been sent/)]);
    expect(dry.join(" ")).not.toMatch(/nothing was submitted/);
  });

  it("a dry run that did not finish cleanly says so, with the reason", async () => {
    const { t, cvVersionId } = await review();
    t.runner.script({ bot: "apply", kind: "submit", times: 1, result: fake.timeout() });
    t.engine.approve(1, { cvVersionId, introText: null, dryRun: true });
    await t.idle();
    expect(texts(t).filter((x) => /[Dd]ry run/.test(x))).toEqual([expect.stringMatching(/^Dry run for NovaPay.*needs a check: .*timed out/)]);
  });

  it("after a crash: the interrupted Apply's application needs a check, and Ba is told", async () => {
    const first = await createTestEngine({ clock: new FakeClock(T0) });
    const run = first.engine.startWorkflow(scanParams, { trigger: "chat" });
    await first.idle();
    first.runner.script({ bot: "apply", kind: "submit", delayMs: HOUR });
    first.engine.approve(1, { cvVersionId: first.review(run.id, 1)!.cvVersions[0]!.cvVersionId, introText: null });
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    const second = await createTestEngine({ db: first.db, files: first.files, clock: new FakeClock(new Date(T0.getTime() + 60_000)) });
    await second.idle();
    expect(texts(second).filter((x) => /needs a check/.test(x))).toEqual([expect.stringMatching(/interrupted by restart/)]);
  });
});

describe("usage limits (UC-16, S1)", () => {
  it("one message when an engine pauses and one when it resumes; a longer pause posts nothing new", async () => {
    const t = await createTestEngine();
    t.db.transaction((tx) => t.engine.pauseEngineForLimit(tx, "claude", new Date(T0.getTime() + 2 * HOUR).toISOString()));
    t.db.transaction((tx) => t.engine.pauseEngineForLimit(tx, "claude", new Date(T0.getTime() + 3 * HOUR).toISOString()));
    t.engine.bus.flush();
    expect(texts(t)).toEqual([expect.stringMatching(/^⏸ Claude usage limit reached\. Tasks on Claude wait until 17:00 and then continue by themselves\.$/)]);
    t.clock.advance(3 * HOUR);
    await t.idle();
    expect(texts(t).at(-1)).toBe("✅ Claude usage limit has reset: resumed automatically. No action needed.");
    expect(texts(t)).toHaveLength(2);
  });
});

describe("run summaries (UC-02, UC-04 a, S1)", () => {
  it("cards ready: one summary with the review link, not repeated when a card comes back after changes", async () => {
    const t = await createTestEngine({ sources: ["itviec", "topcv"] });
    const run = t.engine.startWorkflow(scanParams, { trigger: "chat" });
    await t.idle();
    const summaries = () => lead(t).filter((m) => m.cards.some((c) => c.type === "review_link"));
    expect(summaries()).toHaveLength(1);
    expect(summaries()[0]).toMatchObject({ runIds: [String(run.id)], cards: expect.arrayContaining([{ type: "review_link", count: 2 }, { type: "run", runId: String(run.id) }]) });
    expect(summaries()[0]!.text).toMatch(/^🎯 2 jobs ready for review: /);
    t.engine.requestChanges(1, "Lead with Next.js");
    await t.idle();
    expect(summaries()).toHaveLength(1);
    // The run ends after Ba's decisions; its summary was the cards message, so nothing more.
    t.engine.skip(1, { reason: "salary_low", note: null });
    t.engine.skip(2, { reason: "location", note: null });
    await t.idle();
    expect(t.events("run.finished")).toHaveLength(1);
    expect(summaries()).toHaveLength(1);
    expect(texts(t).filter((x) => /finished|No strong matches/.test(x))).toEqual([]);
  });

  it("a scheduled scan: 'Scheduled scan started', then the summary when its cards are ready (UC-02)", async () => {
    const t = await createTestEngine({ sources: ["itviec"] });
    createSchedule(t.db, { name: "Weekdays 9:00", cron: "0 9 * * 1-5", workflowName: "job-scan", nextRunAt: T0.toISOString() });
    t.engine.scheduler.tick();
    await t.idle();
    expect(texts(t)).toEqual(["Scheduled scan started: Weekdays 9:00.", expect.stringMatching(/^🎯 1 job ready for review: NovaPay 87/)]);
  });

  it("no strong matches: the run's end is the summary, with the best below the threshold and their gaps (UC-04 a)", async () => {
    const t = await createTestEngine({ sources: ["itviec"] });
    t.runner.script({ bot: "research", kind: "fit", result: fake.ok({ fit: { score: 41, reasons: ["Frontend"], gaps: ["Needs 5 years of Vue"] }, selfCheck: [{ item: "x", passed: true, note: null }], memoryNotes: [] }) });
    const run = t.engine.startWorkflow(scanParams, { trigger: "chat" });
    await t.idle();
    expect(lead(t)).toEqual([
      expect.objectContaining({ text: expect.stringMatching(/^Scan finished: No strong matches\. Best below the threshold: NovaPay – Senior Frontend Engineer \(React\/Next\.js\) \(fit 41\)/), runIds: [String(run.id)] }),
    ]);
    expect(lead(t)[0]!.text).toMatch(/Needs 5 years of Vue/);
  });

  it("a failed run says so once", async () => {
    const t = await createTestEngine({ sources: ["itviec"] });
    t.runner.script({ bot: "research", kind: "fit", result: fake.failed("model overloaded") });
    t.engine.startWorkflow(scanParams, { trigger: "chat" });
    await t.idle();
    expect(texts(t).filter((x) => /^The scan failed/.test(x))).toEqual([expect.stringMatching(/^The scan failed: fit-join/)]);
    expect(getTask(t.db, t.tasks("research.fit")[0]!.id)?.status).toBe("failed");
  });
});
