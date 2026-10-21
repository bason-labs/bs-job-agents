// UC-20 "master data changed" on review cards, with CV auto-extend: an automatic addition of
// derived facts (or its Undo, or a Keep) bumps the master version but is not a change of Ba's, so
// other jobs' cards stay quiet; a save of his, or a cited fact undone or flagged, still flags them.
import { factSourceHash, type Fact, type MasterCv } from "@bs-job-agents/shared";
import { cvOutputFixture, masterCvFixture } from "@bs-job-agents/shared/fixtures";
import { describe, expect, it } from "vitest";
import { masterChangedFor } from "./review.js";

const fact = (id: string, text: string): Fact => ({ id, type: "experience", text, textVi: null, tags: [], org: "Gradion", dates: "2023-2025" });
const tailored = { ...cvOutputFixture.tailored, summary: { text: "x", factIds: ["f-1"] }, sections: [{ ...cvOutputFixture.tailored.sections[0]!, items: [{ heading: null, subheading: null, bullets: [{ text: "y", factIds: ["f-1"] }] }] }] };
const f1 = fact("f-1", "Built the portal in React");
const derived: Fact = { ...fact("f-d1", "Redux"), derived: { restsOn: [{ factId: "f-1", relation: "implied_from", sourceHash: factSourceHash(f1) }], via: "table", rationale: null, requirement: "Redux", jobId: "2", taskId: null, derivedAt: "2026-10-19T08:00:00Z" } };
const cv = (facts: Fact[], version: number): MasterCv => ({ ...masterCvFixture, version, facts });

describe("masterChangedFor", () => {
  it("ignores versions made by automatic additions, their Undo and Keep", () => {
    expect(masterChangedFor({ masterVersion: 3, tailored }, { version: 5, cv: cv([f1, derived], 5), derivedRevisions: new Set([4, 5]) })).toBe(false);
  });

  it("flags a version Ba saved after the CV", () => {
    expect(masterChangedFor({ masterVersion: 3, tailored }, { version: 5, cv: cv([f1, derived], 5), derivedRevisions: new Set([4]) })).toBe(true);
  });

  it("flags a cited derived fact that was undone or is flagged, even when only automatic versions came after", () => {
    const cites = { ...tailored, summary: { text: "Redux", factIds: ["f-d1"] } };
    expect(masterChangedFor({ masterVersion: 4, tailored: cites }, { version: 5, cv: cv([f1], 5), derivedRevisions: new Set([5]) })).toBe(true);
    const stale = cv([{ ...f1, text: "Built the portal in Vue" }, derived], 5);
    expect(masterChangedFor({ masterVersion: 4, tailored: cites }, { version: 5, cv: stale, derivedRevisions: new Set([5]) })).toBe(true);
    expect(masterChangedFor({ masterVersion: 5, tailored: cites }, { version: 5, cv: stale, derivedRevisions: new Set() })).toBe(false);
  });
});
