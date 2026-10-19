// CV auto-extend (§5.7–5.8): DerivedFactStore appends screened derived facts to data/master-cv.yaml
// as new versions (history kept), records the addition and learns implications; Undo restores the
// version before (or removes exactly the added facts when other changes came after), Keep
// re-anchors a flagged fact or makes it Ba's own, and Undo or Delete deny the skill for good.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CSRF_HEADER,
  DerivedFactsViewSchema,
  DerivedUndoResultSchema,
  MasterCvSchema,
  derivedStatus,
  factSourceHash,
  type DeriveCandidate,
  type Fact,
  type MasterCv,
} from "@bs-job-agents/shared";
import { masterCvFixture, researchFitFixture, researchScanFixture } from "@bs-job-agents/shared/fixtures";
import { parse, stringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { listEvents } from "../../db/index.js";
import { fake } from "../../engine/testing/fake-runner.js";
import { DerivedFactStore, readLearned } from "../derived-facts.js";
import { readApiState } from "../state.js";
import { createApiHarness, TEST_HOST, WEB_ORIGIN, type ApiHarness } from "../testing.js";

let h: ApiHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const fact = (id: string, text: string, over: Partial<Fact> = {}): Fact => ({ id, type: "experience", text, textVi: null, tags: [], org: "Gradion", dates: "2023-2025", ...over });
const f12 = fact("f-12", "Built CI pipelines in GitHub Actions for 6 services");
const f3 = fact("f-3", "Built the customer portal in React and Next.js");
const onDisk = (harness: ApiHarness): MasterCv => MasterCvSchema.parse(parse(readFileSync(join(harness.dataDir, "master-cv.yaml"), "utf8")));
const history = (harness: ApiHarness, v: number): MasterCv => MasterCvSchema.parse(parse(readFileSync(join(harness.dataDir, "master-cv-history", `v${v}.yaml`), "utf8")));

let scans = 0;
/** One job-scan whose (new) job lacks `gaps`. */
async function scanWith(harness: ApiHarness, gaps: string[]): Promise<void> {
  const n = ++scans;
  const job = { ...researchScanFixture.jobs[0]!, title: `Frontend Engineer ${n}`, url: `https://itviec.com/it-jobs/frontend-${n}` };
  harness.t.runner.script({ bot: "research", kind: "scan", result: fake.ok({ ...researchScanFixture, jobs: [job] }) });
  harness.t.runner.script({ bot: "research", kind: "fit", result: fake.ok({ ...researchFitFixture, fit: { ...researchFitFixture.fit, gaps } }) });
  harness.t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
  await harness.t.idle();
}

async function setup(facts: Fact[] = [f12, f3]): Promise<ApiHarness> {
  const harness = await createApiHarness();
  expect((await harness.put("/master-cv", { ...masterCvFixture, version: 1, facts })).statusCode).toBe(200);
  return harness;
}

describe("DerivedFactStore through a job-scan (REQ-14, REQ-15, REQ-18)", () => {
  it("REQ-15.AC-1 / REQ-18.AC-1: CI/CD rests on f-12 and keeps its org and dates; one new version, history kept, the addition listed", async () => {
    h = await setup();
    await scanWith(h, ["experience with CI/CD"]);
    const cv = onDisk(h);
    expect(cv.version).toBe(2);
    expect(cv.facts.at(-1)).toMatchObject({ id: "f-d1", text: "CI/CD", org: "Gradion", dates: "2023-2025", derived: { restsOn: [{ factId: "f-12", relation: "implied_from" }], via: "table" } });
    expect(history(h, 1).facts.map((f) => f.id)).toEqual(["f-12", "f-3"]);
    expect(history(h, 2)).toEqual(cv);
    const view = DerivedFactsViewSchema.parse((await h.get("/master-cv/derived")).json());
    expect(view.adds).toEqual([expect.objectContaining({ version: 2, previousVersion: 1, latest: true, jobId: "1", company: "NovaPay", taskId: null, facts: [{ id: "f-d1", text: "CI/CD" }] })]);
    expect(h.t.events("master_cv.updated").at(-1)).toMatchObject({ version: 2, change: "facts_derived", factIds: ["f-d1"], taskId: null });
  });

  it("REQ-18.AC-2 / REQ-26.AC-4: Undo on the latest version restores the content before exactly; the skill is denied and not derived on the next run", async () => {
    h = await setup();
    await scanWith(h, ["Redux"]);
    expect(onDisk(h).facts.map((f) => f.text)).toContain("Redux");
    const res = await h.post("/master-cv/derived/undo", { version: 2 });
    expect(res.statusCode, res.body).toBe(200);
    const undo = DerivedUndoResultSchema.parse(res.json());
    expect(undo).toMatchObject({ restoredTo: 1, removed: [{ id: "f-d1", text: "Redux" }] });
    const { version: _v3, ...content } = onDisk(h);
    const { version: _v1, ...before } = history(h, 1);
    expect(onDisk(h).version).toBe(3);
    expect(content).toEqual(before);
    expect(readLearned(h.dataDir).deny).toEqual([expect.objectContaining({ skill: "redux", restsOn: ["f-3"] })]);
    expect(DerivedFactsViewSchema.parse((await h.get("/master-cv/derived")).json()).adds).toEqual([]);
    expect(h.t.events("master_cv.updated").at(-1)).toMatchObject({ change: "derived_undo", factIds: ["f-d1"] });
    // A second undo of the same addition is refused.
    expect((await h.post("/master-cv/derived/undo", { version: 2 })).statusCode).toBe(409);
    // Anti-goal: the next run (a new job with the same gap) never adds it back, and asks no model.
    const derives = h.t.runner.callsFor("cv.derive").length;
    await scanWith(h, ["Redux"]);
    expect(h.t.tasks("cv.tailor").length).toBeGreaterThanOrEqual(2);
    expect(h.t.runner.callsFor("cv.derive").length).toBe(derives);
    expect(onDisk(h).version).toBe(3);
    expect(onDisk(h).facts.some((f) => f.text === "Redux")).toBe(false);
  });

  it("Undo after Ba saved again removes exactly the facts that addition added, and keeps his change", async () => {
    h = await setup();
    await scanWith(h, ["Redux"]);
    const v2 = onDisk(h);
    const edited = { ...v2, facts: v2.facts.map((f) => (f.id === "f-3" ? { ...f, textVi: "Xây dựng cổng khách hàng" } : f)) };
    expect((await h.put("/master-cv", edited)).statusCode).toBe(200);
    const undo = DerivedUndoResultSchema.parse((await h.post("/master-cv/derived/undo", { version: 2 })).json());
    expect(undo).toMatchObject({ restoredTo: null, removed: [{ id: "f-d1", text: "Redux" }] });
    expect(onDisk(h)).toMatchObject({ version: 4, facts: [f12, { ...f3, textVi: "Xây dựng cổng khách hàng" }] });
  });

  it("QA 7: Undo after a hand edit of the YAML that kept the version removes only the added facts; his edit stays", async () => {
    h = await setup();
    await scanWith(h, ["Redux"]);
    const v2 = onDisk(h);
    const edited = { ...v2, headlineOptions: [{ en: "Edited by hand", vi: null }] };
    writeFileSync(join(h.dataDir, "master-cv.yaml"), stringify(edited));
    const undo = DerivedUndoResultSchema.parse((await h.post("/master-cv/derived/undo", { version: 2 })).json());
    expect(undo).toMatchObject({ restoredTo: null, removed: [{ id: "f-d1", text: "Redux" }] });
    expect(onDisk(h)).toMatchObject({ version: 3, headlineOptions: [{ en: "Edited by hand", vi: null }], facts: [f12, f3] });
    // QA 6: the addition and its Undo are recorded as automatic versions (review cards ignore them).
    expect(readApiState(h.dataDir).derivedRevisions).toEqual([2, 3]);
  });

  it("deleting a derived fact on the screen (a save without it) denies its skill", async () => {
    h = await setup();
    await scanWith(h, ["Kubernetes"]);
    // No container fact: nothing to derive Kubernetes from (REQ-17.AC-1).
    expect(onDisk(h).version).toBe(1);
    await scanWith(h, ["Redux"]);
    const cv = onDisk(h);
    expect((await h.put("/master-cv", { ...cv, facts: cv.facts.filter((f) => !f.derived) })).statusCode).toBe(200);
    expect(readLearned(h.dataDir).deny.map((d) => d.skill)).toEqual(["redux"]);
  });
});

describe("staleness (SEC-17.AC-1): the sink re-reads and re-screens before it writes", () => {
  const redux: DeriveCandidate = { requirement: "Redux", type: "skill", text: "Redux", textVi: "Redux", tags: ["redux"], restsOn: [{ factId: "f-3", relation: "implied_from" }], fromTerms: ["React"], rationale: "x", via: "model" };
  const ctxOf = (harness: ApiHarness) => ({ conn: harness.t.db, now: new Date("2026-10-19T08:00:00Z"), runId: null, jobId: 99, task: null });

  it("Ba saved revision 15 first: his content stays intact; a draft that no longer holds is dropped with a reason, one that holds is appended to his revision", async () => {
    h = await setup();
    const store = new DerivedFactStore({ dataDir: h.dataDir });
    // Ba removed f-3 meanwhile: the draft cites a fact that is gone.
    const v1 = onDisk(h);
    expect((await h.put("/master-cv", { ...v1, facts: [f12] })).statusCode).toBe(200);
    const gone = store.add(ctxOf(h), [redux], { company: null, limit: 5, gaps: ["Redux"] });
    expect(gone).toMatchObject({ added: [], version: null, dropped: [{ reasons: ["cites f-3, which is not in your master CV"] }] });
    expect(onDisk(h)).toMatchObject({ version: 2, facts: [f12] });
    // Ba added Redux himself: the requirement is covered.
    expect((await h.put("/master-cv", { ...onDisk(h), facts: [f12, f3, fact("f-4", "Redux", { type: "skill" })] })).statusCode).toBe(200);
    expect(store.add(ctxOf(h), [redux], { company: null, limit: 5, gaps: ["Redux"] }).dropped[0]!.reasons).toEqual(["your facts already cover it"]);
    // Still valid: appended to his newest revision, never over it.
    expect((await h.put("/master-cv", { ...onDisk(h), facts: [f12, f3], headlineOptions: [{ en: "Ba's own headline", vi: null }] })).statusCode).toBe(200);
    const ok = store.add(ctxOf(h), [redux], { company: null, limit: 5, gaps: ["Redux"] });
    expect(ok.version).toBe(5);
    expect(onDisk(h)).toMatchObject({ version: 5, headlineOptions: [{ en: "Ba's own headline", vi: null }], facts: [f12, f3, { id: "f-d1", text: "Redux" }] });
  });

  it("a model-judged implication that passes is learned", async () => {
    h = await setup();
    const store = new DerivedFactStore({ dataDir: h.dataDir });
    store.add(ctxOf(h), [{ ...redux, requirement: "Zustand", text: "Zustand", textVi: "Zustand", tags: ["zustand"] }], { company: null, limit: 5, gaps: ["Zustand"] });
    expect(readLearned(h.dataDir).allow).toEqual([expect.objectContaining({ skill: "Zustand", impliedBy: "React", factId: "f-3" })]);
    expect(Object.values(readApiState(h.dataDir).derivedAdds)).toEqual([expect.objectContaining({ version: 2, facts: [{ id: "f-d1", text: "Zustand" }] })]);
  });
});

describe("Keep a flagged fact (REQ-20, §5.8)", () => {
  const derived = (sourceHash: string, restsOn = "f-12"): Fact => ({
    ...fact("f-31", "CI/CD", { type: "skill" }),
    derived: { restsOn: [{ factId: restsOn, relation: "supports", sourceHash }], via: "table", rationale: null, requirement: "CI/CD", jobId: "1", taskId: null, derivedAt: "2026-10-19T08:00:00Z" },
  });

  it("re-anchors to an edited source, so it is active again", async () => {
    const edited = { ...f12, text: "Built CI pipelines in GitHub Actions for 7 services" };
    h = await setup([edited, derived(factSourceHash(f12))]);
    expect(derivedStatus(onDisk(h), onDisk(h).facts[1]!)).toBe("source_changed");
    const res = await h.post("/master-cv/derived/f-31/keep", { version: 1 });
    expect(res.statusCode, res.body).toBe(200);
    const cv = onDisk(h);
    expect(cv.version).toBe(2);
    expect(cv.facts[1]!.derived?.restsOn[0]!.sourceHash).toBe(factSourceHash(edited));
    expect(derivedStatus(cv, cv.facts[1]!)).toBe("active");
    expect(h.t.events("master_cv.updated").at(-1)).toMatchObject({ change: "derived_keep", factIds: ["f-31"] });
  });

  it("makes it Ba's own when its source was deleted; refuses a stale version and Ba's own facts", async () => {
    h = await setup([f3, derived("x", "f-12")]);
    expect((await h.post("/master-cv/derived/f-31/keep", { version: 9 })).statusCode).toBe(409);
    expect((await h.post("/master-cv/derived/f-3/keep", { version: 1 })).statusCode).toBe(409);
    expect((await h.post("/master-cv/derived/nope/keep", { version: 1 })).statusCode).toBe(404);
    expect((await h.post("/master-cv/derived/f-31/keep", { version: 1 })).statusCode).toBe(200);
    expect(onDisk(h).facts[1]).toEqual({ id: "f-31", type: "skill", text: "CI/CD", textVi: null, tags: [], org: "Gradion", dates: "2023-2025" });
  });
});

describe("routes", () => {
  it("SEC-19.AC-1: undo and keep need the web Origin and the CSRF header", async () => {
    h = await setup();
    for (const url of ["/master-cv/derived/undo", "/master-cv/derived/f-3/keep"]) {
      const noOrigin = await h.app.inject({ method: "POST", url, headers: { host: TEST_HOST, [CSRF_HEADER]: "1", "content-type": "application/json" }, payload: JSON.stringify({ version: 1 }) });
      expect(noOrigin.statusCode, url).toBe(403);
      const noCsrf = await h.app.inject({ method: "POST", url, headers: { host: TEST_HOST, origin: WEB_ORIGIN, "content-type": "application/json" }, payload: JSON.stringify({ version: 1 }) });
      expect(noCsrf.statusCode, url).toBe(403);
    }
  });

  it("lists the latest run's rejected drafts with reasons and no contact data", async () => {
    h = await setup([f12]);
    const tenServices = { requirement: "CI/CD", type: "experience" as const, text: "CI/CD with GitHub Actions for 10 services", textVi: null, tags: [], restsOn: [{ factId: "f-12", relation: "supports" as const }], fromTerms: ["GitHub Actions"], rationale: "x" };
    h.t.runner.script({ bot: "cv", kind: "derive", result: fake.ok({ drafts: [tenServices], selfCheck: ["Cites only Ba's facts from the input", "fromTerms are copied from the cited facts", "No number, date, duration, title or employer the cited facts lack", "Nothing drafted for an unsupported gap"].map((item) => ({ item, passed: true, note: null })), memoryNotes: [] }) });
    await scanWith(h, ["payments domain knowledge"]);
    const view = DerivedFactsViewSchema.parse((await h.get("/master-cv/derived")).json());
    expect(view.rejected).toEqual([expect.objectContaining({ text: "CI/CD with GitHub Actions for 10 services", restsOn: ["f-12"], reasons: expect.arrayContaining(["says 10, which f-12 does not say"]) })]);
    expect(JSON.stringify(listEvents(h.t.db, { types: ["derive.rejected"] }))).not.toContain(masterCvFixture.contact.email);
  });

  it("Ba's real file format (data.example/master-cv.yaml) still parses, and prints his facts unchanged", () => {
    const text = readFileSync(join(__dirname, "../../../../../data.example/master-cv.yaml"), "utf8");
    const cv = MasterCvSchema.parse(parse(text));
    expect(cv.facts.length).toBeGreaterThan(0);
    expect(cv.facts.every((f) => !("derived" in f))).toBe(true);
  });
});
