import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GuidanceRuleSetSchema, GuidanceSourceSchema, citedWebHosts, isDisputed, isPinnedPosition } from "./schema.js";
import { GUIDANCE_SEED, VNPT_REPO_PATH, VNPT_RULE_IDS, VNPT_SOURCE_ID } from "./seed.js";
import { constraintsOverriding, screenStatement } from "./text.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

const source = {
  id: "s-1",
  title: "Guide",
  publisher: null,
  url: "https://hr.example.com/guide",
  repoPath: null,
  retrievedAt: "2026-10-19T00:00:00.000Z",
  kind: "hr_publication",
  market: "global",
  host: "example.com",
} as const;

describe("guidance rule set schema (AD-10, REQ-29)", () => {
  it("REQ-29.AC-1: every seed rule lists a source, and each source has a title or publisher, a url or path, and a retrieval date", () => {
    expect(() => GuidanceRuleSetSchema.parse(GUIDANCE_SEED)).not.toThrow();
    for (const rule of GUIDANCE_SEED.rules) {
      for (const p of rule.positions) {
        expect(p.sourceIds.length, rule.id).toBeGreaterThan(0);
        for (const id of p.sourceIds) {
          const s = GUIDANCE_SEED.sources.find((x) => x.id === id)!;
          expect(s.title ?? s.publisher, id).toBeTruthy();
          expect(s.url ?? s.repoPath, id).toBeTruthy();
          expect(Date.parse(s.retrievedAt)).not.toBeNaN();
          // One quote per source (SEC-23).
          expect(p.evidence.some((e) => e.sourceId === id), `${rule.id}/${id} has evidence`).toBe(true);
        }
      }
    }
  });

  it("refuses a source with no title and no publisher, or no url and no path", () => {
    expect(GuidanceSourceSchema.safeParse({ ...source, title: null }).success).toBe(false);
    expect(GuidanceSourceSchema.safeParse({ ...source, url: null }).success).toBe(false);
    expect(GuidanceSourceSchema.safeParse({ ...source, url: "http://hr.example.com/guide" }).success).toBe(false);
    expect(GuidanceSourceSchema.safeParse(source).success).toBe(true);
  });

  it("SEC-26.AC-2: refuses a title with NUL or ESC characters", () => {
    expect(GuidanceSourceSchema.safeParse({ ...source, title: "Guide\u0000" }).success).toBe(false);
    expect(GuidanceSourceSchema.safeParse({ ...source, title: "Guide\u001b[31m" }).success).toBe(false);
  });

  it("refuses a position citing a source the set does not define", () => {
    const bad = structuredClone(GUIDANCE_SEED);
    bad.rules[0]!.positions[0]!.sourceIds.push("nowhere");
    expect(GuidanceRuleSetSchema.safeParse(bad).success).toBe(false);
  });

  it("REQ-30.AC-1, SEC-23.AC-3: the eight VNPT points (a)–(h), each citing the repo copy of the post, which exists", () => {
    const vnpt = GUIDANCE_SEED.sources.find((s) => s.id === VNPT_SOURCE_ID)!;
    expect(vnpt).toMatchObject({ repoPath: VNPT_REPO_PATH, kind: "attachment", market: "vn" });
    expect(existsSync(join(REPO, VNPT_REPO_PATH))).toBe(true);
    expect(VNPT_RULE_IDS).toHaveLength(8);
    for (const id of VNPT_RULE_IDS) {
      const rule = GUIDANCE_SEED.rules.find((r) => r.id === id)!;
      expect(rule, id).toBeDefined();
      expect(rule.positions.some((p) => p.sourceIds.includes(VNPT_SOURCE_ID) && isPinnedPosition(GUIDANCE_SEED, p)), id).toBe(true);
    }
    const checks = Object.fromEntries(VNPT_RULE_IDS.map((id) => [id, GUIDANCE_SEED.rules.find((r) => r.id === id)!.check]));
    expect(checks).toEqual({
      "dates-month-year": "month_year",
      "order-most-relevant-first": "judgement",
      "bullet-what-tech-result": "judgement",
      "contact-complete": "contact_present",
      "links-profile": "links_present",
      "skills-jd-relevant": "judgement",
      "skills-practical-experience": "practical_experience",
      "length-pages": "page_length",
    });
    expect(GUIDANCE_SEED.rules.find((r) => r.id === "links-profile")!.appliesWhen).toBe("has_profile_link");
  });

  it("REQ-31.AC-1: at least 2 distinct non-VNPT hosts back the seed", () => {
    expect(citedWebHosts(GUIDANCE_SEED).length).toBeGreaterThanOrEqual(2);
    expect(citedWebHosts(GUIDANCE_SEED).sort()).toEqual(["indeed.com", "itviec.com", "topcv.vn"]);
    for (const s of GUIDANCE_SEED.sources.filter((x) => x.url)) expect(s.contentHash, s.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("REQ-32, REQ-34: the page-length rule is disputed and overridden by over_one_page, set by code", () => {
    const rule = GUIDANCE_SEED.rules.find((r) => r.id === "length-pages")!;
    expect(isDisputed(rule)).toBe(true);
    expect(rule.overriddenBy).toEqual(["over_one_page"]);
    for (const r of GUIDANCE_SEED.rules) {
      expect(r.overriddenBy, r.id).toEqual([...new Set(r.positions.flatMap((p) => constraintsOverriding(r.topic, p.text)))].sort());
    }
  });

  it("every seed statement passes the content screen it would face in a refresh (SEC-22)", () => {
    for (const r of GUIDANCE_SEED.rules) for (const t of [r.point, ...r.positions.map((p) => p.text)]) expect(screenStatement(t), t).toBeNull();
  });

  it("AD-11: the guidance policy has no I/O and no clock", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))) {
      const text = readFileSync(join(dir, f), "utf8");
      expect(text, f).not.toMatch(/from\s+["'](node:)?(fs|child_process|net|http|https)["']|\bfetch\(|Date\.now\(|new Date\(\)/);
      expect(text, f).not.toMatch(/from\s+["'](fastify|drizzle-orm|better-sqlite3|next|react)["']/);
    }
  });
});
