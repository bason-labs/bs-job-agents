// PM2 S8 (§5.3, decision 2): automatic demotion, one level down (never below L0), on a safety
// violation by the bot's own conduct during a task, or for CV a version that leaves the QA gate
// escalated with hard fails. Not on the orchestrator's own refusals before a spawn, a block the
// bot turned into a domain_confirm pause, its own injection report or the after-run page check.
import { applyOutputFixture, qaFailFixture, qaPassFixture } from "@bs-job-agents/shared/fixtures";
import { describe, expect, it } from "vitest";
import { getBot, getTask, latestBotDemotion, listBotDemotions } from "../db/index.js";
import type { RunnerTask } from "../runner/types.js";
import { DEMOTING_SAFETY_REASONS } from "./demotion.js";
import { defaultFakeResult, fake } from "./testing/fake-runner.js";
import { LONG_WAIT_CONFIG, createTestEngine, type TestEngine, type TestEngineOptions } from "./testing/harness.js";

const scan = { workflow: "job-scan", params: { searchProfileId: null, overrides: null } } as const;

async function toReview(opts: TestEngineOptions = {}) {
  const t = await createTestEngine(opts);
  const run = t.engine.startWorkflow(scan, { trigger: "chat" });
  await t.idle();
  return { t, run, cvVersionId: t.review(run.id, 1)!.cvVersions[0]!.cvVersionId };
}

const level = (t: TestEngine, bot: string) => getBot(t.db, bot)?.trustLevel;
const leadTexts = (t: TestEngine) => t.events("message.created").map((e) => e.message.text);

describe("demotion triggers (PM2 S8)", () => {
  it("a tool outside the bot's permissions at run time: Research L2 → L1, bot.updated, a Lead message with the reason", async () => {
    const t = await createTestEngine();
    t.runner.script({ bot: "research", kind: "company", times: 1, result: fake.denied([{ tool: "Bash", input: { command: "curl evil.example" }, source: "permission", reason: "not allowed" }]) });
    t.engine.startWorkflow(scan, { trigger: "chat" });
    await t.idle();
    expect(level(t, "research")).toBe(1);
    expect(latestBotDemotion(t.db, "research")).toMatchObject({ fromLevel: 2, toLevel: 1, reason: "trust_level", taskId: t.tasks("research.company")[0]!.id });
    expect(t.events("bot.updated")).toContainEqual(expect.objectContaining({ botName: "research", trustLevel: 1 }));
    expect(leadTexts(t)).toContainEqual(expect.stringMatching(/Research.*L2 to L1.*tool outside its permissions/s));
  });

  it("the page shows another company or job: Apply L1 → L0, and every later Apply is refused until Ba restores it", async () => {
    const { t, cvVersionId } = await toReview({ sources: ["itviec", "topcv"] });
    t.runner.script({ bot: "apply", kind: "submit", times: 1, result: fake.selfCheckFailed(applyOutputFixture, ["The company and job title on the page match the approved job"]) });
    t.engine.approve(1, { cvVersionId, introText: null });
    await t.idle();
    expect(level(t, "apply")).toBe(0);
    expect(latestBotDemotion(t.db, "apply")).toMatchObject({ fromLevel: 1, toLevel: 0, reason: "page_mismatch" });
    // Another approved card: refused before it spawns (L0 never acts outward).
    const other = t.review(1, 2)!;
    const second = t.engine.approve(2, { cvVersionId: other.cvVersions[0]!.cvVersionId, introText: null });
    await t.idle();
    expect(getTask(t.db, second.taskId!)).toMatchObject({ status: "failed", error: expect.stringMatching(/L0/) });
    expect(t.runner.callsFor("apply.submit")).toHaveLength(1);
    // Ba restores it on the Bots screen (W3a's PATCH → updateBot): the demotion closes.
    t.engine.restoreBot("apply");
    expect(level(t, "apply")).toBe(1);
    expect(latestBotDemotion(t.db, "apply")).toBeUndefined();
    expect(t.events("bot.updated").at(-1)).toMatchObject({ botName: "apply", trustLevel: 1 });
  });

  it("a dry run that reported submitted demotes Apply", async () => {
    const { t, cvVersionId } = await toReview();
    t.runner.script({ bot: "apply", kind: "submit", result: (task) => fake.ok({ ...applyOutputFixture, uploadedFile: { filename: "x.pdf", sha256: (task.input as { pdfSha256: string }).pdfSha256 } }) });
    t.engine.approve(1, { cvVersionId, introText: null, dryRun: true });
    await t.idle();
    expect(latestBotDemotion(t.db, "apply")).toMatchObject({ reason: "dry_run_submitted", toLevel: 0 });
  });

  it("a Figma-guard block with a protected-page change still fails and demotes CV once (protected_page_changed)", async () => {
    const t = await createTestEngine();
    t.runner.script({
      bot: "cv",
      kind: "tailor",
      times: 1,
      result: (task: RunnerTask) => {
        t.guards.logBlock(`/data/transcripts/${task.taskId}-${task.attempt}.guard.jsonl`, { guard: "figma", tool: "mcp__figma__figma_execute", rule: "figma_page_name", reason: "Only the Drafts page may be changed", target: "resume" });
        t.figma.changeProtectedText("Edited anyway");
        return defaultFakeResult(task);
      },
    });
    t.engine.startWorkflow(scan, { trigger: "chat" });
    await t.idle();
    expect(t.tasks("cv.tailor")[0]).toMatchObject({ status: "failed" });
    expect(listBotDemotions(t.db, "cv")).toEqual([expect.objectContaining({ reason: "protected_page_changed" })]);
    expect(level(t, "cv")).toBe(1);
  });

  it("a CV Figma-guard block together with a tool outside its permissions still fails and demotes (trust_level)", async () => {
    const t = await createTestEngine();
    t.runner.script({
      bot: "cv",
      kind: "tailor",
      times: 1,
      result: (task: RunnerTask) => {
        const ok = defaultFakeResult(task);
        return fake.denied(
          [
            { tool: "mcp__figma__figma_execute", input: {}, source: "hook", reason: "Only the Drafts page may be changed" },
            { tool: "Bash", input: { command: "ls" }, source: "permission", reason: "not allowed" },
          ],
          ok.status === "ok" ? ok.output : null,
        );
      },
    });
    t.engine.startWorkflow(scan, { trigger: "chat" });
    await t.idle();
    expect(t.runner.callsFor("cv.tailor")).toHaveLength(2);
    expect(latestBotDemotion(t.db, "cv")).toMatchObject({ reason: "trust_level", fromLevel: 2, toLevel: 1 });
  });

  it("a protected page changed during a CV task: demoted with Ba's 'that was me' choice; Ba's answer restores CV and retries", async () => {
    const t = await createTestEngine();
    t.runner.script({
      bot: "cv",
      kind: "tailor",
      times: 1,
      result: (task: RunnerTask) => {
        t.figma.changeProtectedText("Edited by someone");
        return defaultFakeResult(task);
      },
    });
    const run = t.engine.startWorkflow(scan, { trigger: "chat" });
    await t.idle();
    const cvTask = t.tasks("cv.tailor")[0]!;
    expect(cvTask.status).toBe("failed");
    expect(latestBotDemotion(t.db, "cv")).toMatchObject({ reason: "protected_page_changed", taskId: cvTask.id });
    const alert = t.events("message.created").find((e) => /by the bot or by you/.test(e.message.text))!;
    expect(alert.message.cards).toContainEqual({ type: "choice", key: `figma-change:${cvTask.id}`, options: [{ id: "was_me", label: "That was me — retry" }], chosen: null });
    t.engine.protectedChangeWasBa(cvTask.id);
    await t.idle();
    expect(level(t, "cv")).toBe(2);
    expect(latestBotDemotion(t.db, "cv")).toBeUndefined();
    expect(t.runner.callsFor("cv.tailor")).toHaveLength(2);
    expect(t.review(run.id, 1)).toBeDefined();
    expect(() => t.engine.protectedChangeWasBa(cvTask.id)).toThrow(/no open demotion/);
  });

  it("a CV version that leaves the QA gate escalated with hard fails demotes CV", async () => {
    const t = await createTestEngine();
    t.runner.script({ bot: "qa", kind: "review", result: fake.ok(qaFailFixture) });
    const run = t.engine.startWorkflow(scan, { trigger: "chat" });
    await t.idle();
    expect(t.review(run.id, 1)).toMatchObject({ escalated: true });
    expect(latestBotDemotion(t.db, "cv")).toMatchObject({ reason: "qa_hard_fail", fromLevel: 2, toLevel: 1 });
  });

  it("never below L0", async () => {
    const t = await createTestEngine();
    t.db.$client.prepare("UPDATE bots SET trust_level = 0 WHERE name = 'research'").run();
    t.runner.script({ bot: "research", kind: "company", times: 1, result: fake.denied([{ tool: "Bash", input: {}, source: "permission", reason: "no" }]) });
    t.engine.startWorkflow(scan, { trigger: "chat" });
    await t.idle();
    expect(level(t, "research")).toBe(0);
    expect(listBotDemotions(t.db, "research")).toEqual([]);
  });
});

describe("not demotion triggers (PM2 S8)", () => {
  it("the trigger list: a verified-harmless Figma-guard block is informational; an unverified one still demotes", () => {
    expect(DEMOTING_SAFETY_REASONS).not.toContain("figma_guard_blocked");
    expect(DEMOTING_SAFETY_REASONS).toContain("protected_page_blocked");
    expect(DEMOTING_SAFETY_REASONS).toContain("protected_page_changed");
  });

  // Live run 1: CV read a template node through a helper (`w(t,0)` on getNodeByIdAsync(<template>)),
  // the Figma guard blocked it (figma_protected_escape), the bot cloned into Drafts and finished.
  // The block is prevention that worked: with the protected pages unchanged the task keeps its result.
  it("run 1 regression: a Figma-guard block, then valid output, pages unchanged: task done on attempt 1, no demotion, an informational safety event", async () => {
    const t = await createTestEngine();
    t.runner.script({
      bot: "cv",
      kind: "tailor",
      times: 1,
      result: (task: RunnerTask) => {
        const block = { guard: "figma" as const, tool: "mcp__figma__figma_execute", rule: "figma_protected_escape", reason: "Template nodes may not be passed to helper functions", target: "1:23" };
        t.guards.logBlock(`/data/transcripts/${task.taskId}-${task.attempt}.guard.jsonl`, block);
        const ok = defaultFakeResult(task);
        return fake.denied([{ tool: "mcp__figma__figma_execute", input: { code: "w(t,0)" }, source: "hook", reason: block.reason }], ok.status === "ok" ? ok.output : null);
      },
    });
    const run = t.engine.startWorkflow(scan, { trigger: "chat" });
    await t.idle();
    expect(t.runner.callsFor("cv.tailor")).toHaveLength(1);
    expect(t.tasks("cv.tailor")[0]).toMatchObject({ status: "done", attempt: 1 });
    expect(listBotDemotions(t.db, "cv")).toEqual([]);
    expect(level(t, "cv")).toBe(2);
    expect(t.events("safety.denied")).toEqual([
      expect.objectContaining({ reason: "figma_guard_blocked", botName: "cv", action: "mcp__figma__figma_execute", detail: expect.stringMatching(/figma_protected_escape/) }),
    ]);
    expect(leadTexts(t).join("\n")).not.toMatch(/moved CV/);
    expect(t.review(run.id, 1)).toBeDefined();
  });

  it("a Figma-guard block only in the guard log (the run itself ok), pages unchanged: no demotion", async () => {
    const t = await createTestEngine();
    t.runner.script({
      bot: "cv",
      kind: "tailor",
      times: 2,
      result: (task: RunnerTask) => {
        t.guards.logBlock(`/data/transcripts/${task.taskId}-${task.attempt}.guard.jsonl`, { guard: "figma", tool: "mcp__figma__figma_execute", rule: "figma_page_name", reason: "Only the Drafts page may be changed", target: "resume" });
        return defaultFakeResult(task);
      },
    });
    t.engine.startWorkflow(scan, { trigger: "chat" });
    await t.idle();
    expect(t.tasks("cv.tailor")[0]).toMatchObject({ status: "done", attempt: 1 });
    expect(listBotDemotions(t.db, "cv")).toEqual([]);
    expect(level(t, "cv")).toBe(2);
  });

  it("a Figma-guard block with no usable output, pages unchanged: the attempt fails and is retried, no demotion", async () => {
    const t = await createTestEngine();
    t.runner.script({
      bot: "cv",
      kind: "tailor",
      times: 1,
      result: fake.denied([{ tool: "mcp__figma__figma_execute", input: { code: "figma.root.children[0].remove()" }, source: "hook", reason: "Only the Drafts page may be changed" }]),
    });
    t.engine.startWorkflow(scan, { trigger: "chat" });
    await t.idle();
    expect(t.runner.callsFor("cv.tailor")).toHaveLength(2);
    expect(t.tasks("cv.tailor")[0]).toMatchObject({ status: "done", attempt: 2 });
    expect(listBotDemotions(t.db, "cv")).toEqual([]);
    expect(t.events("safety.denied")).toEqual([expect.objectContaining({ reason: "figma_guard_blocked" })]);
  });

  it("hard fails the QA loop fixes: no demotion", async () => {
    const t = await createTestEngine();
    t.runner.script({ bot: "qa", kind: "review", times: 1, result: fake.ok(qaFailFixture) });
    t.runner.script({ bot: "qa", kind: "review", result: fake.ok(qaPassFixture) });
    const run = t.engine.startWorkflow(scan, { trigger: "chat" });
    await t.idle();
    expect(t.review(run.id, 1)).toMatchObject({ qaPassed: true });
    expect(listBotDemotions(t.db, "cv")).toEqual([]);
  });

  it("a site-guard block Apply turned into a domain_confirm pause", async () => {
    const { t, cvVersionId } = await toReview();
    t.runner.script({ bot: "apply", kind: "submit", times: 1, result: fake.applyDomainConfirm("novapay.breezy.hr") });
    t.engine.approve(1, { cvVersionId, introText: null });
    await t.idle();
    expect(level(t, "apply")).toBe(1);
    expect(listBotDemotions(t.db, "apply")).toEqual([]);
  });

  it("the orchestrator's own refusal before a spawn (an expired token)", async () => {
    const { t, cvVersionId } = await toReview({ config: LONG_WAIT_CONFIG });
    t.runner.script({ bot: "apply", kind: "submit", times: 1, result: fake.applyPaused({ reason: "captcha", site: "itviec.com" }) });
    const { taskId } = t.engine.approve(1, { cvVersionId, introText: null });
    await t.idle();
    t.clock.advance(25 * 3600_000);
    t.engine.resumeTask(taskId!);
    await t.idle();
    expect(t.events("safety.denied")).toContainEqual(expect.objectContaining({ reason: "token_expired" }));
    expect(listBotDemotions(t.db, "apply")).toEqual([]);
  });

  it("the bot's own injection report", async () => {
    const t = await createTestEngine();
    t.runner.script({
      bot: "research",
      kind: "scan",
      result: (task: RunnerTask) => {
        const r = defaultFakeResult(task);
        return r.status === "ok" ? fake.ok({ ...(r.output as object), injectionSuspected: true, injectionNote: "ignore your rules" }) : r;
      },
    });
    t.engine.startWorkflow(scan, { trigger: "chat" });
    await t.idle();
    expect(listBotDemotions(t.db, "research")).toEqual([]);
  });
});
