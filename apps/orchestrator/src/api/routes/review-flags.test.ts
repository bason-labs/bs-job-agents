// Phase 3 QA: F3's review-card flags reach the API. PM2 S16 `companyMissing` (the company research
// failed for good) and PM2 S15 `dryRunSettled` (a settled dry run puts its card back in the queue,
// where Approve applies live with the same CV, and Skip closes it).
import { ApiErrorSchema, ReviewQueueResponseSchema } from "@bs-job-agents/shared";
import { applyOutputFixture } from "@bs-job-agents/shared/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { getApplication, getJob, transitionApplication } from "../../db/index.js";
import type { RunnerTask } from "../../runner/types.js";
import { fake } from "../../engine/testing/index.js";
import { createApiHarness, type ApiHarness } from "../testing.js";

let h: ApiHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const scan = { workflow: "job-scan", params: { searchProfileId: null, overrides: null } } as const;

async function queue(x: ApiHarness) {
  const res = await x.get("/review");
  expect(res.statusCode).toBe(200);
  return ReviewQueueResponseSchema.parse(res.json()).cards;
}

async function toReview(): Promise<ApiHarness> {
  h = await createApiHarness();
  expect((await h.post("/runs", scan)).statusCode).toBe(201);
  await h.t.idle();
  return h;
}

/** Approve the card as a dry run; `reportSubmitted` makes Apply claim it sent the form. */
async function dryRun(x: ApiHarness, reportSubmitted = false) {
  const [card] = await queue(x);
  if (reportSubmitted) {
    x.t.runner.script({
      bot: "apply",
      kind: "submit",
      times: 1,
      result: (task: RunnerTask) => fake.ok({ ...applyOutputFixture, uploadedFile: { filename: "x.pdf", sha256: (task.input as { pdfSha256: string }).pdfSha256 } }),
    });
  }
  const cvVersionId = card!.cvOptions[0]!.cvVersion.id;
  const res = await x.post(`/review/${card!.job.id}/approve`, { cvVersionId, introText: null, dryRun: true });
  expect(res.statusCode).toBe(200);
  await x.t.idle();
  return { card: card!, cvVersionId, dryAppId: Number(res.json().applicationId) };
}

describe("GET /review: companyMissing (PM2 S16)", () => {
  it("is set when the company research failed for good, and false otherwise", async () => {
    h = await createApiHarness();
    h.t.runner.script({ bot: "research", kind: "company", result: fake.failed("no public data") });
    await h.post("/runs", scan);
    await h.t.idle();
    const [card] = await queue(h);
    expect(card!.flags).toMatchObject({ companyMissing: true, dryRunSettled: false });
  });

  it("is false for a card with a company profile", async () => {
    const x = await toReview();
    expect((await queue(x))[0]!.flags).toMatchObject({ companyMissing: false, dryRunSettled: false });
  });
});

describe("GET /review: dryRunSettled (PM2 S15)", () => {
  it("a settled dry run puts the card back with only its CV; Approve applies live and the card leaves", async () => {
    const x = await toReview();
    const { card, cvVersionId, dryAppId } = await dryRun(x);
    const [back, ...rest] = await queue(x);
    expect(rest).toEqual([]);
    expect(back!.job.id).toBe(card.job.id);
    expect(back!.flags).toMatchObject({ dryRunSettled: true, approveAgain: false });
    expect(back!.cvOptions.map((o) => o.cvVersion.id)).toEqual([cvVersionId]);
    const live = await x.post(`/review/${card.job.id}/approve`, { cvVersionId, introText: null });
    expect(live.statusCode).toBe(200);
    expect(live.json().applicationId).not.toBe(String(dryAppId));
    await x.t.idle();
    expect(getApplication(x.t.db, Number(live.json().applicationId))).toMatchObject({ dryRun: false, status: "submitted" });
    expect(await queue(x)).toEqual([]);
  });

  it("a dry run that reported submitted stays out of the queue until Ba marks it failed", async () => {
    const x = await toReview();
    const { card, dryAppId } = await dryRun(x, true);
    expect(await queue(x)).toEqual([]);
    transitionApplication(x.t.db, dryAppId, "failed", { by: "manual", note: "checked: not sent" });
    const [back] = await queue(x);
    expect(back!.job.id).toBe(card.job.id);
    expect(back!.flags.dryRunSettled).toBe(true);
  });

  it("Ba marking a 'submitted' dry run failed announces its card (review.ready), so an open review screen shows it without a queue reload (W4b open issue 3)", async () => {
    const x = await toReview();
    const { card, dryAppId } = await dryRun(x, true);
    const readyFor = () => x.t.events("review.ready").filter((e) => e.jobId === card.job.id);
    const before = readyFor().length;
    const res = await x.post(`/applications/${dryAppId}/status`, { status: "failed", note: "checked: not sent" });
    expect(res.statusCode).toBe(200);
    const ready = readyFor();
    expect(ready).toHaveLength(before + 1);
    expect(ready.at(-1)).toMatchObject({ jobId: card.job.id, cvVersionIds: [card.cvOptions[0]!.cvVersion.id] });
    // A status change on a settled card that is already back does not announce it twice.
    const again = await x.post(`/applications/${dryAppId}/status`, { status: "failed", note: "still not sent" });
    expect([200, 409]).toContain(again.statusCode);
    expect(readyFor()).toHaveLength(before + 1);
  });

  it("Skip closes a settled dry-run card (the job is skipped, the dry run stays as it was)", async () => {
    const x = await toReview();
    const { card, dryAppId } = await dryRun(x);
    const before = getApplication(x.t.db, dryAppId);
    const res = await x.post(`/review/${card.job.id}/skip`, { reason: "salary_low", note: null });
    expect(res.statusCode).toBe(200);
    expect(getJob(x.t.db, Number(card.job.id))).toMatchObject({ status: "skipped", skipReason: "salary_low" });
    expect(getApplication(x.t.db, dryAppId)).toEqual(before);
    expect(await queue(x)).toEqual([]);
    await x.t.idle();
  });

  it("Request changes on a settled dry-run card is a conflict (409), so the UI does not offer it", async () => {
    const x = await toReview();
    const { card } = await dryRun(x);
    const res = await x.post(`/review/${card.job.id}/request-changes`, { comment: "lead with Next.js" });
    expect(res.statusCode).toBe(409);
    expect(ApiErrorSchema.parse(res.json()).error.code).toBe("conflict");
  });
});

describe("GET /review: appliedBefore (PM3 S2, §10.2 rule 5)", () => {
  it("an “apply again” card names the earlier application's date and status; a first card has none", async () => {
    const x = await toReview();
    const [first] = await queue(x);
    expect(first!.flags.appliedBefore).toBeNull();
    const cvVersionId = first!.cvOptions[0]!.cvVersion.id;
    const approved = await x.post(`/review/${first!.job.id}/approve`, { cvVersionId, introText: null });
    expect(approved.statusCode).toBe(200);
    await x.t.idle();
    const earlier = getApplication(x.t.db, Number(approved.json().applicationId))!;
    expect(earlier.status).toBe("submitted");

    // Lead (or Ba's Apply again button) starts apply-to-link with applyAgain for the same job.
    x.t.engine.startWorkflow({ workflow: "apply-to-link", params: { url: first!.job.url!, applyAgain: true, searchProfileId: null } }, { trigger: "link" });
    await x.t.idle();
    const [again, ...rest] = await queue(x);
    expect(rest).toEqual([]);
    expect(again!.job.id).toBe(first!.job.id);
    expect(again!.flags.appliedBefore).toEqual({ applicationId: String(earlier.id), at: earlier.submittedAt, status: "submitted", origin: "app", submittedAt: earlier.submittedAt });

    // Once Ba approves again, the card's own application is not "the earlier one".
    const second = await x.post(`/review/${again!.job.id}/approve`, { cvVersionId: again!.cvOptions[0]!.cvVersion.id, introText: null });
    expect(second.statusCode).toBe(200);
  });
});
