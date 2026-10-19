import { describe, expect, it } from "vitest";
import type { Fact } from "../domain/master-cv.js";
import { KNOWN_TERMS, SEED_IMPLICATIONS, analyseGap, categoriesOf, implicationTable, tablePass, termIn, termsIn } from "./implications.js";

const fact = (id: string, text: string, tags: string[] = []): Fact => ({ id, type: "experience", text, textVi: null, tags, org: "Gradion", dates: "2023 – 2025" });
const table = implicationTable();
const run = (gaps: string[], facts: Fact[], t = table) => tablePass(gaps.map((g) => analyseGap(g, facts, t)).filter((g) => !g.covered && !g.denied), facts, t);

describe("terms", () => {
  it("matches whole words, case-folded, longest first", () => {
    expect(termIn("Java", "JavaScript and TypeScript")).toBe(false);
    expect(termIn("React", "Built it in react.")).toBe(true);
    expect(termIn("C#", "C# and .NET")).toBe(true);
    expect(termIn("C", "C# and .NET")).toBe(false);
    expect(termsIn("SQL Server and SQL")).toEqual(["SQL Server", "SQL"]);
    expect(termsIn("3+ years of Redux")).toEqual(["Redux"]);
    expect(termsIn("experience with CI/CD")).toEqual(["CI/CD"]);
    expect(termsIn("PostgreSQL, MySQL")).toEqual(["PostgreSQL", "MySQL"]);
    expect(termIn("JS", "Built it in Next.js")).toBe(false);
    expect(termsIn("React.js and Node.js apps")).toEqual(["React", "Node.js"]);
  });

  it("knows each seed term and gives it categories", () => {
    const names = new Set(KNOWN_TERMS.map((t) => t.name));
    for (const i of SEED_IMPLICATIONS) for (const n of [i.skill, ...i.impliedBy]) expect(names.has(n), n).toBe(true);
    expect([...categoriesOf("Kubernetes")]).toEqual(["cloud_devops"]);
    expect([...categoriesOf("Java")]).toEqual(["backend"]);
    expect([...categoriesOf("strong communication")]).toEqual([]);
  });
});

describe("analyseGap: covered, denied, not derivable (§5.4 steps 3–4)", () => {
  const facts = [fact("grad-3", "Built the customer portal in React and Next.js"), fact("grad-12", "Built CI pipelines in GitHub Actions for 6 services", ["ci/cd"])];

  it("a gap whose terms an active fact names (text, tags or another spelling) is covered", () => {
    expect(analyseGap("ReactJS", facts, table).covered).toBe(true);
    expect(analyseGap("experience with CI/CD", facts, table).covered).toBe(true);
    expect(analyseGap("Redux", facts, table)).toMatchObject({ covered: false, uncovered: ["Redux"] });
  });

  it("a denied skill is left to a fact request", () => {
    const denied = implicationTable({ allow: [], deny: [{ skill: "redux", restsOn: ["grad-3"], at: "2026-10-19T08:00:00Z" }] });
    expect(analyseGap("Redux", facts, denied)).toMatchObject({ denied: true, uncovered: [] });
  });

  it("a degree or a language is never sent to the model", () => {
    expect(analyseGap("Bachelor's degree in Computer Science", facts, table).notDerivable).toBe(true);
    expect(analyseGap("Fluent English", facts, table).notDerivable).toBe(true);
    expect(analyseGap("Domain knowledge in payments", facts, table).notDerivable).toBe(false);
  });
});

describe("tablePass (no LLM)", () => {
  it("REQ-26.AC-2: derives Kubernetes from 'Deployed services on EKS with Docker' with no task", () => {
    const r = run(["Kubernetes"], [fact("f-7", "Deployed services on EKS with Docker")]);
    expect(r.remaining).toEqual([]);
    expect(r.derivations).toEqual([{ gap: "Kubernetes", implication: expect.objectContaining({ skill: "Kubernetes" }), facts: [{ factId: "f-7", fromTerm: "EKS" }] }]);
  });

  it("REQ-26.AC-1 / AC-3: Redux from a React fact; Rust from Python-only facts derives nothing", () => {
    expect(run(["Redux"], [fact("f-3", "Built the customer portal in React and Next.js")]).derivations[0]!.facts).toEqual([{ factId: "f-3", fromTerm: "React" }]);
    const rust = run(["Rust"], [fact("f-1", "Built data pipelines in Python")]);
    expect(rust.derivations).toEqual([]);
    expect(rust.remaining.map((g) => g.gap)).toEqual(["Rust"]);
  });

  it("REQ-17.AC-1: Kubernetes with no container fact finds no anchor", () => {
    const r = run(["Kubernetes"], [fact("f-1", "Built REST APIs in Java and Spring Boot")]);
    expect(r.derivations).toEqual([]);
    expect(r.remaining.map((g) => g.gap)).toEqual(["Kubernetes"]);
  });

  it("CI/CD from GitHub Actions; a tag counts; at most 3 facts cited", () => {
    const facts = ["a", "b", "c", "d"].map((x) => fact(`f-${x}`, "Shipped it", ["github actions"]));
    expect(run(["CI/CD pipelines"], facts).derivations[0]!.facts.map((f) => f.factId)).toEqual(["f-a", "f-b", "f-c"]);
  });

  it("a gap with a term the table cannot resolve, or no known term, remains for the model", () => {
    const r = run(["Redux and Zustand", "payments domain"], [fact("f-3", "React portal")]);
    expect(r.derivations.map((d) => d.implication.skill)).toEqual(["Redux"]);
    expect(r.remaining.map((g) => g.gap)).toEqual(["payments domain"]);
  });

  it("learned allow entries resolve a pair the model judged before, by code", () => {
    const learned = implicationTable({ allow: [{ skill: "Zustand", impliedBy: "React", firstSeen: "2026-10-19T08:00:00Z", factId: "f-3", rationale: "x" }], deny: [] });
    const r = run(["Zustand"], [fact("f-3", "React portal")], learned);
    expect(r.derivations[0]).toMatchObject({ gap: "Zustand", facts: [{ factId: "f-3", fromTerm: "React" }] });
  });
});
