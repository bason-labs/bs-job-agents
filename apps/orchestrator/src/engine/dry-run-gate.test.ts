// §12 dry-run acceptance: "required before the first live submission", enforced in code (W4b open
// issue 4). Until one dry run has settled on this install (Apply filled the form, screenshotted it
// and stopped, then its task ended), a live approval is refused with a clear message. A dry run is
// always allowed, on any job. The production engine has the gate on (DEFAULT_ENGINE_CONFIG).
import { applyOutputFixture } from "@bs-job-agents/shared/fixtures";
import { describe, expect, it } from "vitest";
import { getApplicationByJob, importApplication, listApplications } from "../db/index.js";
import type { RunnerTask } from "../runner/types.js";
import { DEFAULT_ENGINE_CONFIG } from "./config.js";
import { fake } from "./testing/fake-runner.js";
import { createTestEngine } from "./testing/harness.js";

const scan = { workflow: "job-scan", params: { searchProfileId: null, overrides: null } } as const;

async function twoCards() {
  const t = await createTestEngine({ config: { requireDryRunFirst: true }, sources: ["itviec", "topcv"] });
  const run = t.engine.startWorkflow(scan, { trigger: "chat" });
  await t.idle();
  const jobs = [1, 2].filter((j) => t.review(run.id, j));
  return { t, run, jobs, cv: (job: number) => t.review(run.id, job)!.cvVersions[0]!.cvVersionId };
}

describe("dry run required before the first live submission (§12)", () => {
  it("the production default has the gate on", () => {
    expect(DEFAULT_ENGINE_CONFIG.requireDryRunFirst).toBe(true);
  });

  it("refuses a live approval before any dry run, with a clear message, and creates nothing", async () => {
    const { t, cv } = await twoCards();
    let err: unknown;
    try {
      t.engine.approve(1, { cvVersionId: cv(1), introText: null });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: "conflict", details: { reason: "dry_run_required" } });
    expect((err as Error).message).toMatch(/dry run first/i);
    expect(listApplications(t.db)).toEqual([]);
    expect(t.runner.callsFor("apply.submit")).toEqual([]);
  });

  it("a dry run is allowed on any job; once it settled, a live approval on ANOTHER job goes through", async () => {
    const { t, jobs, cv } = await twoCards();
    expect(jobs).toEqual([1, 2]);
    t.engine.approve(2, { cvVersionId: cv(2), introText: null, dryRun: true });
    await t.idle();
    const live = t.engine.approve(1, { cvVersionId: cv(1), introText: null });
    await t.idle();
    expect(getApplicationByJob(t.db, 1)).toMatchObject({ id: live.applicationId, dryRun: false, status: "submitted" });
  });

  it("the same card goes live after its own dry run (Approve live)", async () => {
    const { t, cv } = await twoCards();
    t.engine.approve(1, { cvVersionId: cv(1), introText: null, dryRun: true });
    await t.idle();
    const live = t.engine.approve(1, { cvVersionId: cv(1), introText: null });
    await t.idle();
    expect(getApplicationByJob(t.db, 1)).toMatchObject({ id: live.applicationId, dryRun: false, status: "submitted" });
  });

  it("a dry run that is still running or waiting for Ba does not count yet", async () => {
    const { t, cv } = await twoCards();
    t.runner.script({ bot: "apply", kind: "submit", times: 1, result: fake.applyPaused({ reason: "captcha", site: "topcv.vn" }) });
    t.engine.approve(2, { cvVersionId: cv(2), introText: null, dryRun: true });
    await t.idle();
    expect(() => t.engine.approve(1, { cvVersionId: cv(1), introText: null })).toThrow(/dry run first/i);
  });

  it("a dry run that reported submitted does not count while it waits for Ba's check", async () => {
    const { t, cv } = await twoCards();
    t.runner.script({
      bot: "apply",
      kind: "submit",
      times: 1,
      result: (task: RunnerTask) => fake.ok({ ...applyOutputFixture, uploadedFile: { filename: "x.pdf", sha256: (task.input as { pdfSha256: string }).pdfSha256 } }),
    });
    t.engine.approve(2, { cvVersionId: cv(2), introText: null, dryRun: true });
    await t.idle();
    expect(() => t.engine.approve(1, { cvVersionId: cv(1), introText: null })).toThrow(/dry run first/i);
  });

  it("imported applications (UC-13) do not count as a dry run", async () => {
    const { t, cv } = await twoCards();
    importApplication(t.db, { jobId: 2, submittedAt: "2026-10-10T08:40:00.000Z" });
    expect(() => t.engine.approve(1, { cvVersionId: cv(1), introText: null })).toThrow(/dry run first/i);
  });

  it("with the gate off (tests, the live-shape lane) a live approval needs no dry run", async () => {
    const t = await createTestEngine({ config: { requireDryRunFirst: false } });
    const run = t.engine.startWorkflow(scan, { trigger: "chat" });
    await t.idle();
    const live = t.engine.approve(1, { cvVersionId: t.review(run.id, 1)!.cvVersions[0]!.cvVersionId, introText: null });
    expect(live.applicationId).not.toBeNull();
  });
});
