import { describe, expect, it } from "vitest";
import { appliedGuidance, jobMarketOf, resolveGuidance } from "./resolve.js";
import type { GuidanceRuleSet, GuidanceSource } from "./schema.js";
import { GUIDANCE_SEED } from "./seed.js";

const src = (id: string, host: string, market: "vn" | "global" = "global"): GuidanceSource => ({
  id,
  title: id,
  publisher: null,
  url: `https://${host}/${id}`,
  repoPath: null,
  retrievedAt: "2026-10-19T00:00:00.000Z",
  kind: market === "vn" ? "vn_recruiter" : "hr_publication",
  market,
  host,
  contentHash: null,
  etag: null,
  lastModified: null,
});

function disputed(p1: GuidanceSource[], p2: GuidanceSource[]): GuidanceRuleSet {
  return {
    sources: [...p1, ...p2],
    rules: [
      {
        id: "summary-length",
        topic: "summary",
        point: "How long the summary is",
        check: "judgement",
        appliesWhen: "always",
        overriddenBy: [],
        positions: [
          { id: "p1", text: "Two lines.", sourceIds: p1.map((s) => s.id), evidence: p1.map((s) => ({ sourceId: s.id, quote: "two lines summary quote" })) },
          { id: "p2", text: "Four lines.", sourceIds: p2.map((s) => s.id), evidence: p2.map((s) => ({ sourceId: s.id, quote: "four lines summary quote" })) },
        ],
      },
    ],
  };
}

const ctx = { masterContact: { links: ["https://www.linkedin.com/in/bahuynh"] }, jobMarket: "global" as const, turnedOff: [] };

describe("resolveGuidance (AD-11)", () => {
  it("REQ-33.AC-1: the position cited by 3 sources applies; the other is not applied", () => {
    const r = resolveGuidance(disputed([src("a", "a.example"), src("b", "b.example"), src("c", "c.example")], [src("d", "d.example")]), ctx).rules[0]!;
    expect(r.disposition).toBe("applied");
    expect(r.applied?.id).toBe("p1");
    expect(r.positions.map((p) => p.status)).toEqual(["applied", "not_applied"]);
  });

  it("REQ-33.AC-2, SEC-23.AC-2: 3 pages on one host count once: 1 host each, a tie, neither applies", () => {
    const r = resolveGuidance(disputed([src("a1", "a.example"), src("a2", "a.example"), src("a3", "a.example")], [src("b", "b.example")]), ctx).rules[0]!;
    expect(r.positions.map((p) => p.hosts)).toEqual([1, 1]);
    expect(r.disposition).toBe("disputed_not_applied");
    expect(r.applied).toBeNull();
  });

  it("the market tie-break: a tie applies the position with a source of the job's market", () => {
    const set = disputed([src("a", "a.example", "vn")], [src("b", "b.example")]);
    const vn = resolveGuidance(set, { ...ctx, jobMarket: "vn" }).rules[0]!;
    expect(vn).toMatchObject({ disposition: "applied", applied: { id: "p1" } });
    expect(vn.positions[0]!.status).toBe("applied_market");
    const global = resolveGuidance(set, ctx).rules[0]!;
    expect(global).toMatchObject({ disposition: "applied", applied: { id: "p2" } });
    // Both tied positions have a source of the market: still not applied.
    const both = resolveGuidance(disputed([src("a", "a.example", "vn")], [src("b", "b.example", "vn")]), { ...ctx, jobMarket: "vn" }).rules[0]!;
    expect(both.disposition).toBe("disputed_not_applied");
  });

  it("F2: a refresh position with one host cannot replace a pinned post's position, even on a market tie-break; with 2 hosts it can", () => {
    const vnpt: GuidanceSource = { ...src("vnpt", "attachment:vnpt", "vn"), kind: "attachment", url: null, repoPath: "docs/x.png" };
    const blogs = ["a", "b", "c"].map((n) => src(`blog-${n}`, "blogspot.com"));
    const one = disputed([vnpt], blogs);
    for (const jobMarket of ["global", "vn"] as const) {
      const r = resolveGuidance(one, { ...ctx, jobMarket }).rules[0]!;
      expect(r.applied?.id, jobMarket).toBe("p1");
    }
    const two = disputed([vnpt], [src("x", "x.example.com"), src("y", "y.example.org")]);
    expect(resolveGuidance(two, ctx).rules[0]!.applied?.id).toBe("p2");
  });

  it("REQ-34.AC-1: the page-length rule is overridden by over_one_page", () => {
    const r = resolveGuidance(GUIDANCE_SEED, ctx).rules.find((x) => x.ruleId === "length-pages")!;
    expect(r.disposition).toBe("overridden");
    expect(r.reason).toMatch(/over_one_page/);
  });

  it("REQ-37.AC-4: no GitHub, LinkedIn or portfolio link → the links rule is not applicable", () => {
    const r = resolveGuidance(GUIDANCE_SEED, { ...ctx, masterContact: { links: [] } }).rules.find((x) => x.ruleId === "links-profile")!;
    expect(r.disposition).toBe("not_applicable");
    expect(resolveGuidance(GUIDANCE_SEED, ctx).rules.find((x) => x.ruleId === "links-profile")!.disposition).toBe("applied");
  });

  it("turned off by Ba wins over everything, and is not sent to tailor", () => {
    const resolved = resolveGuidance(GUIDANCE_SEED, { ...ctx, turnedOff: ["length-pages", "order-most-relevant-first"] });
    expect(resolved.rules.find((x) => x.ruleId === "length-pages")!.disposition).toBe("turned_off");
    expect(resolved.rules.find((x) => x.ruleId === "order-most-relevant-first")!.disposition).toBe("turned_off");
    expect(appliedGuidance(resolved).map((g) => g.ruleId)).not.toContain("order-most-relevant-first");
  });

  it("every rule gets exactly one disposition and its sources", () => {
    const resolved = resolveGuidance(GUIDANCE_SEED, ctx, 7);
    expect(resolved.snapshot).toBe(7);
    expect(resolved.rules).toHaveLength(GUIDANCE_SEED.rules.length);
    for (const r of resolved.rules) expect(r.sources.length, r.ruleId).toBeGreaterThan(0);
  });

  it("the job market: a VI JD or a job in Vietnam is vn", () => {
    expect(jobMarketOf({ language: "vi", location: "Remote" })).toBe("vn");
    expect(jobMarketOf({ language: "en", location: "Ho Chi Minh City" })).toBe("vn");
    expect(jobMarketOf({ language: "en", location: "Berlin" })).toBe("global");
  });
});
