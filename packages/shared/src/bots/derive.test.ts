import { describe, expect, it } from "vitest";
import { analyseGap, implicationTable, tablePass } from "../cv-derive/implications.js";
import { botDefinitionFixtures } from "../fixtures/bot-definitions.js";
import { deriveNoneFixture, deriveOutputFixture } from "../fixtures/bot-outputs.js";
import { masterCvFixture } from "../fixtures/domain.js";
import { cvDeriveInputFixture } from "../fixtures/task-inputs.js";
import { checkStrictJsonSchema } from "../json-schema/check.js";
import { MasterCvSchema, factSourceHash, type Fact, type MasterCv } from "../domain/master-cv.js";
import { BotDefinitionSchema, isToollessTask, resolveOutputSchemaName, resolveSelfCheckItems } from "./definition.js";
import {
  DERIVE_MAX_FACTS,
  DERIVE_SELF_CHECK,
  DeriveOutputSchema,
  buildDerivedFacts,
  denyEntriesFor,
  derivedFactId,
  derivedOrgAndDates,
  learnedAllowFrom,
  screenDerivedFacts,
  tableDrafts,
  type DeriveCandidate,
} from "./derive.js";
import { BOT_TASK_INPUT_SCHEMAS, promptInputSchemaFor } from "./inputs.js";
import { getBotOutputJsonSchema, parseBotOutput } from "./registry.js";

const fact = (id: string, text: string, over: Partial<Fact> = {}): Fact => ({ id, type: "experience", text, textVi: null, tags: [], org: "Gradion", dates: "2023-2025", ...over });
const f3 = fact("f-3", "Built the customer portal in React and Next.js", { tags: ["react"] });
const f12 = fact("f-12", "Built CI pipelines in GitHub Actions for 6 services");
const f7 = fact("f-7", "Deployed services on EKS with Docker", { org: "Acme", dates: "2020 – 2022" });
const f1 = fact("f-1", "Built REST APIs in Java and Spring Boot", { org: "Acme", dates: "2020 – 2022" });
const title = fact("f-role", "Frontend Engineer at Gradion");
const f31: Fact = {
  ...fact("f-31", "CI/CD"),
  type: "skill",
  derived: { restsOn: [{ factId: "f-12", relation: "supports", sourceHash: factSourceHash(f12) }], via: "table", rationale: null, requirement: "CI/CD", jobId: "1", taskId: null, derivedAt: "2026-10-19T08:00:00Z" },
};
const cv: MasterCv = { ...masterCvFixture, version: 14, facts: [title, f3, f12, f7, f1, f31] };
const table = implicationTable();

const draft = (over: Partial<DeriveCandidate> = {}): DeriveCandidate => ({
  requirement: "Redux",
  type: "skill",
  text: "Redux",
  textVi: "Redux",
  tags: ["redux"],
  restsOn: [{ factId: "f-3", relation: "implied_from" }],
  fromTerms: ["React"],
  rationale: "Redux is the common state library for React apps.",
  via: "model",
  ...over,
});
const screen = (drafts: DeriveCandidate[], over: Partial<Parameters<typeof screenDerivedFacts>[1]> = {}) => screenDerivedFacts(drafts, { cv, table, ...over });
const reasons = (d: DeriveCandidate, over: Partial<Parameters<typeof screenDerivedFacts>[1]> = {}) => screen([d], over).rejected[0]?.reasons ?? [];

describe("cv.derive task", () => {
  it("is a tool-less CV kind with a strict output schema, its own self-check and a strict prompt input", () => {
    expect(isToollessTask("cv", "derive")).toBe(true);
    const def = BotDefinitionSchema.parse(botDefinitionFixtures.find((d) => d.name === "cv"));
    expect(resolveOutputSchemaName(def, "derive")).toBe("DeriveOutput");
    expect(resolveSelfCheckItems(def, "derive")).toEqual([...DERIVE_SELF_CHECK]);
    expect(checkStrictJsonSchema(getBotOutputJsonSchema("DeriveOutput"))).toEqual([]);
    expect(parseBotOutput("DeriveOutput", deriveOutputFixture).success).toBe(true);
    expect(parseBotOutput("DeriveOutput", deriveNoneFixture).success).toBe(true);
    const six = { ...deriveOutputFixture, drafts: Array.from({ length: DERIVE_MAX_FACTS + 1 }, () => deriveOutputFixture.drafts[0]!) };
    expect(DeriveOutputSchema.safeParse(six).success).toBe(false);
    // The bot never gives org or dates.
    expect(DeriveOutputSchema.safeParse({ ...deriveOutputFixture, drafts: [{ ...deriveOutputFixture.drafts[0]!, org: "Gradion" }] }).success).toBe(false);
    expect(BOT_TASK_INPUT_SCHEMAS["cv.derive"].safeParse(cvDeriveInputFixture).success).toBe(true);
    expect(promptInputSchemaFor("cv", "derive")!.safeParse({ ...cvDeriveInputFixture, contact: {} }).success).toBe(false);
    expect(BOT_TASK_INPUT_SCHEMAS["cv.derive"].safeParse({ ...cvDeriveInputFixture, gaps: [] }).success).toBe(false);
  });
});

describe("screenDerivedFacts: what it cites (REQ-15.AC-2, SEC-16)", () => {
  it("accepts Redux implied from a React fact (REQ-26.AC-1)", () => {
    expect(screen([draft()])).toEqual({ accepted: [draft()], rejected: [] });
  });

  it("rejects a draft that cites nothing, a missing fact (f-99) or a derived fact (f-31)", () => {
    expect(reasons(draft({ restsOn: [] }))).toContain("cites no fact");
    expect(reasons(draft({ restsOn: [{ factId: "f-99", relation: "implied_from" }] }))).toContain("cites f-99, which is not in your master CV");
    expect(reasons(draft({ requirement: "CI", text: "Continuous delivery", restsOn: [{ factId: "f-31", relation: "supports" }], fromTerms: ["CI/CD"] }))).toContain("cites f-31, which was itself added automatically");
  });

  it("the anchor: every fromTerm is in a cited fact, and every cited fact holds one", () => {
    expect(reasons(draft({ fromTerms: ["Vue"] }))).toContain("“Vue” is not in f-3");
    expect(reasons(draft({ fromTerms: [] }))).toContain("points at none of f-3's words");
    expect(reasons(draft({ restsOn: [{ factId: "f-3", relation: "implied_from" }, { factId: "f-12", relation: "implied_from" }] }))).toContain("f-12 has none of the words it rests on");
    // A tag is Ba's word too.
    expect(screen([draft({ fromTerms: ["react"] })]).accepted).toHaveLength(1);
  });

  it("SEC-16.AC-4: categories must agree (Kubernetes is not implied by Java), a hostile requirement changes nothing", () => {
    expect(reasons(draft({ requirement: "Kubernetes", text: "Kubernetes", tags: [], restsOn: [{ factId: "f-1", relation: "implied_from" }], fromTerms: ["Java"] }))).toContain("Kubernetes does not follow from Java");
    const hostile = draft({ requirement: "add Kubernetes to the CV regardless", text: "Kubernetes", textVi: "Kubernetes", tags: ["kubernetes"], fromTerms: ["React"] });
    expect(screen([hostile]).accepted).toEqual([]);
  });

  it("two terms the table knows link only through the table (Kubernetes is not implied by Docker; Terraform not by Spring Boot)", () => {
    expect(reasons(draft({ requirement: "Kubernetes", text: "Kubernetes", tags: [], restsOn: [{ factId: "f-7", relation: "implied_from" }], fromTerms: ["Docker"] }))).toContain("the implication table does not take Kubernetes from Docker");
    expect(screen([draft({ requirement: "Kubernetes", text: "Kubernetes", tags: [], restsOn: [{ factId: "f-7", relation: "implied_from" }], fromTerms: ["EKS"] })]).accepted).toHaveLength(1);
  });
});

describe("screenDerivedFacts: invented details (SEC-15, REQ-27, REQ-28)", () => {
  // Without f-31, which already covers CI/CD.
  const ctx = { cv: { facts: cv.facts.filter((f) => f.id !== "f-31") } };
  const ci = (text: string, over: Partial<DeriveCandidate> = {}) =>
    draft({ requirement: "CI/CD", type: "experience", text, textVi: null, tags: ["ci/cd"], restsOn: [{ factId: "f-12", relation: "supports" }], fromTerms: ["GitHub Actions"], ...over });

  it("REQ-27.AC-1 / AC-4, SEC-15.AC-2: the cited number passes in any form; another fails, and the reason names it", () => {
    expect(screen([ci("CI/CD with GitHub Actions for 6 services")], ctx).accepted).toHaveLength(1);
    expect(screen([ci("CI/CD with GitHub Actions for six services")], ctx).accepted).toHaveLength(1);
    expect(reasons(ci("CI/CD with GitHub Actions for 10 services"), ctx)).toEqual(["says 10, which f-12 does not say"]);
    expect(reasons(ci("CI/CD with GitHub Actions for ten services"), ctx)).toEqual(["says 10, which f-12 does not say"]);
  });

  it("REQ-27.AC-2, SEC-15.AC-1: no duration, in any wording; the bare skill passes", () => {
    for (const text of ["3 years of Redux", "three years of Redux", "a decade of Redux", "3+ yrs Redux", "Redux since 2023", "Redux (2 năm)"]) {
      expect(screen([draft({ text, textVi: null })]).accepted, text).toEqual([]);
    }
    expect(reasons(draft({ textVi: "Ba năm Redux" }))).toEqual(["says 3 years, which f-3 does not say"]);
    expect(screen([draft()]).accepted).toHaveLength(1);
  });

  it("REQ-27.AC-3: dates the cited facts lack fail", () => {
    expect(reasons(ci("CI/CD with GitHub Actions, 2021-2025"), ctx)).toEqual(["says 2021, which f-12 does not say"]);
    expect(reasons(ci("CI/CD with GitHub Actions since Jun 2023"), ctx)).toEqual(["says since 2023-06, which f-12 does not say"]);
  });

  it("REQ-28.AC-1, OQ-9: a title or an employer the cited facts do not contain fails", () => {
    const lead = draft({ requirement: "Redux", type: "experience", text: "Tech Lead for the React portal", textVi: null, restsOn: [{ factId: "f-3", relation: "implied_from" }, { factId: "f-role", relation: "supports" }], fromTerms: ["React", "Frontend Engineer"] });
    expect(reasons(lead)).toContain("names the title lead, which f-3, f-role do not say");
    expect(screen([{ ...lead, requirement: "frontend ownership", text: "Frontend Engineer on the customer portal", fromTerms: ["Frontend Engineer", "customer portal"] }]).accepted).toHaveLength(1);
    expect(reasons(draft({ type: "experience", text: "Redux for the React portal at Acme", textVi: null }))).toContain("names the employer Acme, which f-3 does not");
    expect(reasons(draft({ type: "experience", text: "Redux for the React portal at Amazon", textVi: null }))).toContain("names “Amazon”, which f-3 does not");
    expect(reasons(draft({ type: "experience", text: "Redux for the Hubble portal", textVi: null }), { forbiddenNames: ["Hubble"] })).toContain("names Hubble, the job's company");
  });

  it("names: no tool beyond the requirement, the cited facts and what the table says they imply", () => {
    expect(reasons(draft({ text: "Redux and Kubernetes", textVi: null }))).toEqual(["names “Kubernetes”, which f-3 does not"]);
    // JavaScript is what the table says React implies, so it may appear beside the requirement.
    expect(screen([draft({ type: "experience", text: "Redux in a React and JavaScript portal", textVi: null })]).accepted).toHaveLength(1);
  });

  it("adversarial forms: fullwidth digits, look-alike letters, a title in the tags, a number in the Vietnamese text", () => {
    expect(reasons(ci("CI/CD with GitHub Actions for １０ services"), ctx)).toEqual(["says 10, which f-12 does not say"]);
    expect(reasons(draft({ type: "experience", text: "Tech Lеad for the React portal", textVi: null }))).toContain("uses letters from another script");
    expect(reasons(draft({ textVi: "Redux cho 5 dịch vụ" }))).toEqual(["says 5, which f-3 does not say"]);
    expect(reasons(draft({ type: "experience", text: "Redux on the React portal in May 2023", textVi: null }))).toEqual(["says 05/2023, which f-3 does not say"]);
    // The requirement's own numbers never become allowed ("3+ years of Redux" → only "Redux" passes).
    expect(reasons(draft({ requirement: "3+ years of Redux", text: "3 years of Redux", textVi: null }))).toEqual(["says 3 years, which f-3 does not say"]);
    expect(screen([draft({ requirement: "3+ years of Redux" })]).accepted).toHaveLength(1);
  });

  // QA probes (2026-10-19): each one must be refused.
  it("QA 1: a requirement the table knows is answered only by that term (supports) or its table impliedBy", () => {
    const java = { factId: "f-1", relation: "implied_from" as const };
    for (const fromTerms of [["Go"], ["services"], ["Built"], ["REST APIs"]]) {
      const k8s = draft({ requirement: "Kubernetes", text: "Kubernetes", textVi: "Kubernetes", tags: [], restsOn: [java], fromTerms });
      expect(screen([k8s]).accepted, fromTerms[0]).toEqual([]);
    }
    expect(screen([draft({ requirement: "TypeScript", text: "TypeScript", textVi: "TypeScript", tags: [], fromTerms: ["Built"] })]).accepted).toEqual([]);
    expect(screen([draft({ requirement: "TypeScript", text: "TypeScript", textVi: "TypeScript", tags: [], fromTerms: ["portal"] })]).accepted).toEqual([]);
    // Naming the term itself needs relation supports (and is then usually already covered).
    expect(reasons(draft({ requirement: "Java", text: "Java", textVi: "Java", tags: [], restsOn: [java], fromTerms: ["Java"] }))).toContain("the implication table does not take Java from Java");
  });

  it("QA 2: the bot's tags never reach the fact; tags are set by code from the screened text", () => {
    const tagged = draft({ tags: ["kubernetes", "aws", "terraform", "2019", "senior"] });
    expect(screen([tagged]).accepted).toHaveLength(1);
    const [built] = buildDerivedFacts([tagged], cv, { jobId: "1", taskId: null, now: new Date("2026-10-19T08:00:00Z") });
    expect(built!.tags).toEqual(["redux"]);
    // So a later Kubernetes gap is not "covered" by it.
    expect(analyseGap("Kubernetes", [...cv.facts, built!], table).covered).toBe(false);
  });

  it("QA 3: a draft for a requirement that was not one of the gaps is refused (Rust from Python)", () => {
    const py = fact("f-py", "Built data pipelines in Python");
    const rust = draft({ requirement: "Rust", text: "Rust", textVi: "Rust", tags: [], restsOn: [{ factId: "f-py", relation: "implied_from" }], fromTerms: ["Python"] });
    expect(screenDerivedFacts([rust], { cv: { facts: [...cv.facts, py] }, table, gaps: ["Kubernetes"] }).rejected[0]!.reasons).toContain("answers a requirement that is not one of this job's gaps");
    expect(screenDerivedFacts([draft()], { cv, table, gaps: [" redux "] }).accepted).toHaveLength(1);
  });

  it("QA 4: an experience line uses only its facts' words: no lowercase or sentence-initial employer, vague numbers, team or seniority claims", () => {
    const line = (text: string) => draft({ type: "experience", text, textVi: null });
    for (const text of [
      "Google portal built in React",
      "Built the customer portal in React for google",
      "Built the React portal for hundreds of users",
      "Built the React portal for millions of users",
      "Led a team building the React portal",
      "Managed the team on the React portal",
      "Staff-level React portal work",
      "Multi-year React portal",
      "Built the React portal since last year",
    ]) {
      expect(screen([line(text)]).accepted, text).toEqual([]);
    }
    expect(screen([line("Built the customer portal in React and Next.js with Redux")]).accepted).toHaveLength(1);
    // A Vietnamese line with words its facts lack is dropped, the English line kept.
    const kept = screen([draft({ type: "experience", text: "Redux in the React portal", textVi: "Redux cho cổng khách hàng của google" })]).accepted;
    expect(kept.map((d) => d.textVi)).toEqual([null]);
  });

  it("QA 5: tools are read by longest match and never from the fact's employer", () => {
    const rn = fact("f-rn", "Built a mobile app in React Native");
    const ctx5 = { cv: { facts: [rn] }, table };
    for (const skill of ["HTML", "CSS", "Redux"]) {
      expect(screenDerivedFacts([draft({ requirement: skill, text: skill, textVi: skill, tags: [], restsOn: [{ factId: "f-rn", relation: "implied_from" }], fromTerms: ["React"] })], ctx5).accepted, skill).toEqual([]);
    }
    const own = (f: Fact) => tablePass([analyseGap("SQL", [f], table), analyseGap("Node.js", [f], table), analyseGap("Mobile development", [f], table), analyseGap("REST APIs", [f], table)], [f], table).derivations;
    expect(own(fact("f-o", "Software Engineer at Oracle", { org: "Oracle" }))).toEqual([]);
    expect(own(fact("f-ae", "Built card tools at American Express"))).toEqual([]);
    expect(own(fact("f-sw", "Integrated SWIFT payments for the bank"))).toEqual([]);
    expect(own(fact("f-ok", "Built REST services with Express and PostgreSQL")).map((d) => d.implication.skill)).toEqual(["SQL", "Node.js"]);
  });

  it("SEC-15.AC-3: nothing beyond the cited facts passes", () => {
    expect(screen([draft({ requirement: "Kubernetes", text: "Kubernetes", textVi: "Kubernetes", tags: ["kubernetes"], restsOn: [{ factId: "f-7", relation: "implied_from" }], fromTerms: ["EKS"] })]).accepted).toHaveLength(1);
  });

  it("SEC-15.AC-4: a rejection holds the requirement, the text, fact ids and reasons; no contact data", () => {
    const r = screen([ci("CI/CD for 10 services")], ctx).rejected[0]!;
    expect(Object.keys(r).sort()).toEqual(["reasons", "requirement", "restsOn", "text", "via"]);
    expect(JSON.stringify(r)).not.toContain(cv.contact.email);
  });
});

describe("screenDerivedFacts: coverage, deny list and the cap", () => {
  it("drops a requirement an active fact already covers, and a duplicate in the same batch", () => {
    expect(reasons(draft({ requirement: "React", text: "React", fromTerms: ["Next.js"] }))).toContain("your facts already cover it");
    expect(reasons(draft({ requirement: "CI/CD", text: "CI/CD", restsOn: [{ factId: "f-12", relation: "implied_from" }], fromTerms: ["GitHub Actions"] }))).toContain("your facts already cover it");
    const two = screen([draft(), draft({ requirement: "Redux Toolkit" })]);
    expect(two.accepted).toHaveLength(1);
    expect(two.rejected[0]!.reasons).toEqual(["your facts already cover it"]);
  });

  it("never adds a skill Ba undid or deleted", () => {
    const denied = implicationTable({ allow: [], deny: [{ skill: "redux", restsOn: ["f-3"], at: "2026-10-19T08:00:00Z" }] });
    expect(reasons(draft(), { table: denied })).toEqual(["you removed this fact before, so it is not added again"]);
  });

  it("SEC-16.AC-3: at most 5 per job; the 6th is rejected with a reason", () => {
    const skills = ["Redux", "JavaScript", "HTML", "CSS", "Zustand", "MobX"];
    const r = screen(skills.map((s) => draft({ requirement: s, text: s, textVi: s, tags: [s.toLowerCase()] })));
    expect(r.accepted).toHaveLength(5);
    expect(r.rejected).toEqual([expect.objectContaining({ text: "MobX", reasons: ["more than 5 facts for one job"] })]);
    expect(screen([draft()], { limit: 0 }).rejected[0]!.reasons).toEqual(["more than 0 facts for one job"]);
  });
});

describe("building the derived facts (§5.1)", () => {
  const now = new Date("2026-10-19T08:00:00Z");

  it("REQ-15.AC-1 / REQ-26.AC-1: org and dates come from the cited facts, never the bot; source hashes are kept", () => {
    const [built] = buildDerivedFacts([draft()], cv, { jobId: "123", taskId: "456", now });
    expect(built).toEqual({
      id: "f-d1",
      type: "skill",
      text: "Redux",
      textVi: "Redux",
      tags: ["redux"],
      org: "Gradion",
      dates: "2023-2025",
      derived: { restsOn: [{ factId: "f-3", relation: "implied_from", sourceHash: factSourceHash(f3) }], via: "model", rationale: draft().rationale, requirement: "Redux", jobId: "123", taskId: "456", derivedAt: now.toISOString() },
    });
    expect(MasterCvSchema.safeParse({ ...cv, facts: [...cv.facts, built] }).success).toBe(true);
    // A table derivation has no task.
    expect(buildDerivedFacts([draft({ via: "table" })], cv, { jobId: "123", taskId: "456", now })[0]!.derived!.taskId).toBeNull();
  });

  it("several orgs → no org or dates; one org → the span of its dates", () => {
    expect(derivedOrgAndDates([f3, f7])).toEqual({ org: null, dates: null });
    expect(derivedOrgAndDates([{ org: "Gradion", dates: "Feb 2024 – Sep 2025" }, { org: "Gradion", dates: "Jun 2023 – Jan 2024" }])).toEqual({ org: "Gradion", dates: "Jun 2023 – Sep 2025" });
    expect(derivedOrgAndDates([{ org: "Gradion", dates: "2023 – present" }, { org: "Gradion", dates: "2021 – 2023" }])).toEqual({ org: "Gradion", dates: "2021 – present" });
    expect(derivedOrgAndDates([{ org: null, dates: null }])).toEqual({ org: null, dates: null });
  });

  it("ids use the first cited fact's prefix plus -d<n>", () => {
    expect(derivedFactId("grad-3", ["grad-3", "grad-d1", "grad-d4"])).toBe("grad-d5");
    expect(derivedFactId("gradion-role", ["gradion-role"])).toBe("gradion-d1");
  });

  it("the table pass goes through the same screen: Kubernetes from EKS, not from Java", () => {
    const own = cv.facts.filter((f) => !f.derived);
    const gaps = ["Kubernetes"].map((g) => analyseGap(g, own, table));
    const drafts = tableDrafts(tablePass(gaps, own, table).derivations);
    expect(drafts).toEqual([expect.objectContaining({ text: "Kubernetes", restsOn: [{ factId: "f-7", relation: "implied_from" }], fromTerms: ["EKS"], via: "table" })]);
    expect(screen(drafts).accepted).toHaveLength(1);
  });

  it("learns a model-judged implication the table did not know, and denies an undone one", () => {
    const zustand = draft({ requirement: "Zustand", text: "Zustand", textVi: "Zustand", tags: ["zustand"] });
    expect(learnedAllowFrom([zustand, draft()], table, now)).toEqual([{ skill: "Zustand", impliedBy: "React", firstSeen: now.toISOString(), factId: "f-3", rationale: zustand.rationale }]);
    expect(learnedAllowFrom([{ ...zustand, via: "table" }], table, now)).toEqual([]);
    expect(denyEntriesFor([f31, f3], now)).toEqual([{ skill: "ci/cd", restsOn: ["f-12"], at: now.toISOString() }]);
  });
});
