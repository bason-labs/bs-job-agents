// S13 (pm-phase-3): data.example/master-cv.yaml, Ba's master facts seeded from
// build_targeted_resumes.py (spec §6.1). Ba copies it to data/ on the first run (README).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MasterCvSchema } from "@bs-job-agents/shared";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const SEED = fileURLToPath(new URL("../../../data.example/master-cv.yaml", import.meta.url));
const cv = MasterCvSchema.parse(parse(readFileSync(SEED, "utf8")));

describe("data.example/master-cv.yaml (§6.1, S13)", () => {
  it("passes MasterCvSchema as version 1 with Ba's contact line", () => {
    expect(cv.version).toBe(1);
    expect(cv.contact).toMatchObject({ name: "Ba Huynh", email: "huynhthienba4@gmail.com", phone: "+84 37 247 4489", location: "Ho Chi Minh City, Vietnam" });
    expect(cv.contact.links).toEqual(["https://www.linkedin.com/in/bahuynh"]);
  });

  it("covers the three employers, skills and education, each experience fact with its org and dates", () => {
    const orgs = new Set(cv.facts.filter((f) => f.type === "experience").map((f) => f.org));
    expect([...orgs].sort()).toEqual(["Aegona", "Apps Cyclone", "Gradion"]);
    for (const type of ["experience", "project", "skill", "education", "metric"] as const) {
      expect(cv.facts.some((f) => f.type === type), type).toBe(true);
    }
    for (const f of cv.facts.filter((x) => x.type === "experience")) expect(f.dates, f.id).toMatch(/\d{4}/);
  });

  it("has headline options, with Vietnamese where the source has it", () => {
    expect(cv.headlineOptions.length).toBeGreaterThanOrEqual(3);
    expect(cv.headlineOptions.some((h) => h.vi !== null)).toBe(true);
  });

  it("keeps the Vietnamese wording where the source has it", () => {
    expect(cv.facts.filter((f) => f.textVi !== null).length).toBeGreaterThanOrEqual(8);
  });

  it("has tags on every fact, and no numbers beyond the source's (4+ years, about 300 employees, Next.js 14, the dates)", () => {
    for (const f of cv.facts) {
      expect(f.tags.length, f.id).toBeGreaterThan(0);
      const numbers = `${f.text} ${f.textVi ?? ""}`.match(/\b\d+\b/g) ?? []; // whole numbers, not the 8 in n8n
      for (const n of numbers) expect(["4", "300", "14"], `${f.id}: ${n}`).toContain(n);
    }
  });
});
