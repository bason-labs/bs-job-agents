import { MasterCvSchema } from "@bs-job-agents/shared";
import { describe, expect, it } from "vitest";
import { MASTER_CV } from "./fixtures";
import { factFromRequest, factMeta, isMasterDirty, newFact, suggestFactId, validateMasterCv } from "./logic";

describe("master CV fixture", () => {
  it("is a valid master CV with the prototype's facts (version 7)", () => {
    expect(() => MasterCvSchema.parse(MASTER_CV)).not.toThrow();
    expect(MASTER_CV.version).toBe(7);
    expect(MASTER_CV.facts.map((f) => f.id)).toEqual(["grad-1", "grad-2", "grad-3", "grad-4", "aeg-1", "apc-1", "skill-1"]);
  });
});

describe("suggestFactId", () => {
  it("continues the numbering of the fact's organisation", () => {
    expect(suggestFactId(MASTER_CV.facts, { org: "Gradion", type: "experience" })).toBe("grad-5");
    expect(suggestFactId(MASTER_CV.facts, { org: "Aegona", type: "project" })).toBe("aeg-2");
    expect(suggestFactId(MASTER_CV.facts, { org: "Apps Cyclone", type: "project" })).toBe("apc-2");
  });

  it("uses the type for facts without an organisation, and slugs new organisations", () => {
    expect(suggestFactId(MASTER_CV.facts, { org: null, type: "skill" })).toBe("skill-2");
    expect(suggestFactId(MASTER_CV.facts, { org: "", type: "metric" })).toBe("metric-1");
    expect(suggestFactId(MASTER_CV.facts, { org: "Đại học Bách Khoa", type: "education" })).toBe("dai-1");
  });
});

describe("new facts", () => {
  it("starts a blank skill fact with a free id", () => {
    expect(newFact(MASTER_CV.facts)).toEqual({ id: "skill-2", type: "skill", text: "", textVi: null, tags: [], org: null, dates: null });
  });

  it("prefills a fact from CV's question (§6.1 missing facts)", () => {
    expect(factFromRequest(MASTER_CV.facts, { topic: "GraphQL" })).toMatchObject({ id: "skill-2", type: "skill", text: "GraphQL — ", tags: ["graphql"] });
  });

  it("describes a fact like the prototype: org · type · dates", () => {
    expect(factMeta(MASTER_CV.facts[0]!)).toBe("Gradion · experience · Sep 2025 – present");
    expect(factMeta(MASTER_CV.facts.at(-1)!)).toBe("— · skill");
  });
});

describe("validateMasterCv (UC-20)", () => {
  it("accepts the fixture", () => {
    expect(validateMasterCv(MASTER_CV)).toEqual({ facts: {}, contact: {} });
  });

  it("flags empty text, bad and duplicate ids per fact", () => {
    const facts = [...MASTER_CV.facts, { ...MASTER_CV.facts[0]! }, { ...MASTER_CV.facts[1]!, id: "Bad Id", text: "" }];
    const errors = validateMasterCv({ ...MASTER_CV, facts });
    expect(errors.facts[7]).toBe("duplicate fact id grad-1");
    expect(errors.facts[8]).toMatch(/lowercase/);
  });

  it("needs the text of every fact", () => {
    const facts = MASTER_CV.facts.map((f, i) => (i === 2 ? { ...f, text: "  " } : f));
    expect(validateMasterCv({ ...MASTER_CV, facts }).facts[2]).toBe("Write the fact's text");
  });

  it("checks the contact name and email", () => {
    expect(validateMasterCv({ ...MASTER_CV, contact: { ...MASTER_CV.contact, name: "", email: "nope" } }).contact).toEqual({
      name: "Your name is required",
      email: "Enter a valid email",
    });
  });
});

describe("isMasterDirty", () => {
  it("compares the draft with the saved master data", () => {
    expect(isMasterDirty(structuredClone(MASTER_CV), MASTER_CV)).toBe(false);
    const draft = structuredClone(MASTER_CV);
    draft.facts[0]!.text += " Edited.";
    expect(isMasterDirty(draft, MASTER_CV)).toBe(true);
  });
});
