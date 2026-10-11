import type { ReviewCard } from "@bs-job-agents/shared";
import { reviewCardFixture } from "@bs-job-agents/shared/fixtures";
import { describe, expect, it } from "vitest";
import { ApiRequestError } from "@/lib/api/errors";
import {
  approveErrorText,
  approveLabel,
  applyDomain,
  isDryRunSettled,
  companySummary,
  cvName,
  escalationNote,
  flagNotices,
  gapText,
  hardFailText,
  introPayload,
  jobMeta,
  roundLabel,
} from "./model";

const card = (over: Partial<ReviewCard> = {}, flags: Partial<ReviewCard["flags"]> = {}): ReviewCard => ({
  ...reviewCardFixture,
  ...over,
  flags: { ...reviewCardFixture.flags, ...flags },
});
const option = reviewCardFixture.cvOptions[0]!;

describe("review card model", () => {
  it("job meta line like the prototype", () => {
    expect(jobMeta(reviewCardFixture.job)).toBe("ITviec · Ho Chi Minh City · hybrid · 2,000–2,800 USD · JD language: EN");
    expect(jobMeta({ ...reviewCardFixture.job, source: "file", salaryText: null, workMode: null, language: "vi" })).toBe(
      "Uploaded file · Ho Chi Minh City · salary not listed · JD language: VI",
    );
  });

  it("Apply's domain is the job URL's host (approve dialog)", () => {
    expect(applyDomain(reviewCardFixture.job)).toBe("itviec.com");
    expect(applyDomain({ ...reviewCardFixture.job, url: "https://www.topcv.vn/viec-lam/x.html" })).toBe("topcv.vn");
    expect(applyDomain({ ...reviewCardFixture.job, url: null })).toBeNull();
  });

  it("QA round label and hard fails", () => {
    expect(roundLabel(option.cvVersion)).toBe("round 1 of 3");
    expect(roundLabel({ ...option.cvVersion, round: 4 })).toBe("round 4");
    expect(hardFailText(option.qaRounds.at(-1)!)).toBe("Hard fails: none · Truth check: every claim traced to master facts ✓");
    expect(
      hardFailText({ ...option.qaRounds[0]!, hardFails: [{ code: "invented_claim", detail: "'Python automation' is not supported", section: "Projects" }] }),
    ).toBe("Hard fails: invented claim — 'Python automation' is not supported (Projects)");
  });

  it("an escalated card says why QA did not pass and what Ba can do (UC-07 a)", () => {
    const last = { ...option.qaRounds[0]!, total: 76, passed: false, scores: { ...option.qaRounds[0]!.scores, jdMatch: { score: 30, justification: "JD wants Python 3+ years; master data has none." } } };
    expect(escalationNote({ ...option, qaRounds: [last, last, last] })).toBe(
      "QA did not pass after 3 rounds: JD wants Python 3+ years; master data has none. Decide: approve anyway, request changes, or skip.",
    );
  });

  it("flag notices: injection, confirmed injection, master changed, no apply link, low confidence, needs input, approve again", () => {
    expect(flagNotices(card()).map((n) => n.key)).toEqual([]);
    const all = card(
      { job: { ...reviewCardFixture.job, injectionFlagged: true } },
      { injectionFlagged: true, masterChanged: true, noApplyLink: true, lowConfidenceCompany: true, needsInput: true },
    );
    expect(flagNotices(all).map((n) => n.key)).toEqual(["injection", "master", "noApplyLink", "lowConfidence", "needsInput"]);
    const cleared = card({ job: { ...reviewCardFixture.job, injectionFlagged: true, injectionClearedAt: "2026-10-10T10:42:00+07:00" } });
    expect(flagNotices(cleared).map((n) => n.key)).toEqual(["injectionCleared"]);
    const again = card({}, { approveAgain: true });
    expect(flagNotices(again).map((n) => n.key)).toEqual(["approveAgain"]);
  });

  it("F3 flags: company research failed, and a settled dry run that can go live (PM2 S15/S16)", () => {
    const missing = card({}, { companyMissing: true } as Partial<ReviewCard["flags"]>);
    expect(flagNotices(missing)).toEqual([{ key: "companyMissing", tone: "warn", text: "Company research failed · continuing without it. CV tailored this CV without a company profile." }]);
    const settled = card({}, { dryRunSettled: true } as Partial<ReviewCard["flags"]>);
    expect(isDryRunSettled(settled)).toBe(true);
    expect(flagNotices(settled).map((n) => n.key)).toEqual(["dryRunSettled"]);
    expect(approveLabel(settled)).toBe("Approve live & submit");
  });

  it("the injection notice does not assume QA found it (Research flags scans too, PM2 S11)", () => {
    const flagged = card({ job: { ...reviewCardFixture.job, injectionFlagged: true } }, { injectionFlagged: true });
    expect(flagNotices(flagged)[0]!.text).toMatch(/^A bot found text in this job post that tries to instruct the bots/);
  });

  it("explains an already_applied refusal of Approve live", () => {
    expect(approveErrorText(new ApiRequestError({ status: 409, code: "already_applied", message: "the dry run reported that it submitted" }))).toBe(
      "The dry run reported that it submitted, so it may really have been sent. Check it on the Applications screen and mark it failed before approving live.",
    );
    expect(approveErrorText(new Error("boom"))).toBe("boom");
  });

  it("approve button label follows the card (prototype + PM S24 'approve again')", () => {
    expect(approveLabel(card())).toBe("Approve & submit");
    expect(approveLabel(card({}, { qaPassed: false, escalated: true }))).toBe("Approve anyway & submit");
    expect(approveLabel(card({}, { approveAgain: true }))).toBe("Approve again & submit");
    expect(approveLabel(card({}, { noApplyLink: true }))).toBe("Approve (PDF only)");
  });

  it("an empty intro means Apply writes one (PM FYI e)", () => {
    expect(introPayload("  ")).toBeNull();
    expect(introPayload(" Xin chào ")).toBe("Xin chào");
  });

  it("summarises the company profile like the prototype", () => {
    expect(companySummary(reviewCardFixture.company)).toBe(
      "Fintech product company, ~250 people. Culture: ownership, code review heavy. Benefits: 13th month, hybrid 3/2, MacBook, health insurance. Engineers praise ownership and code quality; some mention long release weeks.",
    );
    expect(companySummary(null)).toBe("No company profile yet.");
  });

  it("gap lines read like the prototype", () => {
    expect(gapText("Asks for GraphQL — not in master data")).toBe("Gap: asks for GraphQL — not in master data");
    expect(gapText("GraphQL missing")).toBe("Gap: GraphQL missing");
    expect(gapText("Gap: x")).toBe("Gap: x");
  });

  it("names the CV PDF", () => {
    expect(cvName(option)).toBe("BA_HUYNH_NovaPay_EN_v1.pdf");
    expect(cvName({ ...option, pdf: null })).toBe("NOVAPAY_SENIOR-FRONTEND_EN_v1.pdf");
  });
});
