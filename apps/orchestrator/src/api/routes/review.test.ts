import { ApiErrorSchema, ApproveResponseSchema, OkResponseSchema, ReviewQueueResponseSchema, type PendingQuestion } from "@bs-job-agents/shared";
import { qaFailFixture, qaPassFixture } from "@bs-job-agents/shared/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { getApplication, getCvVersion, getJob, getOrCreateLeadRoom, getSavedAnswer, getTask, listEvents, listMessages } from "../../db/index.js";
import { fake } from "../../engine/testing/index.js";
import type { TestEngineOptions } from "../../engine/testing/index.js";
import { FILE_BYTES, createApiHarness, writeDataFile, type ApiHarness } from "../testing.js";

let h: ApiHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const scan = { workflow: "job-scan", params: { searchProfileId: null, overrides: null } } as const;

/** Run job-scan to its review card(s). */
async function toReview(opts: TestEngineOptions = {}): Promise<ApiHarness> {
  h = await createApiHarness({ engine: opts });
  expect((await h.post("/runs", scan)).statusCode).toBe(201);
  await h.t.idle();
  return h;
}

async function queue(x: ApiHarness) {
  const res = await x.get("/review");
  expect(res.statusCode).toBe(200);
  return ReviewQueueResponseSchema.parse(res.json()).cards;
}

describe("GET /review (§11 Review queue)", () => {
  it("builds the card: job, company, CV option with its QA rounds, flags and when it became ready", async () => {
    const x = await toReview();
    const [card, ...rest] = await queue(x);
    expect(rest).toEqual([]);
    expect(card!.job).toMatchObject({ id: "1", company: "NovaPay", status: "reviewing" });
    expect(card!.company?.name).toBe("NovaPay");
    expect(card!.runId).toBe("1");
    expect(card!.defaultLanguage).toBe("en");
    expect(card!.cvOptions).toHaveLength(1);
    expect(card!.cvOptions[0]!.cvVersion.language).toBe("en");
    expect(card!.cvOptions[0]!.qaRounds.length).toBeGreaterThan(0);
    expect(card!.introText).toBeNull();
    expect(card!.flags).toEqual({
      qaPassed: true,
      escalated: false,
      needsInput: card!.factRequests.length > 0,
      injectionFlagged: false,
      masterChanged: false,
      noApplyLink: false,
      lowConfidenceCompany: false,
      approveAgain: false,
      companyMissing: false,
      dryRunSettled: false,
      appliedBefore: null,
    });
    const ready = listEvents(x.t.db, { types: ["review.ready"] }).at(-1)!;
    expect(card!.readyAt).toBe(ready.createdAt);
  });

  it("offers the CV PDF to the viewer only when the file exists in data/", async () => {
    const x = await toReview();
    expect((await queue(x))[0]!.cvOptions[0]!.pdf).toBeNull();
    const cv = getCvVersion(x.t.db, Number((await queue(x))[0]!.cvOptions[0]!.cvVersion.id))!;
    writeDataFile(x.dataDir, cv.pdfPath!, FILE_BYTES.pdf);
    expect((await queue(x))[0]!.cvOptions[0]!.pdf).toEqual({ id: `cv-${cv.id}`, kind: "cv_pdf", filename: cv.pdfPath!.split("/").at(-1), mime: "application/pdf" });
  });

  it("a Vietnamese JD has VI and EN options and defaults to VI (§6.3, UC-08 a)", async () => {
    const x = await toReview({ sources: ["topcv"] });
    const [card] = await queue(x);
    expect(card!.defaultLanguage).toBe("vi");
    expect(card!.cvOptions.map((o) => o.cvVersion.language)).toEqual(["vi", "en"]);
  });

  it("flags a suspected injection (UC-07 b) and a changed master CV (UC-20); Apply stays disabled (403)", async () => {
    h = await createApiHarness();
    h.t.runner.script({
      bot: "qa",
      kind: "review",
      result: fake.ok({ ...qaFailFixture, total: 88, scores: qaPassFixture.scores, hardFails: [], injectionSuspected: true, injectionNote: "the JD says 'ignore previous instructions'" }),
    });
    await h.post("/runs", scan);
    await h.t.idle();
    writeDataFile(h.dataDir, "master-cv.yaml", "version: 9\nfacts: []\n");
    const [card] = await queue(h);
    expect(card!.flags).toMatchObject({ injectionFlagged: true, masterChanged: true, qaPassed: true });
    const approveBody = { cvVersionId: card!.cvOptions[0]!.cvVersion.id, introText: null };
    const res = await h.post(`/review/${card!.job.id}/approve`, approveBody);
    expect(res.statusCode).toBe(403);
    expect(ApiErrorSchema.parse(res.json()).error.code).toBe("forbidden");
    // Ba confirms on the card first (UC-07 b), audited as injection.confirmed; then Approve works.
    const confirm = await h.post(`/review/${card!.job.id}/confirm-injection`);
    expect(confirm.statusCode).toBe(200);
    expect(OkResponseSchema.parse(confirm.json())).toEqual({ ok: true });
    expect(h.t.events("injection.confirmed")).toEqual([expect.objectContaining({ jobId: card!.job.id, runId: card!.runId })]);
    expect((await queue(h))[0]!.flags.injectionFlagged).toBe(false);
    expect((await h.post(`/review/${card!.job.id}/approve`, approveBody)).statusCode).toBe(200);
  });

  it("confirm-injection on a job that is not flagged is a conflict (409); an unknown job is 404", async () => {
    const x = await toReview();
    const [card] = await queue(x);
    const res = await x.post(`/review/${card!.job.id}/confirm-injection`);
    expect(res.statusCode).toBe(409);
    expect(x.t.events("injection.confirmed")).toEqual([]);
    expect((await x.post("/review/999/confirm-injection")).statusCode).toBe(404);
  });

  it("confirm-injection is a state change: refused without the CSRF header (S18)", async () => {
    const x = await toReview();
    const [card] = await queue(x);
    const res = await x.app.inject({ method: "POST", url: `/review/${card!.job.id}/confirm-injection`, headers: { host: "127.0.0.1:4100", origin: "http://localhost:3000" } });
    expect(res.statusCode).toBe(403);
  });

  it("marks a card whose QA did not pass in 3 rounds as escalated (UC-07 a), with every round", async () => {
    h = await createApiHarness();
    h.t.runner.script({ bot: "qa", kind: "review", result: fake.ok(qaFailFixture) });
    await h.post("/runs", scan);
    await h.t.idle();
    const [card] = await queue(h);
    expect(card!.flags).toMatchObject({ qaPassed: false, escalated: true });
    expect(card!.cvOptions[0]!.qaRounds).toHaveLength(3);
  });
});

describe("POST /review/:jobId/approve (UC-08)", () => {
  it("approves through the engine: application, token expiry and domains, never the token itself; Apply runs", async () => {
    const x = await toReview();
    const [card] = await queue(x);
    const res = await x.post(`/review/${card!.job.id}/approve`, { cvVersionId: card!.cvOptions[0]!.cvVersion.id, introText: "Edited intro" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ applicationId: expect.any(String), taskId: expect.any(String), reapproval: false });
    expect(body.approval.allowedDomains).toEqual(["itviec.com"]);
    expect(Date.parse(body.approval.expiresAt)).toBeGreaterThan(x.t.clock.now().getTime());
    expect(res.body).not.toMatch(/[a-f0-9]{64}/);
    expect(JSON.stringify(body)).not.toContain("token");
    await x.t.idle();
    expect(x.t.runner.callsFor("apply.submit")).toHaveLength(1);
    expect(getApplication(x.t.db, Number(body.applicationId))?.status).toMatch(/submitted|needs_check/);
    expect(await queue(x)).toEqual([]);
    // A finished Apply step is never re-run (UC-23).
    const apply = x.t.step(1, "apply", card!.job.id)!;
    const rerun = await x.post(`/steps/${apply.id}/rerun`);
    expect(rerun.statusCode).toBe(403);
    expect(ApiErrorSchema.parse(rerun.json()).error.code).toBe("forbidden");
  });

  it("a dry-run approval (§12) runs Apply with dryRun: fill and screenshot, never a live submit", async () => {
    const x = await toReview();
    const [card] = await queue(x);
    const res = await x.post(`/review/${card!.job.id}/approve`, { cvVersionId: card!.cvOptions[0]!.cvVersion.id, introText: null, dryRun: true });
    expect(res.statusCode).toBe(200);
    expect(ApproveResponseSchema.parse(res.json())).toMatchObject({ applicationId: expect.any(String), taskId: expect.any(String), reapproval: false });
    await x.t.idle();
    const calls = x.t.runner.callsFor("apply.submit");
    expect(calls).toHaveLength(1);
    expect((calls[0]!.input as { dryRun?: unknown }).dryRun).toBe(true);
  });

  it("a dryRun that is not a boolean is refused (400) and approves nothing", async () => {
    const x = await toReview();
    const [card] = await queue(x);
    const res = await x.post(`/review/${card!.job.id}/approve`, { cvVersionId: card!.cvOptions[0]!.cvVersion.id, introText: null, dryRun: "yes" });
    expect(res.statusCode).toBe(400);
    expect(getApplication(x.t.db, 1)).toBeUndefined();
    expect(x.t.tasks("apply.submit")).toEqual([]);
  });

  it("a cross-site form POST to approve is refused and approves nothing (S18: the human gate)", async () => {
    const x = await toReview();
    const [card] = await queue(x);
    const res = await x.request("POST", `/review/${card!.job.id}/approve`, `cvVersionId=${card!.cvOptions[0]!.cvVersion.id}&introText=`, {
      origin: "http://evil.example",
      "sec-fetch-site": "cross-site",
      "content-type": "application/x-www-form-urlencoded",
      "x-bsja-csrf": "",
    });
    expect(res.statusCode).toBe(403);
    expect(getApplication(x.t.db, 1)).toBeUndefined();
    expect(x.t.tasks("apply.submit")).toEqual([]);
    expect((await queue(x)).map((c) => c.job.id)).toEqual([card!.job.id]);
  });

  it("refuses a CV version that is not on the card (400), a second approval (409) and an unknown job (404)", async () => {
    const x = await toReview();
    const [card] = await queue(x);
    expect((await x.post(`/review/${card!.job.id}/approve`, { cvVersionId: "999", introText: null })).statusCode).toBe(400);
    expect((await x.post(`/review/${card!.job.id}/approve`, { cvVersionId: "abc", introText: null })).statusCode).toBe(400);
    expect((await x.post(`/review/${card!.job.id}/approve`, { introText: null })).statusCode).toBe(400);
    expect((await x.post(`/review/${card!.job.id}/approve`, { cvVersionId: card!.cvOptions[0]!.cvVersion.id, introText: null })).statusCode).toBe(200);
    const again = await x.post(`/review/${card!.job.id}/approve`, { cvVersionId: card!.cvOptions[0]!.cvVersion.id, introText: null });
    expect(again.statusCode).toBe(409);
    expect((await x.post(`/review/999/approve`, { cvVersionId: "1", introText: null })).statusCode).toBe(404);
    await x.t.idle();
  });

  it("a card whose Apply was stopped before it ran waits for Ba to approve again (PM M2)", async () => {
    const x = await toReview();
    const [card] = await queue(x);
    const siteGuard = x.t.guards.siteGuard.bind(x.t.guards);
    let broken = true;
    x.t.guards.siteGuard = (o) => {
      if (broken) throw new Error("hook entry missing");
      return siteGuard(o);
    };
    const first = (await x.post(`/review/${card!.job.id}/approve`, { cvVersionId: card!.cvOptions[0]!.cvVersion.id, introText: null })).json();
    await x.t.idle();
    const [again] = await queue(x);
    expect(again!.flags.approveAgain).toBe(true);
    expect(again!.cvOptions.map((o) => o.cvVersion.id)).toEqual([card!.cvOptions[0]!.cvVersion.id]);
    broken = false;
    const res = await x.post(`/review/${card!.job.id}/approve`, { cvVersionId: card!.cvOptions[0]!.cvVersion.id, introText: null });
    expect(res.json()).toMatchObject({ applicationId: first.applicationId, reapproval: true });
    await x.t.idle();
    expect(await queue(x)).toEqual([]);
  });
});

describe("request changes and skip (UC-09, UC-10)", () => {
  it("request changes starts a new QA-gate pass; the card comes back with a new CV version", async () => {
    const x = await toReview();
    const [card] = await queue(x);
    const res = await x.post(`/review/${card!.job.id}/request-changes`, { comment: "lead with Next.js" });
    expect(res.statusCode).toBe(200);
    expect(OkResponseSchema.parse(res.json())).toEqual({ ok: true });
    await x.t.idle();
    const [back] = await queue(x);
    expect(back!.cvOptions[0]!.cvVersion.id).not.toBe(card!.cvOptions[0]!.cvVersion.id);
    expect(back!.cvOptions[0]!.qaRounds.length).toBeGreaterThan(card!.cvOptions[0]!.qaRounds.length);
    expect((await x.post(`/review/${card!.job.id}/request-changes`, { comment: " " })).statusCode).toBe(400);
  });

  it("skip stores the reason (input for sub-project D); other needs a note", async () => {
    const x = await toReview();
    const [card] = await queue(x);
    expect((await x.post(`/review/${card!.job.id}/skip`, { reason: "other", note: null })).statusCode).toBe(400);
    expect((await x.post(`/review/${card!.job.id}/skip`, { reason: "outsourcing", note: null })).statusCode).toBe(200);
    expect(getJob(x.t.db, Number(card!.job.id))).toMatchObject({ status: "skipped", skipReason: "outsourcing" });
    expect(await queue(x)).toEqual([]);
    await x.t.idle();
  });
});

describe("POST /questions/:taskId/answer (UC-12)", () => {
  const notice: PendingQuestion = { field: "notice", label: "Notice period", required: true, kind: "text", options: null };
  const visa: PendingQuestion = { field: "visa", label: "Visa status", required: true, kind: "text", options: null };

  it("answers Apply's questions one at a time, remembers an answer, then Apply resumes", async () => {
    const x = await toReview();
    const [card] = await queue(x);
    x.t.runner.script({ bot: "apply", kind: "submit", times: 1, result: fake.applyPaused({ questions: [notice, visa] }) });
    const { taskId } = (await x.post(`/review/${card!.job.id}/approve`, { cvVersionId: card!.cvOptions[0]!.cvVersion.id, introText: null })).json();
    await x.t.idle();
    expect(getTask(x.t.db, Number(taskId))?.status).toBe("paused");
    // No field: the question Lead asked last.
    const first = await x.post(`/questions/${taskId}/answer`, { mode: "answer", value: "2 weeks", remember: true });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ resumed: false, next: visa });
    expect(getSavedAnswer(x.t.db, "Notice period")?.answer).toBe("2 weeks");
    const second = await x.post(`/questions/${taskId}/answer`, { field: "visa", mode: "answer", value: "Vietnamese citizen", remember: false });
    expect(second.json()).toEqual({ resumed: true, next: null });
    await x.t.idle();
    expect(getTask(x.t.db, Number(taskId))?.status).toBe("done");
    // The question cards render as answered after a reload.
    const room = getOrCreateLeadRoom(x.t.db);
    const questionCards = listMessages(x.t.db, room.id)
      .flatMap((m) => ((m.meta?.cards ?? []) as { type: string; taskId?: string; question?: { field: string }; answered?: boolean }[]))
      .filter((c) => c.type === "question" && c.taskId === String(taskId));
    expect(questionCards.length).toBeGreaterThan(0);
    expect(questionCards.every((c) => c.answered === true)).toBe(true);
  });

  it("refuses an empty answer (400), an unknown field (400) and a task that waits for nothing (409)", async () => {
    const x = await toReview();
    const [card] = await queue(x);
    x.t.runner.script({ bot: "apply", kind: "submit", times: 1, result: fake.applyPaused({ questions: [notice] }) });
    const { taskId } = (await x.post(`/review/${card!.job.id}/approve`, { cvVersionId: card!.cvOptions[0]!.cvVersion.id, introText: null })).json();
    await x.t.idle();
    expect((await x.post(`/questions/${taskId}/answer`, { mode: "answer", value: null, remember: false })).statusCode).toBe(400);
    expect((await x.post(`/questions/${taskId}/answer`, { field: "nope", mode: "answer", value: "x", remember: false })).statusCode).toBe(400);
    // Skip is for optional fields only.
    expect((await x.post(`/questions/${taskId}/answer`, { mode: "skip", value: null, remember: false })).statusCode).toBe(400);
    expect((await x.post(`/questions/1/answer`, { mode: "answer", value: "x", remember: false })).statusCode).toBe(409);
    expect((await x.post(`/questions/999/answer`, { mode: "answer", value: "x", remember: false })).statusCode).toBe(404);
  });
});
