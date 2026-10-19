import { describe, expect, it } from "vitest";
import type { GuidanceItem } from "./checks.js";
import { resolveGuidance } from "./resolve.js";
import { completeGuidanceReview, guidanceAttention, hasFixableMiss, type ReviewerItem } from "./review.js";
import { GUIDANCE_SEED } from "./seed.js";

const resolved = resolveGuidance(GUIDANCE_SEED, { masterContact: { links: ["https://www.linkedin.com/in/bahuynh"] }, jobMarket: "global", turnedOff: [] }, 3);
const judgement = resolved.rules.filter((r) => r.disposition === "applied" && r.check === "judgement").map((r) => r.ruleId);
const met = (ruleId: string): ReviewerItem => ({ ruleId, status: "met", reason: "ok", fixable: false, fix: null, needsFact: null });
const checker = (ruleId: string, over: Partial<GuidanceItem> = {}): GuidanceItem => ({ ruleId, status: "met", reason: "ok", fixable: false, fix: null, factRequests: [], ...over });
const checkers = ["dates-month-year", "contact-complete", "links-profile", "skills-practical-experience", "length-pages"].map((id) => checker(id));

describe("completeGuidanceReview (AD-11)", () => {
  it("REQ-37.AC-1: every rule gets one status and lists its sources", () => {
    const r = completeGuidanceReview(resolved, checkers, judgement.map(met), ["f-1"]);
    expect(r.items).toHaveLength(GUIDANCE_SEED.rules.length);
    expect(r.snapshot).toBe(3);
    for (const i of r.items) {
      expect(["met", "not_met", "needs_fact", "not_applicable", "overridden", "disputed_not_applied"]).toContain(i.status);
      expect(i.sources.length, i.ruleId).toBeGreaterThan(0);
    }
    expect(r.items.find((i) => i.ruleId === "length-pages")).toMatchObject({ status: "overridden", by: "resolver" });
    expect(guidanceAttention(r)).toEqual([]);
  });

  it("REQ-38.AC-1: a fixable not_met with active facts becomes a fix for the next round", () => {
    const reviewer = [...judgement.filter((id) => id !== "order-most-relevant-first").map(met), { ruleId: "order-most-relevant-first", status: "not_met" as const, reason: "React first", fixable: true, fix: { instruction: "Move f-1 above f-2", factIds: ["f-1", "f-2"] }, needsFact: null }];
    const r = completeGuidanceReview(resolved, checkers, reviewer, ["f-1", "f-2"]);
    expect(hasFixableMiss(r)).toBe(true);
    expect(r.fixes).toEqual([{ ruleId: "order-most-relevant-first", point: expect.any(String), instruction: "Move f-1 above f-2", factIds: ["f-1", "f-2"] }]);
  });

  it("a fix citing an unknown or inactive fact is dropped (the rule stays not met, not fixable)", () => {
    const reviewer = [{ ruleId: "order-most-relevant-first", status: "not_met" as const, reason: "React first", fixable: true, fix: { instruction: "Add the Kafka role", factIds: ["f-99"] }, needsFact: null }];
    const r = completeGuidanceReview(resolved, checkers, reviewer, ["f-1"]);
    const item = r.items.find((i) => i.ruleId === "order-most-relevant-first")!;
    expect(item).toMatchObject({ status: "not_met", fixable: false, fix: null });
    expect(r.fixes).toEqual([]);
    expect(hasFixableMiss(r)).toBe(false);
  });

  it("REQ-39.AC-1: a missing result figure → needs fact for f-5, one fact request (field result)", () => {
    const reviewer = [{ ruleId: "bullet-what-tech-result", status: "needs_fact" as const, reason: "no result", fixable: false, fix: null, needsFact: { factId: "f-5", question: "What result did optimising the order service have?" } }];
    const r = completeGuidanceReview(resolved, checkers, reviewer, ["f-5"]);
    expect(r.factRequests).toEqual([{ ruleId: "bullet-what-tech-result", factId: "f-5", field: "result", question: "What result did optimising the order service have?" }]);
    // A question about a fact the CV may not use is no request.
    const unknown = completeGuidanceReview(resolved, checkers, reviewer, []);
    expect(unknown.factRequests).toEqual([]);
    expect(unknown.items.find((i) => i.ruleId === "bullet-what-tech-result")!.status).toBe("not_met");
  });

  it("deterministic checker items win over the reviewer's for the same rule", () => {
    const r = completeGuidanceReview(
      resolved,
      [checker("dates-month-year", { status: "needs_fact", factRequests: [{ factId: "f-12", field: "dates", question: "Months of f-12?" }] })],
      [met("dates-month-year")],
      ["f-12"],
    );
    expect(r.items.find((i) => i.ruleId === "dates-month-year")).toMatchObject({ status: "needs_fact", by: "code" });
  });

  it("a round without cv.review leaves judgement rules not_reviewed; the deterministic ones still count", () => {
    const r = completeGuidanceReview(resolved, [checker("skills-practical-experience", { status: "not_met", fixable: true, fix: { instruction: "Remove Go", factIds: [] } })], null, []);
    expect(r.reviewed).toBe(false);
    expect(r.items.find((i) => i.ruleId === judgement[0])!.status).toBe("not_reviewed");
    expect(r.fixes.map((f) => f.instruction)).toEqual(["Remove Go"]);
  });

  it("REQ-40: attention lists not met, then needs fact, then disputed not applied", () => {
    const reviewer = [
      { ruleId: "bullet-what-tech-result", status: "needs_fact" as const, reason: "no result", fixable: false, fix: null, needsFact: { factId: "f-5", question: "Result?" } },
      { ruleId: "order-most-relevant-first", status: "not_met" as const, reason: "order", fixable: false, fix: null, needsFact: null },
    ];
    const r = completeGuidanceReview(resolved, checkers, reviewer, ["f-5"]);
    expect(guidanceAttention(r).map((i) => i.status)).toEqual(["not_met", "needs_fact"]);
  });
});
