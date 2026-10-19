import { GUIDANCE_SEED, type GuidanceRuleSet } from "@bs-job-agents/shared";
import { describe, expect, it } from "vitest";
import { openTestDb } from "../client.js";
import { listEvents } from "./events.js";
import { commitGuidanceRuleSet, currentGuidanceRuleSet, getGuidanceSettings, guidanceStoreState, releaseGuidanceLock, setGuidanceRuleOff, takeGuidanceLock } from "./guidance.js";

const AT = new Date("2026-10-18T08:00:00.000Z");

function changedSeed(): GuidanceRuleSet {
  const next = structuredClone(GUIDANCE_SEED);
  next.sources.push({ id: "hr-1", title: "HR guide", publisher: null, url: "https://hr.example.com/g", repoPath: null, retrievedAt: AT.toISOString(), kind: "hr_publication", market: "global", host: "example.com", contentHash: "h", etag: null, lastModified: null });
  next.rules.push({ id: "summary-short", topic: "summary", point: "A short summary opens the CV", check: "judgement", appliesWhen: "always", overriddenBy: [], positions: [{ id: "p-sum", text: "Open with a two-line summary.", sourceIds: ["hr-1"], evidence: [{ sourceId: "hr-1", quote: "open with a two-line summary" }] }] });
  next.rules.find((r) => r.id === "consistent-formats")!.positions[0]!.sourceIds.push("hr-1");
  next.rules.find((r) => r.id === "consistent-formats")!.positions[0]!.evidence.push({ sourceId: "hr-1", quote: "use the same date format everywhere" });
  return next;
}

describe("guidance store (AD-10)", () => {
  it("REQ-36.AC-1: a commit that adds one rule and changes one writes 2 entries with that time, previous and new text, and sources", () => {
    const db = openTestDb();
    commitGuidanceRuleSet(db, { runId: null, ruleSet: GUIDANCE_SEED }, { now: new Date("2026-10-17T00:00:00Z") });
    const before = listEvents(db).length;
    const r = commitGuidanceRuleSet(db, { runId: 7, ruleSet: changedSeed() }, { now: AT });
    expect(r.snapshot).toBe(2);
    const entries = listEvents(db).slice(before);
    expect(entries.map((e) => e.type)).toEqual(["guidance.rule_changed", "guidance.rule_added"]);
    for (const e of entries) expect(e.createdAt).toBe(AT.toISOString());
    expect(entries.find((e) => e.type === "guidance.rule_added")!.payload).toMatchObject({ snapshot: 2, runId: "7", ruleId: "summary-short", previousText: "", newText: "Open with a two-line summary.", sourceIds: ["hr-1"], applied: true });
    expect(entries.find((e) => e.type === "guidance.rule_changed")!.payload).toMatchObject({ ruleId: "consistent-formats", previousText: "Write dates, titles and formatting the same way in every section.", newText: "Write dates, titles and formatting the same way in every section.", sourceIds: ["hr-1", "indeed-effective-resume"] });
    // SEC-24.AC-4: rule ids, text and source ids only: no page text, no contact data.
    expect(JSON.stringify(entries.map((e) => e.payload))).not.toMatch(/evidence|quote|@|\+84/);
    expect(currentGuidanceRuleSet(db)?.snapshot).toBe(2);
  });

  it("SEC-24.AC-3: a throw inside the commit keeps the previous snapshot and writes no entry", () => {
    const db = openTestDb();
    commitGuidanceRuleSet(db, { runId: null, ruleSet: GUIDANCE_SEED }, { now: AT });
    const before = listEvents(db).length;
    expect(() => commitGuidanceRuleSet(db, { runId: 7, ruleSet: changedSeed(), failAfterEvents: () => { throw new Error("disk full"); } }, { now: AT })).toThrow(/disk full/);
    expect(currentGuidanceRuleSet(db)?.snapshot).toBe(1);
    expect(currentGuidanceRuleSet(db)?.ruleSet).toEqual(GUIDANCE_SEED);
    expect(listEvents(db).length).toBe(before);
  });

  it("F8: a corrupt newest snapshot leaves the last readable one in force, and the next commit does not reuse its number", () => {
    const db = openTestDb();
    commitGuidanceRuleSet(db, { runId: null, ruleSet: GUIDANCE_SEED }, { now: AT });
    db.$client.prepare("INSERT INTO guidance_rule_sets (snapshot, run_id, rule_set_json, created_at) VALUES (2, NULL, '{\"rules\": 7}', ?)").run(AT.toISOString());
    expect(guidanceStoreState(db)).toMatchObject({ latestNumber: 2, corrupt: true, current: { snapshot: 1 } });
    expect(currentGuidanceRuleSet(db)?.ruleSet).toEqual(GUIDANCE_SEED);
    expect(commitGuidanceRuleSet(db, { runId: 3, ruleSet: changedSeed() }, { now: AT }).snapshot).toBe(3);
  });

  it("snapshots are append-only: the database refuses UPDATE and DELETE", () => {
    const db = openTestDb();
    commitGuidanceRuleSet(db, { runId: null, ruleSet: GUIDANCE_SEED }, { now: AT });
    expect(() => db.$client.prepare("UPDATE guidance_rule_sets SET run_id = 1").run()).toThrow(/append-only/);
    expect(() => db.$client.prepare("DELETE FROM guidance_rule_sets").run()).toThrow(/append-only/);
  });

  it("Ba's turned-off rules; the refresh lock is held by one run, freed by it, and stale after the budget", () => {
    const db = openTestDb();
    setGuidanceRuleOff(db, "length-pages", true);
    setGuidanceRuleOff(db, "order-most-relevant-first", true);
    setGuidanceRuleOff(db, "length-pages", false);
    expect(getGuidanceSettings(db).turnedOff).toEqual(["order-most-relevant-first"]);
    expect(takeGuidanceLock(db, 1, AT, 300_000)).toEqual({ held: true, holder: 1 });
    expect(takeGuidanceLock(db, 2, AT, 300_000)).toEqual({ held: false, holder: 1 });
    expect(takeGuidanceLock(db, 2, new Date(AT.getTime() + 301_000), 300_000)).toEqual({ held: true, holder: 2 });
    releaseGuidanceLock(db, 1);
    expect(getGuidanceSettings(db).lockRunId).toBe(2);
    releaseGuidanceLock(db, 2);
    expect(getGuidanceSettings(db).lockRunId).toBeNull();
  });
});
