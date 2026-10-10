// The other workflows (§7.3 apply-to-link, §7.3b apply-to-file), partial failure (§7.1 join,
// per-job branches, UC-03), pauses inside a fan-out (UC-03 a), PM S3 at engine level, the event
// sink and memory notes (rule 2).
import type { AppEvent } from "@bs-job-agents/shared";
import { researchScanFixture } from "@bs-job-agents/shared/fixtures";
import { describe, expect, it } from "vitest";
import {
  createUpload,
  getApplication,
  getApplicationByJob,
  getJob,
  getRun,
  getTask,
  listApplications,
  upsertJobCandidate,
} from "../db/index.js";
import { fake } from "./testing/fake-runner.js";
import { createTestEngine } from "./testing/harness.js";

const NOVAPAY = researchScanFixture.jobs[0]!;
const pass = (item: string) => ({ item, passed: true, note: null });

describe("apply-to-link (§7.3, UC-14)", () => {
  it("one pasted link: scan the page, fit is computed and shown with no threshold, then the per-job pipeline", async () => {
    const t = await createTestEngine({ noProfile: true });
    t.runner.script({ bot: "research", kind: "fit", result: fake.ok({ fit: { score: 35, reasons: ["React"], gaps: ["Go"] }, selfCheck: [pass("x")], memoryNotes: [] }) });
    const run = t.engine.startWorkflow({ workflow: "apply-to-link", params: { url: "https://itviec.com/it-jobs/frontend-9", applyAgain: false, searchProfileId: null } }, { trigger: "link" });
    await t.idle();
    expect(t.runner.callsFor("research.single")[0]!.input).toEqual({ url: "https://itviec.com/it-jobs/frontend-9" });
    expect(getJob(t.db, 1)).toMatchObject({ fitScore: 35, status: "reviewing" });
    expect(t.review(run.id, 1)).toBeDefined();
    // Form defaults without a profile: the §7.5 defaults.
    const card = t.review(run.id, 1)!;
    t.engine.approve(1, { cvVersionId: card.cvVersions[0]!.cvVersionId, introText: null });
    await t.idle();
    expect(t.runner.callsFor("apply.submit")[0]!.input).toMatchObject({ formDefaults: { salaryPolicy: "blank_if_optional", salaryAmount: null, currency: null } });
  });

  it("a link already applied to stops the run (UC-14 a); “apply again” makes a second application", async () => {
    const t = await createTestEngine();
    const url = NOVAPAY.url!;
    const first = t.engine.startWorkflow({ workflow: "apply-to-link", params: { url, applyAgain: false, searchProfileId: null } }, { trigger: "link" });
    await t.idle();
    t.engine.approve(1, { cvVersionId: t.review(first.id, 1)!.cvVersions[0]!.cvVersionId, introText: null });
    await t.idle();
    expect(getApplicationByJob(t.db, 1)?.status).toBe("submitted");

    const again = t.engine.startWorkflow({ workflow: "apply-to-link", params: { url, applyAgain: false, searchProfileId: null } }, { trigger: "link" });
    await t.idle();
    expect(t.step(again.id, "selected")?.output).toMatchObject({ items: [], alreadyApplied: [expect.objectContaining({ jobId: 1, status: "submitted" })] });
    expect(t.events("run.finished").at(-1)).toMatchObject({ runId: String(again.id), status: "done", summary: "Already applied to this job" });

    const reapply = t.engine.startWorkflow({ workflow: "apply-to-link", params: { url, applyAgain: true, searchProfileId: null } }, { trigger: "link" });
    await t.idle();
    const result = t.engine.approve(1, { cvVersionId: t.review(reapply.id, 1)!.cvVersions[0]!.cvVersionId, introText: null });
    await t.idle();
    expect(getApplication(t.db, result.applicationId!)).toMatchObject({ reapply: true, status: "submitted" });
    expect(listApplications(t.db, { dryRun: false })).toHaveLength(2);
  });
});

describe("apply-to-file (§7.3b, UC-24)", () => {
  it("Research reads its own copy of the upload; with no apply link, Approve only produces the PDF", async () => {
    const t = await createTestEngine();
    t.files.write("/data/uploads/7-JD_NovaPay.pdf", "%PDF a JD");
    const upload = createUpload(t.db, { filename: "JD_NovaPay.pdf", mime: "application/pdf", size: 9, path: "uploads/7-JD_NovaPay.pdf", sha256: "f".repeat(64) });
    t.runner.script({ bot: "research", kind: "file", result: fake.ok({ jobs: [{ ...NOVAPAY, source: "file", url: null }], pageViews: 0, blocked: null, selfCheck: [pass("x")], memoryNotes: [] }) });
    const run = t.engine.startWorkflow({ workflow: "apply-to-file", params: { uploadId: String(upload.id), searchProfileId: null } }, { trigger: "chat" });
    await t.idle();
    const call = t.runner.callsFor("research.file")[0]!;
    expect(call.input).toMatchObject({ uploadId: String(upload.id), path: `/data/tasks/${call.taskId}/JD_NovaPay.pdf` });
    expect(call.readDirs).toEqual([`/data/tasks/${call.taskId}`]);
    expect(t.files.read(`/data/tasks/${call.taskId}/JD_NovaPay.pdf`)).toBe("%PDF a JD");

    const result = t.engine.approve(1, { cvVersionId: t.review(run.id, 1)!.cvVersions[0]!.cvVersionId, introText: null });
    expect(result).toEqual({ applicationId: null, taskId: null, approval: null, reapproval: false });
    await t.idle();
    expect(t.runner.callsFor("apply.submit")).toEqual([]);
    expect(t.step(run.id, "apply", "1")?.status).toBe("skipped");
    expect(getRun(t.db, run.id)?.status).toBe("done");
  });
});

describe("partial failure (§7.1, UC-03)", () => {
  it("a source that fails twice is recorded by the join; the other sources continue", async () => {
    const t = await createTestEngine({ sources: ["itviec", "linkedin"] });
    t.runner.script({ bot: "research", kind: "scan", when: (task) => (task.input as { source: string }).source === "linkedin", result: fake.failed("LinkedIn layout changed") });
    const run = t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    expect(t.step(run.id, "scan-join")?.output).toMatchObject({
      results: [expect.objectContaining({ item: "itviec" })],
      failures: [{ item: "linkedin", error: "LinkedIn layout changed" }],
    });
    expect(t.review(run.id, 1)).toBeDefined();
  });

  it("one job's branch fails; the other job still reaches review; the run is done, not failed", async () => {
    const t = await createTestEngine({ sources: ["itviec", "topcv"] });
    t.runner.script({ bot: "research", kind: "company", when: (task) => (task.input as { name: string }).name === "NovaPay", result: fake.failed("no public data") });
    const run = t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    const novapay = [1, 2].find((id) => getJob(t.db, id)?.title === NOVAPAY.title)!;
    const other = novapay === 1 ? 2 : 1;
    expect(t.step(run.id, "company", String(novapay))?.status).toBe("failed");
    expect(t.review(run.id, other)).toBeDefined();
    t.engine.skip(other, { reason: "location", note: null });
    await t.idle();
    expect(getRun(t.db, run.id)?.status).toBe("done");
    expect(t.events("run.finished")[0]).toMatchObject({ summary: "2 jobs, 1 skipped, 1 failed" });
  });

  it("a source that needs a login pauses its branch (UC-03 a); Ba logs in, clicks Done, the scan runs again", async () => {
    const t = await createTestEngine({ sources: ["itviec", "linkedin"] });
    t.runner.script({ bot: "research", kind: "scan", times: 1, when: (task) => (task.input as { source: string }).source === "linkedin", result: fake.needsLogin("linkedin.com") });
    const run = t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    const linkedin = t.tasks("research.scan").find((x) => (x.input as { source: string }).source === "linkedin")!;
    expect(linkedin).toMatchObject({ status: "paused", pauseReason: "needs_login(linkedin.com)" });
    expect(t.tasks("research.scan").find((x) => x.id !== linkedin.id)?.status).toBe("done");
    expect(getRun(t.db, run.id)?.status).toBe("waiting");
    t.engine.resumeTask(linkedin.id);
    await t.idle();
    expect(getTask(t.db, linkedin.id)).toMatchObject({ status: "done", attempt: 1 });
    expect(t.review(run.id, 1)).toBeDefined();
  });

  it("PM S3: a job a failed run left `new` is offered again by the next scan", async () => {
    const t = await createTestEngine();
    t.runner.script({ bot: "research", kind: "fit", times: 2, result: fake.failed("crashed") });
    const first = t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    expect(getRun(t.db, first.id)?.status).toBe("failed");
    expect(getJob(t.db, 1)?.status).toBe("new");

    const second = t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    expect(t.step(second.id, "dedupe")?.output).toMatchObject({ items: [expect.objectContaining({ jobId: 1 })], duplicates: 0 });
    expect(t.review(second.id, 1)).toBeDefined();
  });

  it("a known job is not offered again while another run is working on it", async () => {
    const t = await createTestEngine();
    upsertJobCandidate(t.db, NOVAPAY);
    const run = t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    // Left `new` by nobody active → offered (S3); now owned by this run's branch.
    expect(t.review(run.id, 1)).toBeDefined();
    const again = t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    expect(t.step(again.id, "dedupe")?.output).toMatchObject({ items: [], duplicates: 1 });
  });
});

describe("the event sink (§10.2 rule 8, §11)", () => {
  it("subscribers get committed shared events in order, including the repositories' own", async () => {
    const t = await createTestEngine();
    const seen: AppEvent[] = [];
    t.engine.subscribe((e) => seen.push(e));
    t.engine.subscribe(() => {
      throw new Error("a broken subscriber");
    });
    t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    expect(seen.map((e) => e.type)).toEqual(t.allEvents().map((e) => e.type));
    expect(seen[0]).toMatchObject({ type: "run.started", workflowName: "job-scan", trigger: "chat" });
    expect(seen.map((e) => Number(e.id))).toEqual([...seen.map((e) => Number(e.id))].sort((a, b) => a - b));
    expect(t.engine.replay(Number(seen[2]!.id)).map((e) => e.event.id)).toEqual(seen.slice(3).map((e) => e.id));
  });
});

describe("bot memory (rule 2, §5.4)", () => {
  it("memory notes of a successful task go to the memory writer, with run and task", async () => {
    const notes: unknown[] = [];
    const t = await createTestEngine({ start: false });
    // Rebuild the engine with a memory writer (W2b appendMemoryNotes + appendMemoryChange in production).
    const { Engine } = await import("./engine.js");
    const engine = new Engine({ ...t.engine.deps, memory: { append: async (n) => void notes.push(n) } });
    await engine.start();
    t.runner.script({ bot: "research", kind: "scan", result: fake.ok({ ...researchScanFixture, jobs: [NOVAPAY] }) });
    engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await engine.idle();
    expect(notes).toEqual([{ botName: "research", notes: ['TopCV salary often hidden: read "Mức lương" field.'], runId: 1, taskId: 1 }]);
  });
});
