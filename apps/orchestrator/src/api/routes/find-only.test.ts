// W5: Upwork is find only (SEARCH_SOURCES.upwork.canApply = false). Its jobs reach the review
// queue flagged `findOnly`; Approve — live or dry run — is refused with 409 and details.reason
// "find_only", and no application, approval token or Apply task is ever created. A pasted Upwork
// link (source "link") is refused the same way.
import { ApiErrorSchema, FIND_ONLY_NOTE, FIND_ONLY_REASON, ReviewQueueResponseSchema, type JobCandidate } from "@bs-job-agents/shared";
import { researchScanFixture } from "@bs-job-agents/shared/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { listApplications } from "../../db/index.js";
import { fake } from "../../engine/testing/index.js";
import { createApiHarness, type ApiHarness } from "../testing.js";

let h: ApiHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const UPWORK_JOB: JobCandidate = {
  ...researchScanFixture.jobs[0]!,
  source: "upwork",
  url: "https://www.upwork.com/jobs/~021900000000000000001",
  title: "Senior React Developer for fintech dashboard",
  company: "Upwork client (United States)",
  location: "Remote",
  workMode: "remote",
};

async function upworkCard(job: JobCandidate = UPWORK_JOB) {
  h = await createApiHarness({ engine: { sources: ["upwork"] } });
  h.t.runner.script({ bot: "research", kind: "scan", result: fake.ok({ ...researchScanFixture, jobs: [job] }) });
  expect((await h.post("/runs", { workflow: "job-scan", params: { searchProfileId: null, overrides: null } })).statusCode).toBe(201);
  await h.t.idle();
  const res = await h.get("/review");
  const cards = ReviewQueueResponseSchema.parse(res.json()).cards;
  expect(cards).toHaveLength(1);
  return { x: h, card: cards[0]! };
}

describe("Upwork is find only", () => {
  it("the card is flagged; Approve and a dry run are refused with find_only; nothing is created", async () => {
    const { x, card } = await upworkCard();
    expect(card.job).toMatchObject({ source: "upwork", url: UPWORK_JOB.url });
    expect(card.flags.findOnly).toBe(true);
    const cvVersionId = card.cvOptions[0]!.cvVersion.id;
    for (const dryRun of [false, true]) {
      const res = await x.post(`/review/${card.job.id}/approve`, { cvVersionId, introText: null, dryRun });
      expect(res.statusCode).toBe(409);
      expect(ApiErrorSchema.parse(res.json()).error).toEqual({ code: "conflict", message: FIND_ONLY_NOTE, details: { reason: FIND_ONLY_REASON, source: "upwork" } });
    }
    await x.t.idle();
    expect(listApplications(x.t.db)).toEqual([]);
    expect(x.t.db.$client.prepare("SELECT COUNT(*) AS n FROM approvals").get()).toEqual({ n: 0 });
    expect(x.t.tasks("apply.submit")).toEqual([]);
    // Ba can still skip the card.
    const skipped = await x.post(`/review/${card.job.id}/skip`, { reason: "other", note: "applied on Upwork myself" });
    expect(skipped.statusCode).toBe(200);
  });

  it("a job from another board is not flagged", async () => {
    h = await createApiHarness();
    await h.post("/runs", { workflow: "job-scan", params: { searchProfileId: null, overrides: null } });
    await h.t.idle();
    const [card] = ReviewQueueResponseSchema.parse((await h.get("/review")).json()).cards;
    expect(card!.flags.findOnly).toBe(false);
  });

  it("an Upwork posting found under another source (e.g. a pasted link) is refused by its URL", async () => {
    const { x, card } = await upworkCard({ ...UPWORK_JOB, source: "link" });
    expect(card.flags.findOnly).toBe(true);
    const res = await x.post(`/review/${card.job.id}/approve`, { cvVersionId: card.cvOptions[0]!.cvVersion.id, introText: null });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details).toEqual({ reason: "find_only", source: "upwork" });
  });
});
