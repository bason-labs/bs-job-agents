// Trust guard (§3 rule 6, §5.3, §10.2 rules 1, 2 and 4; PM M2, S1). Unit level, on real SQLite.
import { BotDefinitionSchema, SAFETY_DENIAL_REASONS, type BotDefinition } from "@bs-job-agents/shared";
import { botDefinitionFixtures } from "@bs-job-agents/shared/fixtures";
import { beforeEach, describe, expect, it } from "vitest";
import {
  APPROVAL_DENIALS,
  approveApplication,
  clearJobInjection,
  createApplication,
  createApproval,
  flagJobInjection,
  getApproval,
  openTestDb,
  type Db,
} from "../db/index.js";
import { NOVAPAY, T0, at, seedBots, seedCv, seedJob } from "../db/test-helpers.js";
import type { EffectiveBot } from "./bots.js";
import { authorizeApplyToken, checkTaskTrust, checkToken, precheckApplyToken, safetyReasonFor } from "./trust-guard.js";

const defs = new Map<string, BotDefinition>(botDefinitionFixtures.map((d) => [d.name, BotDefinitionSchema.parse(d)]));
const bot = (name: string, trustLevel: 0 | 1 | 2, over: Partial<BotDefinition> = {}): EffectiveBot => ({
  def: { ...defs.get(name)!, ...over },
  trustLevel,
  enabled: true,
});

describe("checkTaskTrust: who may act (§5.3, rule 6)", () => {
  it("L2 bots act on their own within their tools", () => {
    expect(checkTaskTrust(bot("research", 2), "scan")).toEqual({ ok: true, needsApproval: false });
    expect(checkTaskTrust(bot("cv", 2), "tailor")).toEqual({ ok: true, needsApproval: false });
  });

  it("an outward-facing task needs an approval token whatever the trust level says (PM S1)", () => {
    expect(checkTaskTrust(bot("apply", 1), "submit")).toEqual({ ok: true, needsApproval: true });
    // Apply at L2 in the database: the token is still required.
    expect(checkTaskTrust(bot("apply", 2), "submit")).toEqual({ ok: true, needsApproval: true });
  });

  it("L0 never acts outward-facing", () => {
    expect(checkTaskTrust(bot("apply", 0), "submit")).toMatchObject({ ok: false, reason: "trust_level" });
  });

  it("refuses a definition that breaks the Phase 1 safety rules (S6: Apply at L2 in bot.json, Apply on Codex)", () => {
    expect(checkTaskTrust(bot("apply", 1, { trustLevel: 2 }), "submit")).toMatchObject({ ok: false, reason: "trust_level" });
    expect(checkTaskTrust(bot("apply", 1, { engine: "codex" }), "submit")).toMatchObject({ ok: false, reason: "trust_level" });
  });

  it("refuses CV switched to Codex: figma_execute would run without the Drafts-only guard hook (§6.2)", () => {
    expect(checkTaskTrust(bot("cv", 2, { engine: "codex" }), "tailor")).toMatchObject({ ok: false, reason: "trust_level", detail: expect.stringMatching(/Figma bridge must run on Claude/) });
  });

  it("owner decision 2026-10-11: CV on Codex runs with Ba's opt-in; the opt-in never lets Apply or Lead onto Codex", () => {
    const acked = (b: EffectiveBot): EffectiveBot => ({ ...b, engineRiskAcknowledged: true });
    expect(checkTaskTrust(acked(bot("cv", 2, { engine: "codex" })), "tailor")).toEqual({ ok: true, needsApproval: false });
    expect(checkTaskTrust(acked(bot("apply", 1, { engine: "codex" })), "submit")).toMatchObject({ ok: false, reason: "trust_level" });
    expect(checkTaskTrust(acked(bot("lead", 1, { engine: "codex" })), "chat")).toMatchObject({ ok: false, reason: "trust_level", detail: expect.stringMatching(/Lead must run on Claude/) });
  });

  it("consult and discussion tasks never need a token: they run read-only (UC-15, UC-25)", () => {
    expect(checkTaskTrust(bot("apply", 1), "consult")).toEqual({ ok: true, needsApproval: false });
    expect(checkTaskTrust(bot("qa", 2), "discussion")).toEqual({ ok: true, needsApproval: false });
  });

  it("a disabled bot does not run", () => {
    expect(checkTaskTrust({ ...bot("research", 2), enabled: false }, "scan")).toMatchObject({ ok: false, reason: "trust_level" });
  });
});

describe("Apply's approval token (§10.2 rule 1, UC-11 f, PM M2)", () => {
  let db: Db;
  beforeEach(() => {
    db = openTestDb();
    seedBots(db);
  });

  function approved(opts: { dryRun?: boolean } = {}) {
    const job = seedJob(db);
    const cv = seedCv(db, job);
    const { application, approval } = approveApplication(db, { jobId: job.id, cvVersionId: cv.id, allowedDomains: ["itviec.com"], ...opts }, { now: T0 });
    const req = { applicationId: application.id, jobId: job.id, cvVersionId: cv.id, domain: "itviec.com", resume: false, now: at(60) };
    return { job, cv, application, approval, req };
  }

  it("the first spawn consumes the newest token issued for the application", () => {
    const { approval, req } = approved();
    expect(precheckApplyToken(db, req)).toMatchObject({ ok: true, mode: "first" });
    expect(getApproval(db, approval.token)?.usedAt).toBeNull();
    expect(authorizeApplyToken(db, req)).toMatchObject({ ok: true, mode: "first", approval: { token: approval.token } });
    expect(getApproval(db, approval.token)?.usedAt).toBe(at(60).toISOString());
  });

  it("no token: an application nobody approved", () => {
    const job = seedJob(db);
    const cv = seedCv(db, job);
    const app = createApplication(db, { jobId: job.id, cvVersionId: cv.id });
    const r = authorizeApplyToken(db, { applicationId: app.id, jobId: job.id, cvVersionId: cv.id, domain: "itviec.com", resume: false, now: at(1) });
    expect(r).toMatchObject({ ok: false, denial: "not_found", reason: "no_token" });
  });

  it("expired: the 24 h limit (UC-08)", () => {
    const { req } = approved();
    expect(authorizeApplyToken(db, { ...req, now: at(24 * 3600 + 1) })).toMatchObject({ ok: false, denial: "expired", reason: "token_expired" });
  });

  it("reused: a second first spawn for the same application", () => {
    const { req } = approved();
    expect(authorizeApplyToken(db, req).ok).toBe(true);
    expect(authorizeApplyToken(db, req)).toMatchObject({ ok: false, denial: "used", reason: "token_used" });
  });

  it("wrong job, wrong CV version, wrong domain", () => {
    const { req, job } = approved();
    const other = seedJob(db, { ...NOVAPAY, url: "https://itviec.com/it-jobs/other-2", title: "Backend Engineer" });
    expect(authorizeApplyToken(db, { ...req, jobId: other.id })).toMatchObject({ ok: false, reason: "wrong_job" });
    const otherCv = seedCv(db, job, at(5));
    expect(authorizeApplyToken(db, { ...req, cvVersionId: otherCv.id })).toMatchObject({ ok: false, reason: "wrong_cv" });
    expect(authorizeApplyToken(db, { ...req, domain: "evil.example" })).toMatchObject({ ok: false, reason: "wrong_domain" });
    // A subdomain of an allowed domain is fine; the token is still unused after the denials.
    expect(authorizeApplyToken(db, { ...req, domain: "jobs.itviec.com" })).toMatchObject({ ok: true });
  });

  it("wrong application: a token issued for another application (e.g. a dry run's) is never accepted", () => {
    const real = approved();
    const dry = approveApplication(db, { jobId: real.job.id, cvVersionId: real.cv.id, allowedDomains: ["itviec.com"], dryRun: true }, { now: T0 });
    expect(checkToken(db, dry.approval.token, real.req, "consume")).toMatchObject({ ok: false, denial: "application_mismatch", reason: "wrong_application" });
  });

  it("an injection-flagged job stays blocked until Ba confirms (UC-07 b)", () => {
    const { req, job } = approved();
    flagJobInjection(db, job.id);
    expect(authorizeApplyToken(db, req)).toMatchObject({ ok: false, reason: "injection_flagged" });
    clearJobInjection(db, job.id);
    expect(authorizeApplyToken(db, req)).toMatchObject({ ok: true });
  });

  it("a resume re-validates the token the first spawn used (UC-11 a/b/e, UC-12, UC-17)", () => {
    const { req } = approved();
    authorizeApplyToken(db, req);
    expect(authorizeApplyToken(db, { ...req, resume: true, now: at(3600) })).toMatchObject({ ok: true, mode: "resume" });
    expect(authorizeApplyToken(db, { ...req, resume: true, now: at(25 * 3600) })).toMatchObject({ ok: false, reason: "token_expired" });
  });

  it("after expiry Ba approves again: the next spawn is a first spawn of the new token", () => {
    const { req, application, job, cv } = approved();
    authorizeApplyToken(db, req);
    const fresh = createApproval(db, { applicationId: application.id, jobId: job.id, cvVersionId: cv.id, allowedDomains: ["itviec.com"] }, { now: at(25 * 3600) });
    expect(authorizeApplyToken(db, { ...req, resume: true, now: at(25 * 3600 + 60) })).toMatchObject({
      ok: true,
      mode: "first",
      approval: { token: fresh.token },
    });
  });

  it("every denial has a safety.denied reason", () => {
    for (const denial of APPROVAL_DENIALS) expect(SAFETY_DENIAL_REASONS).toContain(safetyReasonFor(denial));
  });
});
