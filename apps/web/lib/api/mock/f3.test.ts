// F3 (PM2 S8, S11, S15, S16) pieces in the mock orchestrator: Approve live after a settled dry run,
// "Don't allow" on a domain confirm, the figma-change choice, and review flags lib/api keeps.
import { AppEventSchema, ApplicationDetailSchema, ApplyAgainResponseSchema, type AppEvent, type MessageCard } from "@bs-job-agents/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isApiError } from "../errors";
import { createHttpApi } from "../http";
import type { MockBackend } from "./backend";
import { LEAD_ROOM_ID } from "./seed";
import { testMock } from "./testing";

let mock: MockBackend;
let events: AppEvent[];

beforeEach(() => {
  mock = testMock();
  events = [];
  mock.subscribe((e) => events.push(e));
});

afterEach(async () => {
  await mock.idle();
  for (const e of events) expect(AppEventSchema.safeParse(e).success, e.type).toBe(true);
});

const err = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);
const flags = async (jobId: string) => (await mock.getReviewQueue()).find((c) => c.job.id === jobId)?.flags;

/** A queue card with an apply link, approved as a dry run and settled. */
async function settledDryRun() {
  const card = (await mock.getReviewQueue()).find((c) => c.job.url && !c.flags.injectionFlagged && !(c.job.id in mock.state.forms))!;
  const cvVersionId = card.cvOptions[0]!.cvVersion.id;
  await mock.approve(card.job.id, { cvVersionId, introText: null, dryRun: true });
  await mock.idle();
  return { jobId: card.job.id, cvVersionId };
}

describe("Approve live after a dry run (PM2 S15)", () => {
  it("a settled dry run puts the card back with dryRunSettled; approving it applies live with the same CV", async () => {
    const { jobId, cvVersionId } = await settledDryRun();
    expect(await flags(jobId)).toMatchObject({ dryRunSettled: true });
    expect(events.some((e) => e.type === "review.ready" && e.jobId === jobId)).toBe(true);
    expect(isApiError(await err(mock.approve(jobId, { cvVersionId, introText: null, dryRun: true })))).toBe(true);
    const live = await mock.approve(jobId, { cvVersionId, introText: null });
    expect(live.applicationId).not.toBeNull();
    await mock.idle();
    expect(Object.values(mock.state.applications).filter((a) => a.jobId === jobId).map((a) => [a.dryRun, a.status])).toEqual([
      [true, "needs_check"],
      [false, "submitted"],
    ]);
  });

  it("refuses with already_applied while a dry run that reported 'submitted' waits for Ba's check", async () => {
    const { jobId, cvVersionId } = await settledDryRun();
    const dry = Object.values(mock.state.applications).find((a) => a.jobId === jobId && a.dryRun)!;
    dry.statusHistory.push({ status: "needs_check", at: mock.nowIso(), note: "dry run reported submitted" });
    const e = await err(mock.approve(jobId, { cvVersionId, introText: null }));
    expect(isApiError(e) && [e.status, e.code]).toEqual([409, "already_applied"]);
  });
});

describe("Don't allow on a domain confirm (UC-11 e)", () => {
  it("fails Apply's task there and says so; a second decline is a 409", async () => {
    mock.simulate("domain-confirm");
    await mock.idle();
    const [taskId] = Object.keys(mock.state.pauses);
    await mock.declineDomain(taskId!);
    await mock.idle();
    expect(events.find((e) => e.type === "task.finished" && e.taskId === taskId)).toMatchObject({ status: "failed" });
    const last = (await mock.listMessages(LEAD_ROOM_ID)).messages.at(-1)!;
    expect(last.text).toMatch(/Apply stopped and did not continue on \*\*acme\.wd3\.myworkdayjobs\.com\*\*/);
    const again = await err(mock.declineDomain(taskId!));
    expect(isApiError(again) && again.status).toBe(409);
  });
});

describe("figma-change choice (PM2 S8)", () => {
  it("Lead asks with a figma-change:<taskId> chip; 'That was me — retry' gets an answer", async () => {
    mock.simulate("figma-change");
    await mock.idle();
    const msg = (await mock.listMessages(LEAD_ROOM_ID)).messages.at(-1)!;
    const card = msg.cards.find((c): c is Extract<MessageCard, { type: "choice" }> => c.type === "choice")!;
    expect(card.key).toMatch(/^figma-change:\d+$/);
    expect(card.options.map((o) => o.label)).toEqual(["That was me — retry", "Not me"]);
    await mock.chooseOption({ messageId: msg.id, key: card.key, optionId: "was_me" });
    await mock.idle();
    expect((await mock.listMessages(LEAD_ROOM_ID)).messages.at(-1)!.text).toMatch(/CV is tailoring again/);
  });
});

describe("PM3 S2: an “apply again” card says Ba applied before", () => {
  it("Apply again on a failed application: the new card names the earlier application; other cards don't", async () => {
    const failed = Object.values(mock.state.applications).find((a) => a.status === "failed" && !a.dryRun)!;
    const { jobId } = await mock.request("POST", "/applications/:id/apply-again", { params: { id: failed.id }, schema: ApplyAgainResponseSchema });
    expect(jobId).toBe(failed.jobId);
    await mock.idle();
    const cards = await mock.getReviewQueue();
    const again = cards.find((c) => c.flags.appliedBefore);
    expect(again?.flags.appliedBefore).toEqual({ applicationId: failed.id, at: failed.statusHistory[0]!.at, status: "failed", origin: "app", submittedAt: null });
    expect(cards.filter((c) => c.flags.appliedBefore)).toHaveLength(1);
  });
});

describe("PM3 S4: a saved preset, started by name", () => {
  it("approve a proposal, then ask Lead for it by name: a job scan named after the preset, with its params", async () => {
    mock.simulate("workflow-proposal");
    await mock.idle();
    const proposal = mock.state.proposals.at(-1)!;
    await mock.request("POST", "/workflow-proposals/:id/approve", { params: { id: proposal.id } });
    await mock.sendMessage({ roomId: LEAD_ROOM_ID, text: `run ${proposal.name} please`, uploadIds: [] });
    await mock.idle();
    const [row] = await mock.listRuns();
    expect(row).toMatchObject({ workflowName: "job-scan", presetName: proposal.name, params: { overrides: { locations: ["Ho Chi Minh City", "Đà Nẵng"] } } });
    expect((await mock.getRun(row!.id)).presetName).toBe(proposal.name);
  });
});

describe("PM3 S3: the approval before a submission record exists", () => {
  it("an approved application with no record shows its approval", async () => {
    const card = (await mock.getReviewQueue()).find((c) => c.job.url && !c.flags.injectionFlagged)!;
    const cvVersionId = card.cvOptions[0]!.cvVersion.id;
    const { applicationId } = await mock.approve(card.job.id, { cvVersionId, introText: null });
    const detail = await mock.request("GET", "/applications/:id", { params: { id: applicationId! }, schema: ApplicationDetailSchema });
    expect(detail.application.status).toBe("approved");
    expect(detail.submission).toBeNull();
    expect(detail.approval).toEqual({ approvedAt: mock.nowIso(), cvVersionId, allowedDomains: [new URL(card.job.url!).hostname.replace(/^www\./, "")], note: null });
  });
});

describe("F3's review flags and Don't allow on the live client", () => {
  it("live: getReviewQueue keeps companyMissing and dryRunSettled", async () => {
    const card = (await mock.getReviewQueue())[0]!;
    const body = { cards: [{ ...card, flags: { ...card.flags, companyMissing: true, dryRunSettled: true } }] };
    const fetch = async () => new Response(JSON.stringify(body), { status: 200 });
    const api = createHttpApi({ baseUrl: "/api", fetch: fetch as typeof globalThis.fetch, events: mock });
    const [read] = await api.getReviewQueue();
    expect(read!.flags).toMatchObject({ companyMissing: true, dryRunSettled: true });
  });

  it("live: Don't allow posts POST /tasks/:id/decline-domain; a refusal shows the server's own reason", async () => {
    const calls: string[] = [];
    const fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method} ${String(url)}`);
      return new Response(JSON.stringify({ error: { code: "conflict", message: "task 5 is not waiting for a domain to confirm", details: null } }), { status: 409 });
    };
    const api = createHttpApi({ baseUrl: "/api", fetch: fetch as typeof globalThis.fetch, events: mock });
    const e = await err(api.declineDomain("5"));
    expect(calls).toEqual(["POST /api/tasks/5/decline-domain"]);
    expect(isApiError(e) && [e.code, e.message]).toEqual(["conflict", "task 5 is not waiting for a domain to confirm"]);
  });
});

describe("Resume now (live run 1, POST /engines/:engine/resume)", () => {
  it("clears a usage-limit pause, emits engine.resumed and tells Ba in Lead's room; not paused is a conflict", async () => {
    mock.simulate("claude-limit");
    await mock.idle();
    expect((await mock.listEngines()).find((e) => e.engine === "claude")?.pausedUntil).not.toBeNull();
    await mock.resumeEngine("claude");
    await mock.idle();
    expect((await mock.listEngines()).find((e) => e.engine === "claude")).toMatchObject({ pausedUntil: null, reason: null });
    expect(events).toContainEqual(expect.objectContaining({ type: "engine.resumed", engine: "claude" }));
    const texts = (await mock.listMessages(LEAD_ROOM_ID)).messages.map((m) => m.text);
    expect(texts).toContainEqual(expect.stringMatching(/Claude resumed by you/));
    const e = await err(mock.resumeEngine("claude"));
    expect(isApiError(e) && e.code).toBe("conflict");
  });
});
