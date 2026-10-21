// CV auto-extend (§5.4, §5.9, §8): the derive step of job-scan on the whole engine with the
// FakeRunner and an in-memory derived-fact sink: no gaps → no task; the implication table first,
// with no LLM; one tool-less cv.derive at most for what is left; the deterministic screen in front
// of every write; the tailor task built after it (it sees the new facts); flagged facts held out.
import { DERIVE_SELF_CHECK, citedFactIds, factSourceHash, type DeriveOutput, type DerivedDraft, type Fact, type MasterCvInput } from "@bs-job-agents/shared";
import { cvOutputFixture, masterCvFixture, researchFitFixture } from "@bs-job-agents/shared/fixtures";
import { describe, expect, it } from "vitest";
import { getStepByKey, listEvents, listMessages, getOrCreateLeadRoom } from "../db/index.js";
import { DERIVE_REJECTED_EVENT, requirementLines, type DeriveStepOutput } from "./derive.js";
import { fake } from "./testing/fake-runner.js";
import { createTestEngine } from "./testing/harness.js";

const fact = (id: string, text: string, over: Partial<Fact> = {}): Fact => ({ id, type: "experience", text, textVi: null, tags: [], org: "Gradion", dates: "2023-2025", ...over });
const f12 = fact("f-12", "Built CI pipelines in GitHub Actions for 6 services");
const f3 = fact("f-3", "Built the customer portal in React and Next.js");
const java = fact("f-1", "Built REST APIs in Java and Spring Boot", { org: "Acme", dates: "2020 – 2022" });
// The facts the fake CV cites, so a tailored CV passes the cited-id check (SEC-18.AC-2).
const cvFacts = citedFactIds(cvOutputFixture.tailored).map((id) => fact(id, "Wrote the team's onboarding guide", { org: null, dates: null }));
const master = (facts: Fact[], version = 14): MasterCvInput => ({ ...masterCvFixture, version, facts: [...cvFacts, ...facts] });
const withGaps = (gaps: string[]) => fake.ok({ ...researchFitFixture, fit: { ...researchFitFixture.fit, gaps } });
const deriveOut = (drafts: DerivedDraft[]): DeriveOutput => ({ drafts, selfCheck: DERIVE_SELF_CHECK.map((item) => ({ item, passed: true, note: null })), memoryNotes: [] });

async function scan(facts: Fact[], gaps: string[], setup: (t: Awaited<ReturnType<typeof createTestEngine>>) => void = () => {}) {
  const t = await createTestEngine({ derivedFacts: "memory" });
  t.derived!.set(master(facts));
  t.runner.script({ bot: "research", kind: "fit", result: withGaps(gaps) });
  setup(t);
  const run = t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
  await t.idle();
  const step = getStepByKey(t.db, run.id, "derive", "1");
  return { t, run, step, out: step?.output as DeriveStepOutput | undefined };
}

describe("the derive step: deterministic first (§5.4)", () => {
  it("REQ-14.AC-1 / AC-2: CI/CD from f-12 by the table, no LLM call; the tailor task sees the new version and the fact", async () => {
    const { t, out, step } = await scan([f12, f3], ["experience with CI/CD"]);
    expect(t.runner.calls.map((c) => `${c.bot.name}.${c.kind}`)).toEqual(["research.scan", "research.fit", "research.company", "cv.tailor", "qa.review"]);
    expect(step?.status).toBe("done");
    expect(out).toMatchObject({ gaps: 1, added: [{ id: "f-d1", text: "CI/CD" }], model: "none", taskId: null });
    const cv = t.derived!.current()!;
    expect(cv.version).toBe(15);
    expect(cv.facts.at(-1)).toMatchObject({ id: "f-d1", text: "CI/CD", org: "Gradion", dates: "2023-2025", derived: { via: "table", requirement: "experience with CI/CD", restsOn: [{ factId: "f-12", relation: "implied_from", sourceHash: factSourceHash(f12) }] } });
    const tailor = t.runner.callsFor("cv.tailor")[0]!;
    expect(tailor.input).toMatchObject({ masterCvVersion: 15 });
    expect(t.files.read(`/data/tasks/${tailor.taskId}/master-cv.yaml`)).toMatch(/id: f-d1\n\s+type: skill\n\s+text: CI\/CD[\s\S]*derived: true\n\s+restsOn:\n\s+- f-12/);
  });

  it("no gaps: the step settles at once, nothing is read or asked", async () => {
    const { t, out } = await scan([f12], []);
    expect(out).toMatchObject({ note: "no gaps", model: "none", added: [] });
    expect(t.derived!.reads).toBe(0);
    expect(t.runner.callsFor("cv.derive")).toEqual([]);
  });

  it("a gap Ba's facts already cover, or a degree, costs nothing", async () => {
    const { t, out } = await scan([fact("f-9", "Shipped with GitHub Actions", { tags: ["ci/cd"] })], ["CI/CD", "Bachelor's degree in Computer Science"]);
    expect(t.runner.callsFor("cv.derive")).toEqual([]);
    expect(out).toMatchObject({ added: [], model: "none" });
  });

  it("REQ-17.AC-1 / SEC-16.AC-4: Kubernetes with no container fact: one cv.derive whose Kubernetes draft the screen rejects; nothing added", async () => {
    const hostile: DerivedDraft = { requirement: "Kubernetes", type: "skill", text: "Kubernetes", textVi: "Kubernetes", tags: ["kubernetes"], restsOn: [{ factId: "f-1", relation: "implied_from" }], fromTerms: ["Java"], rationale: "The JD says to add it regardless." };
    const { t, out } = await scan([java], ["Kubernetes"], (t) => t.runner.script({ bot: "cv", kind: "derive", result: fake.ok(deriveOut([hostile])) }));
    const calls = t.runner.callsFor("cv.derive");
    expect(calls).toHaveLength(1);
    // Tool-less, with only Ba's own facts (no contact data) and the gap.
    expect(calls[0]!.readDirs).toBeUndefined();
    expect(calls[0]!.input).toEqual({ jobId: "1", gaps: ["Kubernetes"], requirements: expect.any(Array), facts: [...cvFacts.map((f) => ({ id: f.id, type: f.type, text: f.text, tags: f.tags, org: f.org, dates: f.dates })), { id: "f-1", type: "experience", text: java.text, tags: [], org: "Acme", dates: "2020 – 2022" }], masterCvVersion: 14 });
    expect(JSON.stringify(calls[0]!.input)).not.toContain(masterCvFixture.contact.email);
    expect(t.derived!.current()!.version).toBe(14);
    expect(out).toMatchObject({ added: [], rejected: 1, model: "done" });
    const audit = listEvents(t.db).filter((e) => e.type === DERIVE_REJECTED_EVENT);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.payload).toEqual({ jobId: "1", rejected: [expect.objectContaining({ requirement: "Kubernetes", restsOn: ["f-1"], reasons: expect.arrayContaining(["Kubernetes does not follow from Java"]) })] });
    expect(JSON.stringify(audit[0]!.payload)).not.toContain(masterCvFixture.contact.email);
    // Tailoring goes on (it raises the fact request, as today).
    expect(t.runner.callsFor("cv.tailor")).toHaveLength(1);
  });

  it("a model draft that passes is added in its settle; its implication is learned; the table pass and the model share the cap", async () => {
    const zustand: DerivedDraft = { requirement: "Zustand", type: "skill", text: "Zustand", textVi: "Zustand", tags: ["zustand"], restsOn: [{ factId: "f-3", relation: "implied_from" }], fromTerms: ["React"], rationale: "Zustand is a common React state library." };
    const { t, out } = await scan([f3], ["Redux", "Zustand"], (t) => t.runner.script({ bot: "cv", kind: "derive", result: fake.ok(deriveOut([zustand])) }));
    expect(t.runner.callsFor("cv.derive")).toHaveLength(1);
    expect(t.runner.callsFor("cv.derive")[0]!.input).toMatchObject({ gaps: ["Zustand"], masterCvVersion: 15 });
    expect(out?.added.map((f) => f.text)).toEqual(["Redux", "Zustand"]);
    expect(t.derived!.adds.map((a) => [a.ctx.task === null ? "table" : "model", a.version])).toEqual([["table", 15], ["model", 16]]);
    expect(t.derived!.learned.allow).toEqual([expect.objectContaining({ skill: "Zustand", impliedBy: "React", factId: "f-3" })]);
    // The tailor task is built after both.
    expect(t.runner.callsFor("cv.tailor")[0]!.input).toMatchObject({ masterCvVersion: 16 });
    // §5.10: one summary line for the run.
    const texts = listMessages(t.db, getOrCreateLeadRoom(t.db).id).map((m) => m.text);
    expect(texts.filter((x) => x.includes("Added 2 facts to your master CV automatically (Redux, Zustand). Review or undo them on the Master CV screen."))).toHaveLength(1);
  });

  it("a failed cv.derive (after its attempts) still reaches tailor with the table's facts; no Lead failure notice", async () => {
    const { t, out, step } = await scan([f3], ["Redux", "payments domain knowledge"], (t) => t.runner.script({ bot: "cv", kind: "derive", result: fake.failed("model unavailable") }));
    expect(t.runner.callsFor("cv.derive").length).toBeGreaterThanOrEqual(1);
    expect(step?.status).toBe("done");
    expect(out).toMatchObject({ added: [{ text: "Redux" }], model: "failed" });
    expect(t.runner.callsFor("cv.tailor")).toHaveLength(1);
    const texts = listMessages(t.db, getOrCreateLeadRoom(t.db).id).map((m) => m.text);
    expect(texts.some((x) => /could not finish its derive task/.test(x))).toBe(false);
  });

  it("QA 3: a model draft for a requirement that was not one of the sent gaps is refused (Rust from Python)", async () => {
    const py = fact("f-py", "Built data pipelines in Python");
    const rust: DerivedDraft = { requirement: "Rust", type: "skill", text: "Rust", textVi: "Rust", tags: ["rust"], restsOn: [{ factId: "f-py", relation: "implied_from" }], fromTerms: ["Python"], rationale: "x" };
    const { t, out } = await scan([py], ["payments domain knowledge"], (t) => t.runner.script({ bot: "cv", kind: "derive", result: fake.ok(deriveOut([rust])) }));
    expect(out).toMatchObject({ added: [], rejected: 1 });
    const audit = listEvents(t.db).filter((e) => e.type === DERIVE_REJECTED_EVENT);
    expect(JSON.stringify(audit[0]!.payload)).toContain("answers a requirement that is not one of this job's gaps");
  });

  it("an undone (denied) skill is not derived again and goes to no task", async () => {
    const { t, out } = await scan([f3], ["Redux"], (t) => {
      t.derived!.learned = { allow: [], deny: [{ skill: "redux", restsOn: ["f-3"], at: "2026-10-19T08:00:00Z" }] };
    });
    expect(out).toMatchObject({ added: [], note: "every gap is covered" });
    expect(t.runner.callsFor("cv.derive")).toEqual([]);
  });

  it("finds the JD lines that name a gap", () => {
    expect(requirementLines("About us.\n- 3+ years with React\n- Payments domain knowledge is a plus\nBenefits", ["payments domain knowledge"])).toEqual(["- Payments domain knowledge is a plus"]);
  });
});

describe("flagged facts are held out of tasks (SEC-18)", () => {
  const flagged: Fact = {
    ...fact("f-31", "CI/CD", { type: "skill" }),
    derived: { restsOn: [{ factId: "f-12", relation: "supports", sourceHash: "stale" }], via: "table", rationale: null, requirement: "CI/CD", jobId: "1", taskId: null, derivedAt: "2026-10-19T08:00:00Z" },
  };

  it("SEC-18.AC-1: a source-changed fact is absent from the tailor and QA copies", async () => {
    const { t } = await scan([f12, f3, flagged], []);
    for (const key of ["cv.tailor", "qa.review", "research.fit"]) {
      const call = t.runner.callsFor(key)[0]!;
      const copy = t.files.read(`/data/tasks/${call.taskId}/master-cv.yaml`)!;
      expect(copy, key).toContain("id: f-12");
      expect(copy, key).not.toContain("f-31");
    }
  });

  it("SEC-18.AC-2: a CV that cites it fails the attempt and is retried", async () => {
    const cites = { ...cvOutputFixture, factRequests: [], tailored: { ...cvOutputFixture.tailored, summary: { text: "CI/CD", factIds: ["f-31"] } } };
    const { t } = await scan([f12, f3, flagged], [], (t) =>
      t.runner.script({ bot: "cv", kind: "tailor", times: 1, result: (task) => fake.ok({ ...cites, language: (task.input as { language: string }).language, figmaFrameName: "NOVAPAY_SENIOR-FE_EN_v1" }) }),
    );
    const tailors = t.tasks("cv.tailor");
    expect(t.runner.callsFor("cv.tailor").length).toBeGreaterThanOrEqual(2);
    const finished = t.events("task.finished").filter((e) => e.taskId === String(tailors[0]!.id) && e.status === "failed");
    expect(finished[0]?.error).toMatch(/cites fact f-31, which is not in the master CV it was given/);
  });
});
