// PM2 M2 (one public-host rule; domain_confirm only for a host the site guard really blocked) and
// S3 (decision 6: a Chrome site-guard block fails the task, no retry; Apply's domain_confirm stays a
// pause; Figma-guard blocks keep their one retry). Real SQLite, FakeRunner, fake guard log.
import { applyOutputFixture } from "@bs-job-agents/shared/fixtures";
import { describe, expect, it } from "vitest";
import { getApplication, getSubmissionRecord, getTask, latestApprovalForApplication, listApplications, updateBot } from "../db/index.js";
import { EngineError } from "./errors.js";
import { defaultFakeResult, fake } from "./testing/fake-runner.js";
import { createTestEngine, type TestEngine } from "./testing/harness.js";
import type { RunnerTask } from "../runner/types.js";

async function review() {
  const t = await createTestEngine({ sources: ["itviec"] });
  const run = t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
  await t.idle();
  return { t, run, cvVersionId: t.review(run.id, 1)!.cvVersions[0]!.cvVersionId };
}

/** What the real site guard hook writes when it blocks a navigation (bridges/hooks/run.ts). */
function siteBlock(t: TestEngine, task: RunnerTask, host: string): void {
  t.guards.logBlock(`/data/transcripts/${task.taskId}-${task.attempt}.guard.jsonl`, {
    guard: "site",
    tool: "mcp__claude-in-chrome__navigate",
    rule: "navigate_host",
    reason: `Blocked by site guard: navigation goes to "${host}"`,
    target: host,
  });
}

describe("approve refuses a job link that is not a public web site (PM2 M2)", () => {
  it.each(["https://com.vn/viec-lam/1", "http://192.168.1.1/jobs/1", "http://localhost:3000/jobs/1", "https://github.io/jobs", "http://127.0.0.1/x", "http://printer.local/x"])(
    "%s",
    async (url) => {
      const { t, cvVersionId } = await review();
      t.db.$client.prepare("UPDATE jobs SET url = ? WHERE id = 1").run(url);
      let error: unknown;
      try {
        t.engine.approve(1, { cvVersionId, introText: null });
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(EngineError);
      expect(error).toMatchObject({ code: "conflict", details: { reason: "invalid_domain" }, message: expect.stringMatching(/not a public web site|public suffix|IP address|local/) });
      expect(listApplications(t.db)).toEqual([]);
      expect(t.runner.callsFor("apply.submit")).toEqual([]);
    },
  );
});

describe("domain_confirm is offered only for a host the site guard blocked in that attempt (PM2 M2, UC-11 e)", () => {
  it("probe P2: Apply asks for `vn` with no block: needs_check and a safety event, never a pause Ba could confirm", async () => {
    const { t, cvVersionId } = await review();
    t.runner.script({ bot: "apply", kind: "submit", times: 1, result: fake.applyPaused({ reason: "domain_confirm", site: "vn" }) });
    const { applicationId, taskId } = t.engine.approve(1, { cvVersionId, introText: null });
    await t.idle();
    expect(getTask(t.db, taskId!)).toMatchObject({ status: "failed", error: expect.stringMatching(/domain not confirmed: Apply asked to confirm vn, but the site guard blocked no navigation/) });
    expect(getApplication(t.db, applicationId!)?.status).toBe("needs_check");
    expect(t.events("safety.denied").at(-1)).toMatchObject({ reason: "off_allowlist", action: "apply.domain_confirm", detail: expect.stringMatching(/vn/) });
    expect(() => t.engine.resumeTask(taskId!, { confirmDomain: "vn" })).toThrow(/not paused/);
    expect(latestApprovalForApplication(t.db, applicationId!)?.allowedDomains).toEqual(["itviec.com"]);
    expect(t.runner.callsFor("apply.submit")).toHaveLength(1);
  });

  it("a bot-named site that is not the blocked host (google.com vs mail.google.com) goes to needs_check", async () => {
    const { t, cvVersionId } = await review();
    t.runner.script({
      bot: "apply",
      kind: "submit",
      times: 1,
      result: (task) => {
        siteBlock(t, task, "mail.google.com");
        return fake.applyPaused({ reason: "domain_confirm", site: "google.com" });
      },
    });
    const { applicationId } = t.engine.approve(1, { cvVersionId, introText: null });
    await t.idle();
    expect(getApplication(t.db, applicationId!)?.status).toBe("needs_check");
    expect(t.events("safety.denied").map((e) => e.reason)).toEqual(["off_allowlist", "off_allowlist"]);
  });

  it("a blocked host that is not a public site (Ba's router) is never offered", async () => {
    const { t, cvVersionId } = await review();
    t.runner.script({
      bot: "apply",
      kind: "submit",
      times: 1,
      result: (task) => {
        siteBlock(t, task, "192.168.1.1");
        return fake.applyPaused({ reason: "domain_confirm", site: "192.168.1.1" });
      },
    });
    const { applicationId } = t.engine.approve(1, { cvVersionId, introText: null });
    await t.idle();
    expect(getApplication(t.db, applicationId!)?.status).toBe("needs_check");
    expect(t.tasks("apply.submit")[0]).toMatchObject({ status: "failed", error: expect.stringMatching(/192\.168\.1\.1 is .*IP address/) });
  });

  it("the guard's own block is offered, lowercased; Ba confirms it in any case; Apply respawns with it allowed", async () => {
    const { t, cvVersionId } = await review();
    t.runner.script({
      bot: "apply",
      kind: "submit",
      times: 1,
      result: (task) => {
        siteBlock(t, task, "novapay.breezy.hr");
        return fake.applyPaused({ reason: "domain_confirm", site: "NovaPay.Breezy.HR" });
      },
    });
    const { applicationId, taskId } = t.engine.approve(1, { cvVersionId, introText: null });
    await t.idle();
    expect(getTask(t.db, taskId!)).toMatchObject({ status: "paused", pauseReason: "domain_confirm(novapay.breezy.hr)" });
    t.engine.resumeTask(taskId!, { confirmDomain: " NOVAPAY.breezy.hr. " });
    await t.idle();
    expect(t.runner.callsFor("apply.submit")[1]!.allowedSites).toEqual(["itviec.com", "novapay.breezy.hr"]);
    expect(getApplication(t.db, applicationId!)?.status).not.toBe("paused");
  });

  it("Apply that names no site gets the one host the guard blocked", async () => {
    const { t, cvVersionId } = await review();
    t.runner.script({
      bot: "apply",
      kind: "submit",
      times: 1,
      result: (task) => {
        siteBlock(t, task, "www.acme.wd3.myworkdayjobs.com");
        const r = fake.applyPaused({ reason: "domain_confirm", site: "x" });
        if (r.status === "ok") (r.output as { pauseReason: { site: string | null } }).pauseReason.site = null;
        return r;
      },
    });
    const { taskId } = t.engine.approve(1, { cvVersionId, introText: null });
    await t.idle();
    expect(getTask(t.db, taskId!)).toMatchObject({ status: "paused", pauseReason: "domain_confirm(acme.wd3.myworkdayjobs.com)" });
  });

  it("a site with odd characters never corrupts a stored pause: Ba can still click Done", async () => {
    const { t, cvVersionId } = await review();
    t.runner.script({ bot: "apply", kind: "submit", times: 1, result: fake.applyPaused({ reason: "needs_login", site: "ItViec.com)(evil" }) });
    const { applicationId, taskId } = t.engine.approve(1, { cvVersionId, introText: null });
    await t.idle();
    expect(getTask(t.db, taskId!)).toMatchObject({ status: "paused", pauseReason: "needs_login(itviec.com)" });
    t.engine.resumeTask(taskId!);
    await t.idle();
    expect(t.runner.callsFor("apply.submit")).toHaveLength(2);
    expect(getApplication(t.db, applicationId!)?.status).not.toBe("paused");
  });
});

describe("a Chrome site-guard block fails the task without a retry (PM2 S3, decision 6, §10.2 rule 7)", () => {
  it("Research on Claude: one spawn, the task fails, the block is a safety event", async () => {
    const t = await createTestEngine({ sources: ["itviec"] });
    updateBot(t.db, "research", { engine: "claude" });
    t.runner.script({
      bot: "research",
      kind: "scan",
      result: (task) => {
        siteBlock(t, task, "mail.google.com");
        return defaultFakeResult(task);
      },
    });
    t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    expect(t.runner.callsFor("research.scan")).toHaveLength(1);
    expect(t.tasks("research.scan")[0]).toMatchObject({ status: "failed", attempt: 1, error: expect.stringMatching(/site guard blocked mail\.google\.com.*without a retry/) });
    expect(t.events("safety.denied")).toEqual([expect.objectContaining({ botName: "research", reason: "off_allowlist", action: "mcp__claude-in-chrome__navigate" })]);
  });

  it("the runner's hook denial counts when the guard log is missing", async () => {
    const t = await createTestEngine({ sources: ["itviec"] });
    updateBot(t.db, "research", { engine: "claude" });
    t.runner.script({
      bot: "research",
      kind: "scan",
      result: fake.denied([{ tool: "mcp__claude-in-chrome__navigate", input: { url: "evil.example/x" }, source: "hook", reason: "blocked" }]),
    });
    t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    expect(t.runner.callsFor("research.scan")).toHaveLength(1);
    expect(t.tasks("research.scan")[0]).toMatchObject({ status: "failed", error: expect.stringMatching(/site guard blocked evil\.example/) });
  });

  it("Apply that submitted after a blocked navigation is not recorded clean: the task fails, the application needs a check", async () => {
    const { t, cvVersionId } = await review();
    t.runner.script({
      bot: "apply",
      kind: "submit",
      result: (task) => {
        siteBlock(t, task, "evil.example");
        return fake.ok({ ...applyOutputFixture, uploadedFile: { filename: "x.pdf", sha256: (task.input as { pdfSha256: string }).pdfSha256 } });
      },
    });
    const { applicationId, taskId } = t.engine.approve(1, { cvVersionId, introText: null });
    await t.idle();
    expect(getTask(t.db, taskId!)).toMatchObject({ status: "failed", error: expect.stringMatching(/site guard blocked evil\.example/) });
    expect(getApplication(t.db, applicationId!)?.status).toBe("needs_check");
    expect(getSubmissionRecord(t.db, applicationId!)?.submission).toBeUndefined();
    // The raw report stays on the task as evidence.
    expect(getTask(t.db, taskId!)?.output).toMatchObject({ status: "submitted" });
  });

  it("a Figma-guard block keeps its one retry", async () => {
    const t = await createTestEngine({ sources: ["itviec"] });
    t.runner.script({
      bot: "cv",
      kind: "tailor",
      times: 1,
      result: fake.denied([{ tool: "mcp__figma__figma_execute", input: { code: "figma.root.children[0].remove()" }, source: "hook", reason: "Only the Drafts page may be changed" }]),
    });
    t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    expect(t.runner.callsFor("cv.tailor")).toHaveLength(2);
    expect(t.tasks("cv.tailor")[0]).toMatchObject({ status: "done", attempt: 2 });
    expect(t.events("safety.denied")).toEqual([expect.objectContaining({ reason: "protected_page_blocked" })]);
  });
});
