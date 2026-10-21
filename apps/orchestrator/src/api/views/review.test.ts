// CV guidance through the API (§7, REQ-40, §5.8, §5.9, SEC-17.AC-3): the review card's guidance
// panel per language, the guidance fact requests asked once across jobs, the Guidance and Activity
// screens' data, Turn off / Turn on, and the master CV untouched by a refresh plus a review.
import { ActivityResponseSchema, CV_REVIEW_SELF_CHECK, FactRequestsResponseSchema, GuidanceViewSchema, ReviewQueueResponseSchema, guidanceAttention, type CvReviewOutput, type TailoredCv } from "@bs-job-agents/shared";
import { cvOutputFixture, researchScanFixture } from "@bs-job-agents/shared/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { markGuidanceDiscovery, setGuidanceRuleOff } from "../../db/repos/guidance.js";
import { fake, fakeFrameName } from "../../engine/testing/fake-runner.js";
import { FakeGuidanceFetch, truthfulMaster, writeMaster } from "../../engine/testing/guidance.js";
import type { RunnerTask } from "../../runner/types.js";
import { createApiHarness, type ApiHarness } from "../testing.js";

let h: ApiHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const NOVAPAY = researchScanFixture.jobs[0]!;
const scan = { workflow: "job-scan", params: { searchProfileId: null, overrides: null } } as const;
const pass = (item: string) => ({ item, passed: true, note: null });

async function harness(jobs = [NOVAPAY], opts: { months?: boolean } = {}) {
  const fetch = new FakeGuidanceFetch();
  h = await createApiHarness({ engine: { guidance: { fetch } } });
  const master = truthfulMaster();
  if (opts.months) for (const f of master.facts) f.dates = "Sep 2022 – Present";
  writeMaster(h.t.files, h.t.masterCv, master);
  markGuidanceDiscovery(h.t.db, h.t.clock.now().toISOString());
  setGuidanceRuleOff(h.t.db, "contact-complete", true);
  setGuidanceRuleOff(h.t.db, "links-profile", true);
  h.t.runner.script({ bot: "research", kind: "scan", result: fake.ok({ ...researchScanFixture, jobs }) });
  return h;
}

const review = (items: CvReviewOutput["items"]) => (task: RunnerTask) => {
  const rules = (task.input as { rules: { ruleId: string }[] }).rules;
  return fake.ok({
    items: rules.map((r) => items.find((i) => i.ruleId === r.ruleId) ?? { ruleId: r.ruleId, status: "met", reason: "Met.", fixable: false, fix: null, needsFact: null }),
    selfCheck: CV_REVIEW_SELF_CHECK.map(pass),
    memoryNotes: [],
  });
};

async function cards(x: ApiHarness) {
  const res = await x.get("/review");
  expect(res.statusCode).toBe(200);
  return ReviewQueueResponseSchema.parse(res.json()).cards;
}

describe("the review step's CV guidance panel (REQ-40)", () => {
  it("REQ-40.AC-1: one rule not met and one needing a fact: both with their source names, and the one fact request", async () => {
    const x = await harness([NOVAPAY], { months: true });
    // Months on the CV too, so dates are met; the reviewer finds one miss it cannot fix and one missing result.
    const tailored: TailoredCv = structuredClone(cvOutputFixture.tailored);
    tailored.sections[0]!.items[0]!.subheading = "Sep 2022 – Present";
    x.t.runner.script({ bot: "cv", kind: "tailor", result: (task) => fake.ok({ ...cvOutputFixture, figmaFrameName: fakeFrameName(task.input as Parameters<typeof fakeFrameName>[0]), factRequests: [], tailored }) });
    x.t.runner.script({
      bot: "cv",
      kind: "review",
      result: review([
        { ruleId: "order-most-relevant-first", status: "not_met", reason: "The most relevant work is not first.", fixable: false, fix: null, needsFact: null },
        { ruleId: "bullet-what-tech-result", status: "needs_fact", reason: "The purchase order bullet has no result.", fixable: false, fix: null, needsFact: { factId: "grad-2", question: "What result did the purchase order system have?" } },
      ]),
    });
    expect((await x.post("/runs", scan)).statusCode).toBe(201);
    await x.t.idle();
    const [card] = await cards(x);
    const g = card!.cvOptions[0]!.guidance!;
    expect(g).toMatchObject({ rounds: 1, revisions: 0 });
    const attention = guidanceAttention(g.result);
    expect(attention.map((i) => [i.ruleId, i.status])).toEqual([
      ["order-most-relevant-first", "not_met"],
      ["bullet-what-tech-result", "needs_fact"],
    ]);
    for (const i of attention) expect(i.sources.map((s) => s.publisher ?? s.title)).toContain("VNPT (Tuyển dụng VNPT)");
    expect(g.result.factRequests).toEqual([{ ruleId: "bullet-what-tech-result", factId: "grad-2", field: "result", question: "What result did the purchase order system have?" }]);
    // The card's own list keeps CV's questions only, in the bot's shape (it still validates).
    expect(card!.factRequests.every((r) => Object.keys(r).sort().join() === "question,reason,topic")).toBe(true);
    const requests = FactRequestsResponseSchema.parse((await x.get("/master-cv/fact-requests")).json()).requests;
    expect(requests.filter((r) => r.origin === "guidance")).toEqual([
      expect.objectContaining({ id: "g-bullet-what-tech-result-grad-2-result", ruleId: "bullet-what-tech-result", ruleLabel: "Each experience item says what was done, with which technology, and what result came of it", factId: "grad-2", field: "result" }),
    ]);
  });

  it("REQ-40.AC-2: every rule met, not applicable or overridden: no rule needs Ba (the panel says All CV guidance rules met)", async () => {
    const x = await harness([NOVAPAY], { months: true });
    const tailored: TailoredCv = structuredClone(cvOutputFixture.tailored);
    tailored.sections[0]!.items[0]!.subheading = "Sep 2022 – Present";
    x.t.runner.script({ bot: "cv", kind: "tailor", result: (task) => fake.ok({ ...cvOutputFixture, figmaFrameName: fakeFrameName(task.input as Parameters<typeof fakeFrameName>[0]), factRequests: [], tailored }) });
    expect((await x.post("/runs", scan)).statusCode).toBe(201);
    await x.t.idle();
    const [card] = await cards(x);
    const g = card!.cvOptions[0]!.guidance!;
    expect(guidanceAttention(g.result)).toEqual([]);
    expect(g.result.items.every((i) => ["met", "not_applicable", "overridden", "turned_off"].includes(i.status))).toBe(true);
  });

  it("§5.8: the same months request raised by two jobs is asked once; the master CV's months close it", async () => {
    const other = { ...NOVAPAY, url: `${NOVAPAY.url}-2`, title: "Frontend Engineer", company: "Hubble" };
    const x = await harness([NOVAPAY, other]);
    expect((await x.post("/runs", scan)).statusCode).toBe(201);
    await x.t.idle();
    const requests = FactRequestsResponseSchema.parse((await x.get("/master-cv/fact-requests")).json()).requests.filter((r) => r.origin === "guidance");
    expect(requests).toEqual([expect.objectContaining({ id: "g-dates-month-year-grad-1-dates", field: "dates", factId: "grad-1", alsoJobIds: ["2"] })]);
    // Ba types the months himself in the fact editor (the API's master CV file): the request closes for every job.
    const master = truthfulMaster();
    for (const f of master.facts) f.dates = "Sep 2022 – Present";
    const put = await x.put("/master-cv", { ...master, version: 3 });
    expect(put.statusCode).toBe(200);
    const after = FactRequestsResponseSchema.parse((await x.get("/master-cv/fact-requests")).json()).requests.filter((r) => r.origin === "guidance");
    expect(after).toEqual([]);
  });

  it("SEC-17.AC-3: a refresh and a review that end with needs fact leave the master CV byte-identical", async () => {
    const x = await harness();
    const before = x.t.files.read(x.t.masterCv.path);
    expect((await x.post("/runs", scan)).statusCode).toBe(201);
    await x.t.idle();
    expect(x.t.files.read(x.t.masterCv.path)).toBe(before);
    expect([...x.t.files.files.keys()].filter((p) => p.includes("master-cv-history"))).toEqual([]);
  });
});

describe("GET /guidance, Turn off / Turn on, GET /activity", () => {
  it("lists every rule with its status, positions and sources; a disputed rule shows how each position fares", async () => {
    const x = await harness();
    const view = GuidanceViewSchema.parse((await x.get("/guidance")).json());
    expect(view.snapshot).toBe(1);
    expect(view.sourceCount).toBe(4);
    const length = view.rules.find((r) => r.ruleId === "length-pages")!;
    expect(length).toMatchObject({ status: "overridden", overriddenBy: ["over_one_page"] });
    expect(length.positions).toHaveLength(2);
    expect(view.rules.find((r) => r.ruleId === "contact-complete")).toMatchObject({ status: "turned_off", turnedOff: true });
    const dates = view.rules.find((r) => r.ruleId === "dates-month-year")!;
    expect(dates.positions[0]!.sources.map((s) => s.publisher ?? s.title)).toEqual(["VNPT (Tuyển dụng VNPT)", "ITviec"]);
    expect(dates.positions[0]!.sources[1]!.evidence).toMatch(/cả năm và tháng/);
  });

  it("§5.9: Turn off and Turn on are state changes (CSRF); an unknown rule is a 404; tailor stops getting a turned-off rule", async () => {
    const x = await harness();
    const refused = await x.request("POST", "/guidance/rules/order-most-relevant-first/off", undefined, { "x-bsja-csrf": "" });
    expect(refused.statusCode).toBe(403);
    const off = await x.post("/guidance/rules/order-most-relevant-first/off");
    expect(off.statusCode).toBe(200);
    expect(GuidanceViewSchema.parse(off.json()).rules.find((r) => r.ruleId === "order-most-relevant-first")!.status).toBe("turned_off");
    expect((await x.post("/guidance/rules/nope/off")).statusCode).toBe(404);
    expect((await x.post("/runs", scan)).statusCode).toBe(201);
    await x.t.idle();
    const guidance = (x.t.runner.callsFor("cv.tailor")[0]!.input as { guidance: { ruleId: string }[] }).guidance.map((g) => g.ruleId);
    expect(guidance).not.toContain("order-most-relevant-first");
    const on = await x.post("/guidance/rules/order-most-relevant-first/on");
    expect(GuidanceViewSchema.parse(on.json()).rules.find((r) => r.ruleId === "order-most-relevant-first")!.turnedOff).toBe(false);
  });

  it("REQ-36: the activity log lists the seed's rules as added, newest first, with their sources", async () => {
    const x = await harness();
    const { entries } = ActivityResponseSchema.parse((await x.get("/activity")).json());
    expect(entries).toHaveLength(12);
    expect(entries.every((e) => e.kind === "rule_added" && e.previousText === "" && e.applied)).toBe(true);
    expect(entries.find((e) => e.ruleId === "dates-month-year")!.sources.map((s) => s.id)).toEqual(["itviec-mau-cv-an-tuong", "vnpt-2026-10"]);
  });
});
