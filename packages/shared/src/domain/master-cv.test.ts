import { describe, expect, it } from "vitest";
import { masterCvFixture } from "../fixtures/domain.js";
import { MasterCvSchema, activeFacts, derivedStatus, factSourceHash, masterCvForTasks, ownFacts, type Fact, type MasterCv } from "./master-cv.js";

const f3: Fact = { id: "grad-3", type: "experience", text: "Built the customer portal in React and Next.js", textVi: null, tags: ["react", "next.js"], org: "Gradion", dates: "2023 – 2025" };
const derivedRedux = (over: Partial<Fact> = {}): Fact => ({
  id: "grad-d1",
  type: "skill",
  text: "Redux",
  textVi: "Redux",
  tags: ["redux"],
  org: "Gradion",
  dates: "2023 – 2025",
  derived: {
    restsOn: [{ factId: "grad-3", relation: "implied_from", sourceHash: factSourceHash(f3) }],
    via: "table",
    rationale: "Redux is the common state library for React and Next.js apps.",
    requirement: "Redux",
    jobId: "123",
    taskId: null,
    derivedAt: "2026-10-19T08:00:00Z",
  },
  ...over,
});
const cvWith = (facts: Fact[]): MasterCv => ({ ...masterCvFixture, facts });

describe("the derived block (CV auto-extend §5.1)", () => {
  it("parses; Ba's own facts parse as before, with no derived key at all", () => {
    const parsed = MasterCvSchema.parse({ ...masterCvFixture, facts: [...masterCvFixture.facts, f3, derivedRedux()] });
    expect(parsed.facts[3]!.derived?.restsOn[0]!.relation).toBe("implied_from");
    expect(Object.keys(MasterCvSchema.parse(masterCvFixture).facts[0]!)).toEqual(["id", "type", "text", "textVi", "tags", "org", "dates"]);
    expect(MasterCvSchema.parse(masterCvFixture)).toEqual(masterCvFixture);
  });

  it("reads a bare-number job id from a hand-edited YAML as text", () => {
    const d = derivedRedux();
    const parsed = MasterCvSchema.parse({ ...masterCvFixture, facts: [f3, { ...d, derived: { ...d.derived, jobId: 123 } }] });
    expect(parsed.facts[1]!.derived?.jobId).toBe("123");
  });

  it("SEC-16: refuses a derived fact that rests on another derived fact (no chains)", () => {
    const chain = derivedRedux({ id: "grad-d2", derived: { ...derivedRedux().derived!, restsOn: [{ factId: "grad-d1", relation: "implied_from", sourceHash: "x" }] } });
    const r = MasterCvSchema.safeParse({ ...masterCvFixture, facts: [f3, derivedRedux(), chain] });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/grad-d2 rests on grad-d1, which is itself derived/);
  });

  it("refuses a derived block with no source", () => {
    const d = derivedRedux();
    expect(MasterCvSchema.safeParse({ ...masterCvFixture, facts: [f3, { ...d, derived: { ...d.derived, restsOn: [] } }] }).success).toBe(false);
  });
});

describe("derivedStatus (REQ-20.AC-1): computed from the sources, never stored", () => {
  it("is active while the source holds; Ba's facts are always active", () => {
    const cv = cvWith([f3, derivedRedux()]);
    expect(derivedStatus(cv, cv.facts[1]!)).toBe("active");
    expect(derivedStatus(cv, f3)).toBe("active");
  });

  it.each([
    ["the source is deleted", [] as Fact[]],
    ["its text changed", [{ ...f3, text: "Built the customer portal in Vue" }]],
    ["its org changed", [{ ...f3, org: "Acme" }]],
    ["its years changed", [{ ...f3, dates: "2021 – 2025" }]],
    ["it now runs to the present", [{ ...f3, dates: "2023 – present" }]],
  ])("flags source_changed when %s", (_what, sources) => {
    const cv = cvWith([...sources, derivedRedux()]);
    expect(derivedStatus(cv, cv.facts.at(-1)!)).toBe("source_changed");
  });

  it("does not flag a translation fix, months added to the same years, or whitespace", () => {
    for (const edit of [{ textVi: "Xây dựng cổng khách hàng" }, { dates: "Feb 2023 – Sep 2025" }, { text: "Built the customer  portal in React and Next.js " }]) {
      const cv = cvWith([{ ...f3, ...edit }, derivedRedux()]);
      expect(derivedStatus(cv, cv.facts[1]!), JSON.stringify(edit)).toBe("active");
    }
  });
});

describe("the per-task projection (SEC-18.AC-1)", () => {
  it("drops flagged derived facts and keeps only derived: true and the source ids", () => {
    const flagged = derivedRedux({ id: "grad-d2", text: "CI/CD", derived: { ...derivedRedux().derived!, restsOn: [{ factId: "grad-12", relation: "supports", sourceHash: "gone" }] } });
    const cv = cvWith([f3, derivedRedux(), flagged]);
    expect(activeFacts(cv).map((f) => f.id)).toEqual(["grad-3", "grad-d1"]);
    expect(ownFacts(cv).map((f) => f.id)).toEqual(["grad-3"]);
    const task = masterCvForTasks(cv);
    expect(task.facts.map((f) => f.id)).toEqual(["grad-3", "grad-d1"]);
    expect(task.facts[1]).toEqual({ ...derivedRedux(), derived: true, restsOn: ["grad-3"] });
    expect(task.facts[0]).toEqual(f3);
    expect(task.contact).toEqual(cv.contact);
  });
});
