// PM2 S15 (§12 dry-run acceptance): a dry run that reported "submitted" counts as "already
// applied" until Ba settles it (it may really have been sent). After a settled dry run, the same
// review card can be approved live: a new application and token, the same CV version, the same
// card and run (no re-tailoring).
import { applyOutputFixture } from "@bs-job-agents/shared/fixtures";
import { describe, expect, it } from "vitest";
import { getApplication, getApplicationByJob, getRun, getSubmissionRecord, latestApprovalForApplication, transitionApplication } from "../db/index.js";
import type { RunnerTask } from "../runner/types.js";
import { fake } from "./testing/fake-runner.js";
import { createTestEngine } from "./testing/harness.js";

async function dryRun(reportSubmitted: boolean) {
  const t = await createTestEngine();
  const run = t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
  await t.idle();
  const cvVersionId = t.review(run.id, 1)!.cvVersions[0]!.cvVersionId;
  if (reportSubmitted) {
    t.runner.script({
      bot: "apply",
      kind: "submit",
      times: 1,
      result: (task: RunnerTask) => fake.ok({ ...applyOutputFixture, uploadedFile: { filename: "x.pdf", sha256: (task.input as { pdfSha256: string }).pdfSha256 } }),
    });
  }
  const dry = t.engine.approve(1, { cvVersionId, introText: null, dryRun: true });
  await t.idle();
  return { t, run, cvVersionId, dryAppId: dry.applicationId! };
}

describe("dry run → live (PM2 S15)", () => {
  it("after a dry run that finished normally, the same card is approved live: new application and token, same CV, same run", async () => {
    const { t, run, cvVersionId, dryAppId } = await dryRun(false);
    expect(getApplication(t.db, dryAppId)).toMatchObject({ dryRun: true, status: "needs_check" });
    expect(getRun(t.db, run.id)?.status).toBe("done");
    const live = t.engine.approve(1, { cvVersionId, introText: null });
    expect(live.applicationId).not.toBe(dryAppId);
    expect(live.reapproval).toBe(false);
    expect(latestApprovalForApplication(t.db, live.applicationId!)?.usedAt).toBeNull();
    await t.idle();
    expect(getApplication(t.db, live.applicationId!)).toMatchObject({ dryRun: false, status: "submitted", cvVersionId });
    expect(getSubmissionRecord(t.db, live.applicationId!)?.submission).toMatchObject({ dryRun: false });
    expect(t.runner.callsFor("apply.submit").map((c) => (c.input as { dryRun: boolean }).dryRun)).toEqual([true, false]);
    // No re-tailoring: one CV per language, one card.
    expect(t.runner.callsFor("cv.tailor")).toHaveLength(1);
    expect(t.action(run.id, 1)).toMatchObject({ applicationId: live.applicationId, dryRun: false, dryRunApplicationId: dryAppId, outcome: "submitted" });
    expect(t.review(run.id, 1)?.decisions.map((d) => [d.decision, d.fromDryRun ?? false])).toEqual([
      ["approve", false],
      ["approve", true],
    ]);
    expect(getRun(t.db, run.id)?.status).toBe("done");
    // The dry run stays as it was.
    expect(getApplication(t.db, dryAppId)).toMatchObject({ dryRun: true, status: "needs_check" });
  });

  it("the live approval keeps the CV version the dry run used", async () => {
    const { t } = await dryRun(false);
    expect(() => t.engine.approve(1, { cvVersionId: 999, introText: null })).toThrow(/CV version the dry run used/);
  });

  it("a dry run that reported submitted counts as already applied until Ba settles it", async () => {
    const { t, cvVersionId, dryAppId } = await dryRun(true);
    expect(getApplicationByJob(t.db, 1)?.id).toBe(dryAppId);
    expect(() => t.engine.approve(1, { cvVersionId, introText: null })).toThrow(expect.objectContaining({ code: "already_applied" }));
    // A pasted link for the same job stops at "already applied" too (UC-14 a).
    const link = t.engine.startWorkflow({ workflow: "apply-to-link", params: { url: "https://itviec.com/it-jobs/senior-frontend-engineer-react-nextjs-novapay-1234", applyAgain: false, searchProfileId: null } }, { trigger: "link" });
    await t.idle();
    expect(t.events("run.finished").find((e) => e.runId === String(link.id))?.summary).toBe("Already applied to this job");
    // Ba checked: nothing was sent (Applications screen: needs_check → failed). Now it may go live.
    transitionApplication(t.db, dryAppId, "failed", { by: "manual", note: "checked: not sent" });
    expect(getApplicationByJob(t.db, 1)).toBeUndefined();
    // The dry run that submitted also demoted Apply (PM2 S8); Ba restores it.
    t.engine.restoreBot("apply");
    const live = t.engine.approve(1, { cvVersionId, introText: null });
    await t.idle();
    expect(getApplication(t.db, live.applicationId!)?.status).toBe("submitted");
  });

  it("while the dry run still runs or waits for Ba, the card cannot go live", async () => {
    const t = await createTestEngine();
    const run = t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    const cvVersionId = t.review(run.id, 1)!.cvVersions[0]!.cvVersionId;
    t.runner.script({ bot: "apply", kind: "submit", times: 1, result: fake.applyPaused({ reason: "captcha", site: "itviec.com" }) });
    t.engine.approve(1, { cvVersionId, introText: null, dryRun: true });
    await t.idle();
    expect(() => t.engine.approve(1, { cvVersionId, introText: null })).toThrow(/dry run/);
  });
});
