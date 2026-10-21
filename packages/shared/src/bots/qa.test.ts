// NG8 (CV guidance, AD-13): QA's contract is pinned. Guidance never changes its hard fails, score
// maxima or pass rule, and neither QA's schema nor its role knows anything of guidance.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getBotOutputJsonSchema } from "./registry.js";
import { QaHardFailCodeSchema, qaPassed } from "./qa.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../../../..");

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? filesUnder(join(dir, n)) : [join(dir, n)]));
}

describe("QA is unchanged by CV guidance (NG8)", () => {
  it("pins the hard-fail list, including over_one_page", () => {
    expect(QaHardFailCodeSchema.options).toEqual(["invented_claim", "wrong_language", "wrong_company", "pdf_unreadable", "over_one_page", "ats_order", "missing_section"]);
  });

  it("pins the score maxima and the pass rule (total ≥ 80, no hard fails)", () => {
    const scores = (getBotOutputJsonSchema("QaOutput") as { properties: { scores: { properties: Record<string, { properties: { score: { maximum: number } } }> } } }).properties.scores.properties;
    expect(Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, v.properties.score.maximum]))).toEqual({ jdMatch: 40, companyTone: 20, formatAts: 20, clarity: 20 });
    expect(qaPassed({ total: 80, hardFails: [] })).toBe(true);
    expect(qaPassed({ total: 79, hardFails: [] })).toBe(false);
    expect(qaPassed({ total: 95, hardFails: [{ code: "over_one_page", detail: "2 pages", section: null }] })).toBe(false);
  });

  it("AD-13: neither bots/qa.ts nor bots/qa/** mentions guidance", () => {
    for (const f of [join(HERE, "qa.ts"), ...filesUnder(join(REPO, "bots/qa"))]) {
      if (f.endsWith("memory.md")) continue;
      expect(readFileSync(f, "utf8"), f).not.toMatch(/[Gg]uidance/);
    }
  });
});
