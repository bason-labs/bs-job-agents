// CV guidance in the tailor gate (§5.7; AD-13, REQ-37 to REQ-39, SEC-25) on the whole engine: the
// truth check fails an attempt (not a round) before export and QA; the deterministic checkers run
// every round; cv.review only on QA-passed or handed rounds; a fixable miss asks for another round
// within 3; the handed round is the latest QA-passed one; QA's input is unchanged (NG8).
import { CV_REVIEW_SELF_CHECK, type CvOutput, type CvReviewOutput, type QaOutput, type TailoredCv } from "@bs-job-agents/shared";
import { cvOutputFixture, qaFailFixture, qaPassFixture, researchScanFixture } from "@bs-job-agents/shared/fixtures";
import { describe, expect, it } from "vitest";
import { getCvVersion, listCvVersions } from "../db/index.js";
import { getGuidanceReview } from "../db/repos/guidance-reviews.js";
import { markGuidanceDiscovery, setGuidanceRuleOff } from "../db/repos/guidance.js";
import type { RunnerTask } from "../runner/types.js";
import type { GateStepOutput } from "./state.js";
import { fake, fakeFrameName } from "./testing/fake-runner.js";
import { FakeGuidanceFetch, truthfulMaster, writeMaster } from "./testing/guidance.js";
import { createTestEngine } from "./testing/harness.js";

const NOVAPAY = researchScanFixture.jobs[0]!;
const SAO_VIET = researchScanFixture.jobs[1]!;
const pass = (item: string) => ({ item, passed: true, note: null });
const belowScores = { ...qaPassFixture.scores, jdMatch: { score: 22, justification: "Thin JD match." } };
const qaBelow: QaOutput = {
  ...qaPassFixture,
  total: belowScores.jdMatch.score + belowScores.companyTone.score + belowScores.formatAts.score + belowScores.clarity.score,
  scores: belowScores,
  hardFails: [],
  fixes: [{ section: "Summary", instruction: "Name the JD's stack." }],
};

async function setup(opts: { job?: typeof NOVAPAY } = {}) {
  const fetch = new FakeGuidanceFetch();
  const t = await createTestEngine({ guidance: { fetch } });
  writeMaster(t.files, t.masterCv, truthfulMaster());
  markGuidanceDiscovery(t.db, t.clock.now().toISOString());
  // The fake PDF text has no contact line; those checkers are unit-tested in shared.
  setGuidanceRuleOff(t.db, "contact-complete", true);
  setGuidanceRuleOff(t.db, "links-profile", true);
  t.runner.script({ bot: "research", kind: "scan", result: fake.ok({ ...researchScanFixture, jobs: [opts.job ?? NOVAPAY] }) });
  return t;
}

const run = (t: Awaited<ReturnType<typeof setup>>) => t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
const gate = (t: Awaited<ReturnType<typeof setup>>, runId: number, lang = "en") => t.step(runId, "tailor", `1:${lang}`)?.output as GateStepOutput;
const round = (n: number) => (task: RunnerTask) => (task.input as { round?: number }).round === n;

function cvWith(task: RunnerTask, tailored: TailoredCv): ReturnType<typeof fake.ok> {
  const input = task.input as { language?: string };
  const output: CvOutput = { ...cvOutputFixture, language: input.language === "vi" ? "vi" : "en", figmaFrameName: fakeFrameName(task.input as Parameters<typeof fakeFrameName>[0]), factRequests: [], tailored };
  return fake.ok(output);
}

const review = (items: CvReviewOutput["items"]) => (task: RunnerTask) => {
  const rules = (task.input as { rules: { ruleId: string }[] }).rules;
  const out: CvReviewOutput = {
    items: rules.map((r) => items.find((i) => i.ruleId === r.ruleId) ?? { ruleId: r.ruleId, status: "met", reason: "Met.", fixable: false, fix: null, needsFact: null }),
    selfCheck: CV_REVIEW_SELF_CHECK.map(pass),
    memoryNotes: [],
  };
  return fake.ok(out);
};

const notMetOrder: CvReviewOutput["items"][number] = {
  ruleId: "order-most-relevant-first",
  status: "not_met",
  reason: "The React work comes before the Java role the JD asks for.",
  fixable: true,
  fix: { instruction: "Put the grad-2 work before the grad-1 work.", factIds: ["grad-1", "grad-2"] },
  needsFact: null,
};

describe("the tailor gate with CV guidance (AD-13)", () => {
  it("tailor gets the applied positions as data; QA's input is unchanged (NG8); one cv.review on the QA-passed round; the result is stored", async () => {
    const t = await setup();
    const r = run(t);
    await t.idle();
    const tailor = t.runner.callsFor("cv.tailor")[0]!.input as { guidance?: { ruleId: string }[] };
    expect(tailor.guidance?.map((g) => g.ruleId)).toContain("dates-month-year");
    // Turned off and overridden rules are not sent.
    expect(tailor.guidance?.map((g) => g.ruleId)).not.toContain("contact-complete");
    expect(tailor.guidance?.map((g) => g.ruleId)).not.toContain("length-pages");
    const qa = t.runner.callsFor("qa.review")[0]!.input as Record<string, unknown>;
    expect(Object.keys(qa).sort()).toEqual(["company", "cvLanguage", "cvVersionId", "draft", "expectedLanguages", "job", "jobId", "masterCvVersion", "pdf", "pdfText"]);
    expect(JSON.stringify(qa)).not.toMatch(/guidance/i);
    const reviews = t.runner.callsFor("cv.review");
    expect(reviews).toHaveLength(1);
    // Only the applied judgement rules; deterministic ones are code's.
    expect((reviews[0]!.input as { rules: { ruleId: string }[] }).rules.map((x) => x.ruleId)).toEqual(["order-most-relevant-first", "bullet-what-tech-result", "skills-jd-relevant", "order-reverse-chronological", "ats-standard-headings", "ats-single-column", "consistent-formats"]);
    const out = gate(t, r.id);
    expect(out).toMatchObject({ outcome: "passed", rounds: [expect.objectContaining({ round: 1, passed: true })] });
    const stored = getGuidanceReview(t.db, out.cvVersionId!)!;
    expect(stored.result.reviewed).toBe(true);
    expect(stored.result.items.find((i) => i.ruleId === "length-pages")).toMatchObject({ status: "overridden" });
  });

  it("REQ-37.AC-2: years-only dates → needs fact: one request on the stored CV for the months; the CV keeps the years", async () => {
    const t = await setup();
    const r = run(t);
    await t.idle();
    const cv = getCvVersion(t.db, gate(t, r.id).cvVersionId!)!;
    const months = cv.factRequests.filter((q) => q.origin === "guidance");
    expect(months).toEqual([expect.objectContaining({ origin: "guidance", ruleId: "dates-month-year", factId: "grad-1", field: "dates", question: expect.stringMatching(/start and end months/) })]);
    expect((cv.tailored as TailoredCv).sections[0]!.items[0]!.subheading).toBe("2022 – present");
  });

  it("REQ-37.AC-5: a Vietnamese JD gets an EN and a VI CV, each with its own review result", async () => {
    const t = await setup({ job: SAO_VIET });
    const r = run(t);
    await t.idle();
    for (const lang of ["en", "vi"]) {
      const out = gate(t, r.id, lang);
      expect(out.outcome, lang).toBe("passed");
      expect(getGuidanceReview(t.db, out.cvVersionId!), lang).toBeDefined();
    }
    expect(t.runner.callsFor("cv.review")).toHaveLength(2);
  });

  it("REQ-38.AC-1: a QA-passed round with a fixable not_met rule gets a round 2 with the guidance fix; round 2 passes", async () => {
    const t = await setup();
    t.runner.script({ bot: "cv", kind: "review", times: 1, result: review([notMetOrder]) });
    const r = run(t);
    await t.idle();
    const tailors = t.runner.callsFor("cv.tailor");
    expect(tailors).toHaveLength(2);
    expect((tailors[1]!.input as { fixes: unknown[] }).fixes).toEqual([{ section: "CV guidance: The most relevant experience comes first", instruction: "Put the grad-2 work before the grad-1 work." }]);
    expect(gate(t, r.id)).toMatchObject({ outcome: "passed", rounds: [expect.objectContaining({ round: 1, passed: true }), expect.objectContaining({ round: 2, passed: true })] });
  });

  it("REQ-38.AC-2: a skill no experience fact mentions (Go) → not met, round 2 gets 'Remove Go', the revised CV without Go passes", async () => {
    const t = await setup();
    // Ba has a skill fact "Go", but no experience or project fact mentions it.
    const master = truthfulMaster();
    master.facts.push({ id: "skill-go", type: "skill", text: "Go", textVi: null, tags: [], org: null, dates: null });
    writeMaster(t.files, t.masterCv, master);
    const withGo: TailoredCv = structuredClone(cvOutputFixture.tailored);
    withGo.sections[1]!.items[0]!.bullets[0]!.text += ", Go";
    withGo.sections[1]!.items[0]!.bullets[0]!.factIds.push("skill-go");
    t.runner.script({ bot: "cv", kind: "tailor", when: round(1), result: (task) => cvWith(task, withGo) });
    const r = run(t);
    await t.idle();
    const round1 = getGuidanceReview(t.db, gate(t, r.id).rounds[0]!.cvVersionId!)!;
    expect(round1.result.items.find((i) => i.ruleId === "skills-practical-experience")).toMatchObject({ status: "not_met", fixable: true, by: "code" });
    const fixes = (t.runner.callsFor("cv.tailor")[1]!.input as { fixes: { instruction: string }[] }).fixes;
    expect(fixes.map((f) => f.instruction)).toEqual([expect.stringMatching(/^Remove Go from the skills section/)]);
    expect(gate(t, r.id)).toMatchObject({ outcome: "passed" });
    expect(gate(t, r.id).rounds).toHaveLength(2);
  });

  it("REQ-38.AC-3: still not met after round 3: the CV goes to review with the rule not met; never a round 4", async () => {
    const t = await setup();
    t.runner.script({ bot: "cv", kind: "review", result: review([notMetOrder]) });
    const r = run(t);
    await t.idle();
    expect(t.runner.callsFor("cv.tailor")).toHaveLength(3);
    const out = gate(t, r.id);
    expect(out.outcome).toBe("passed");
    expect(out.rounds.map((x) => x.round)).toEqual([1, 2, 3]);
    expect(out.cvVersionId).toBe(out.rounds[2]!.cvVersionId);
    expect(getGuidanceReview(t.db, out.cvVersionId!)!.result.items.find((i) => i.ruleId === "order-most-relevant-first")!.status).toBe("not_met");
    expect(t.review(r.id, 1)).toMatchObject({ qaPassed: true, escalated: false });
  });

  describe("live 2026-10-20: after round 3 the best QA-passed round goes to Ba, not the last", () => {
    /** QA passing with this total (the JD-match score carries the difference). */
    const qaWith = (total: number): QaOutput => {
      const others = qaPassFixture.scores.companyTone.score + qaPassFixture.scores.formatAts.score + qaPassFixture.scores.clarity.score;
      return { ...qaPassFixture, total, scores: { ...qaPassFixture.scores, jdMatch: { score: total - others, justification: "JD match." } }, hardFails: [], fixes: [] };
    };

    async function threeRounds(totals: number[], reviews: CvReviewOutput["items"][]) {
      const t = await setup();
      let qa = 0;
      t.runner.script({ bot: "qa", kind: "review", result: () => fake.ok(qaWith(totals[qa++]!)) });
      let rv = 0;
      t.runner.script({ bot: "cv", kind: "review", result: (task) => review(reviews[rv++] ?? reviews.at(-1)!)(task) });
      const r = run(t);
      await t.idle();
      return { t, r, out: gate(t, r.id) };
    }

    it("the same rule unmet every round, QA 80 → 86 → 84: round 2 (86) is handed over, and says so on the step and the review", async () => {
      const { t, r, out } = await threeRounds([80, 86, 84], [[notMetOrder]]);
      expect(out.rounds.map((x) => [x.round, x.total, x.passed])).toEqual([[1, 80, true], [2, 86, true], [3, 84, true]]);
      expect(out.handing).toMatchObject({ round: 2, outcome: "passed" });
      expect(out.cvVersionId).toBe(out.rounds[1]!.cvVersionId);
      expect(out.handNote).toBe("Round 2 shown (highest QA, 86).");
      const stepId = String(t.step(r.id, "tailor", "1:en")!.id);
      expect(t.events("step.finished").filter((e) => e.stepId === stepId).at(-1)!.preview).toContain("Round 2 shown (highest QA, 86)");
      expect(getGuidanceReview(t.db, out.cvVersionId!)!.result.note).toBe("Round 2 shown (highest QA, 86).");
      // The review card (and so Apply) gets that CV version.
      expect(t.review(r.id, 1)!.cvVersions.map((v) => v.cvVersionId)).toEqual([out.cvVersionId]);
    });

    it("fewest unmet CV guidance rules wins over a higher QA total", async () => {
      const second: CvReviewOutput["items"][number] = { ...notMetOrder, ruleId: "bullet-what-tech-result", fix: { instruction: "Add the result.", factIds: ["grad-1"] } };
      const { out } = await threeRounds([88, 82, 84], [[notMetOrder, second], [notMetOrder], [notMetOrder, second]]);
      expect(out.handing).toMatchObject({ round: 2 });
      expect(out.handNote).toMatch(/^Round 2 shown \(fewest CV guidance rules not met: \d+\)\.$/);
    });

    it("a tie on both goes to the latest round, with no note", async () => {
      const { out } = await threeRounds([84, 84, 84], [[notMetOrder]]);
      expect(out.handing).toMatchObject({ round: 3 });
      expect(out.handNote ?? null).toBeNull();
    });
  });

  it("REQ-39.AC-2: round 2 QA-passed, round 3 invented_claim: round 2's CV goes to review", async () => {
    const t = await setup();
    t.runner.script({ bot: "cv", kind: "review", result: review([notMetOrder]) });
    t.runner.script({ bot: "qa", kind: "review", when: () => listCvVersions(t.db, 1).length >= 3, result: fake.ok(qaFailFixture) });
    const r = run(t);
    await t.idle();
    const out = gate(t, r.id);
    expect(out.rounds.map((x) => x.passed)).toEqual([true, true, false]);
    expect(out.outcome).toBe("passed");
    expect(out.cvVersionId).toBe(out.rounds[1]!.cvVersionId);
  });

  it("cv.review is not created on a QA-failed round that is not handed over; the QA-passed round 2 gets it", async () => {
    const t = await setup();
    t.runner.script({ bot: "qa", kind: "review", times: 1, result: fake.ok(qaBelow) });
    const r = run(t);
    await t.idle();
    const out = gate(t, r.id);
    expect(out.rounds.map((x) => [x.round, x.passed, x.guidance?.reviewerTaskId === null])).toEqual([
      [1, false, true],
      [2, true, false],
    ]);
    expect(t.runner.callsFor("cv.review")).toHaveLength(1);
    // Round 1's QA fixes reached round 2 (deterministic guidance fixes would ride along).
    expect((t.runner.callsFor("cv.tailor")[1]!.input as { fixes: unknown[] }).fixes).toEqual(qaBelow.fixes);
  });

  it("three QA-failed rounds: the handed round (latest without invented_claim) is reviewed once, then escalated as today", async () => {
    const t = await setup();
    t.runner.script({ bot: "qa", kind: "review", result: fake.ok(qaBelow) });
    const r = run(t);
    await t.idle();
    const out = gate(t, r.id);
    expect(out.outcome).toBe("escalated");
    expect(out.rounds).toHaveLength(3);
    expect(t.runner.callsFor("cv.review")).toHaveLength(1);
    expect(getGuidanceReview(t.db, out.cvVersionId!)!.result.reviewed).toBe(true);
  });

  it("SEC-25: a CV stating a figure its facts lack fails the attempt before export and QA, without using a round", async () => {
    const t = await setup();
    const invented: TailoredCv = structuredClone(cvOutputFixture.tailored);
    invented.sections[0]!.items[0]!.bullets[1]!.text = "Owned a purchase order system and cut processing time by 30%.";
    t.runner.script({ bot: "cv", kind: "tailor", times: 1, result: (task) => cvWith(task, invented) });
    const exportsBefore = t.figma.exports.length;
    const r = run(t);
    await t.idle();
    const tailor = t.tasks("cv.tailor");
    expect(tailor).toHaveLength(1);
    expect(tailor[0]).toMatchObject({ status: "done", attempt: 2 });
    expect(t.runner.callsFor("cv.tailor")).toHaveLength(2);
    expect(t.figma.exports.length - exportsBefore).toBe(1);
    expect(t.runner.callsFor("qa.review")).toHaveLength(1);
    expect(gate(t, r.id).rounds).toHaveLength(1);
    const failed = t.events("task.finished").find((e) => e.status === "failed");
    expect(failed?.error).toMatch(/truth check failed before QA \(SEC-25\).*says 30/);
  });

  it("F1: a guidance-driven round 2 whose tailor fails out of attempts hands the QA-passed round 1 to Ba, saying why", async () => {
    const t = await setup();
    t.runner.script({ bot: "cv", kind: "review", times: 1, result: review([notMetOrder]) });
    t.runner.script({ bot: "cv", kind: "tailor", when: round(2), result: fake.failed("Figma went away") });
    const r = run(t);
    await t.idle();
    const out = gate(t, r.id);
    expect(t.step(r.id, "tailor", "1:en")?.status).toBe("done");
    expect(out.outcome).toBe("passed");
    expect(out.cvVersionId).toBe(out.rounds[0]!.cvVersionId);
    const stored = getGuidanceReview(t.db, out.cvVersionId!)!.result;
    expect(stored.note).toMatch(/^Round 2 could not be tailored \(cv\.tailor failed: .*Figma went away.*\); round 1, which passed QA, went to review instead\.$/);
    // Only round 1 produced a CV to check.
    expect(stored.rounds).toBe(1);
    expect(t.review(r.id, 1)).toMatchObject({ qaPassed: true });
  });

  it("F7: the stored review counts the rounds of its own pass only", async () => {
    const t = await setup();
    t.runner.script({ bot: "cv", kind: "review", times: 1, result: review([notMetOrder]) });
    const r = run(t);
    await t.idle();
    const out = gate(t, r.id);
    expect(getGuidanceReview(t.db, out.cvVersionId!)!.result.rounds).toBe(2);
    expect(getGuidanceReview(t.db, out.rounds[0]!.cvVersionId!)!.result.rounds ?? null).toBeNull();
  });

  it.each([
    ["a skill", (c: TailoredCv): void => void (c.sections[1]!.items[0]!.bullets[0]!.text += ", Kubernetes"), /names the skill Kubernetes/],
    ["a title", (c: TailoredCv): void => void (c.summary!.text = `Senior ${c.summary!.text}`), /names the title senior/],
    ["an employer", (c: TailoredCv): void => void (c.sections[0]!.items[0]!.bullets[1]!.text = "Owned a multi-country purchase order system for Google."), /names Google/],
  ] as const)("success item 4: a guidance fix that adds %s fails the attempt before export and QA, not a round", async (_what, edit, error) => {
    const t = await setup();
    const bad: TailoredCv = structuredClone(cvOutputFixture.tailored);
    edit(bad);
    t.runner.script({ bot: "cv", kind: "tailor", times: 1, result: (task) => cvWith(task, bad) });
    const r = run(t);
    await t.idle();
    expect(t.tasks("cv.tailor")[0]).toMatchObject({ status: "done", attempt: 2 });
    expect(t.runner.callsFor("qa.review")).toHaveLength(1);
    expect(gate(t, r.id).rounds).toHaveLength(1);
    expect(t.events("task.finished").find((e) => e.status === "failed")?.error).toMatch(error);
  });

  it("F4: a cv.review fix that would add a skill the facts lack is refused: no round 2, the rule stays not met", async () => {
    const t = await setup();
    t.runner.script({ bot: "cv", kind: "review", result: review([{ ...notMetOrder, fix: { instruction: "Add Kubernetes and AWS to the skills section.", factIds: ["grad-1"] } }]) });
    const r = run(t);
    await t.idle();
    expect(t.runner.callsFor("cv.tailor")).toHaveLength(1);
    const item = getGuidanceReview(t.db, gate(t, r.id).cvVersionId!)!.result.items.find((i) => i.ruleId === "order-most-relevant-first")!;
    expect(item).toMatchObject({ status: "not_met", fixable: false, fix: null });
    expect(item.reason).toMatch(/its fix was refused: the fix names Kubernetes/);
  });

  it("REQ-37: apply-to-link reviews its CV with the rule set in force, without a refresh", async () => {
    const t = await setup();
    const fetch = t.engine.deps.guidance!.fetch as FakeGuidanceFetch;
    const r = t.engine.startWorkflow({ workflow: "apply-to-link", params: { url: NOVAPAY.url!, applyAgain: false, searchProfileId: null } }, { trigger: "link" });
    await t.idle();
    expect(t.runner.callsFor("cv.review")).toHaveLength(1);
    expect(fetch.requests).toEqual([]);
    expect(getGuidanceReview(t.db, gate(t, r.id).cvVersionId!)).toBeDefined();
  });

  it("QA re-check 1: a title Ba wrote only in his headline options (VI too) is not an invented claim", async () => {
    const t = await setup();
    writeMaster(t.files, t.masterCv, truthfulMaster({ headlineOptions: [{ en: "Frontend Developer | React", vi: "Lập trình viên Frontend | React" }] }));
    const tailored: TailoredCv = structuredClone(cvOutputFixture.tailored);
    tailored.summary!.text = `Lập trình viên Frontend. ${tailored.summary!.text}`;
    tailored.sections[0]!.items[0]!.heading = "Frontend Developer · Gradion";
    t.runner.script({ bot: "cv", kind: "tailor", result: (task) => cvWith(task, tailored) });
    const r = run(t);
    await t.idle();
    expect(t.tasks("cv.tailor")[0]).toMatchObject({ status: "done", attempt: 1 });
    expect(gate(t, r.id).outcome).toBe("passed");
  });

  it("a failed cv.review never fails the CV: the round completes without its judgement", async () => {
    const t = await setup();
    t.runner.script({ bot: "cv", kind: "review", result: fake.failed("model unavailable") });
    const r = run(t);
    await t.idle();
    const out = gate(t, r.id);
    expect(out.outcome).toBe("passed");
    const stored = getGuidanceReview(t.db, out.cvVersionId!)!;
    expect(stored.result.items.find((i) => i.ruleId === "order-most-relevant-first")!.status).toBe("not_reviewed");
  });

  it("a review that leaves a rule out is invalid and retried", async () => {
    const t = await setup();
    t.runner.script({
      bot: "cv",
      kind: "review",
      times: 1,
      result: fake.ok({ items: [{ ruleId: "order-most-relevant-first", status: "met", reason: "ok", fixable: false, fix: null, needsFact: null }], selfCheck: CV_REVIEW_SELF_CHECK.map(pass), memoryNotes: [] }),
    });
    run(t);
    await t.idle();
    expect(t.tasks("cv.review")[0]).toMatchObject({ status: "done", attempt: 2 });
  });
});
