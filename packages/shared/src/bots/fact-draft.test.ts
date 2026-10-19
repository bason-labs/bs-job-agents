import { describe, expect, it } from "vitest";
import { FactDraftRequestSchema, FactDraftViewSchema, FactUndoRequestSchema } from "../api/fact-drafts.js";
import { botDefinitionFixtures } from "../fixtures/bot-definitions.js";
import { factDraftNoneFixture, factDraftOutputFixture } from "../fixtures/bot-outputs.js";
import { cvFactDraftInputFixture } from "../fixtures/task-inputs.js";
import { checkStrictJsonSchema } from "../json-schema/check.js";
import { BOT_TASK_KINDS, BotDefinitionSchema, TOOLLESS_TASK_KEYS, isToollessTask, resolveOutputSchemaName, resolveSelfCheckItems } from "./definition.js";
import {
  FACT_DRAFT_MAX_FACTS,
  FACT_DRAFT_SELF_CHECK,
  FactDraftOutputSchema,
  capitalisedNames,
  draftedToFact,
  screenDraftedFacts,
  withFreeFactIds,
  type DraftedFact,
} from "./fact-draft.js";
import { BOT_TASK_INPUT_SCHEMAS, BOT_TASK_PROMPT_INPUT_SCHEMAS, promptInputSchemaFor } from "./inputs.js";
import { BOT_OUTPUT_RULES, getBotOutputJsonSchema, parseBotOutput } from "./registry.js";

const fact = (over: Partial<DraftedFact> = {}): DraftedFact => ({ ...factDraftOutputFixture.facts[0]!, ...over });

describe("cv.fact_draft task (owner request 2026-10-11)", () => {
  it("is a CV task kind that runs with no tools", () => {
    expect(BOT_TASK_KINDS.cv).toEqual(["tailor", "fact_draft", "derive", "review"]);
    expect(TOOLLESS_TASK_KEYS).toEqual(["cv.fact_draft", "cv.derive", "cv.review", "research.guidance_extract"]);
    expect(isToollessTask("cv", "fact_draft")).toBe(true);
    expect(isToollessTask("cv", "tailor")).toBe(false);
    expect(isToollessTask("cv", "consult")).toBe(false);
  });

  it("validates its input strictly for the prompt", () => {
    expect(BOT_TASK_INPUT_SCHEMAS["cv.fact_draft"].safeParse(cvFactDraftInputFixture).success).toBe(true);
    expect(promptInputSchemaFor("cv", "fact_draft")).toBe(BOT_TASK_PROMPT_INPUT_SCHEMAS["cv.fact_draft"]);
    expect(BOT_TASK_PROMPT_INPUT_SCHEMAS["cv.fact_draft"].safeParse({ ...cvFactDraftInputFixture, factRequestId: "x" }).success).toBe(false);
    expect(BOT_TASK_INPUT_SCHEMAS["cv.fact_draft"].safeParse({ ...cvFactDraftInputFixture, text: "   " }).success).toBe(false);
    expect(BOT_TASK_INPUT_SCHEMAS["cv.fact_draft"].safeParse({ ...cvFactDraftInputFixture, text: "x".repeat(4001) }).success).toBe(false);
  });

  it("has a strict output schema: 0–5 facts, slug ids, notes, the envelope", () => {
    expect(checkStrictJsonSchema(getBotOutputJsonSchema("FactDraftOutput"))).toEqual([]);
    expect(parseBotOutput("FactDraftOutput", factDraftOutputFixture).success).toBe(true);
    expect(parseBotOutput("FactDraftOutput", factDraftNoneFixture).success).toBe(true);
    const six = { ...factDraftOutputFixture, facts: Array.from({ length: FACT_DRAFT_MAX_FACTS + 1 }, (_, i) => fact({ id: `grad-${i + 2}` })) };
    expect(FactDraftOutputSchema.safeParse(six).success).toBe(false);
    expect(FactDraftOutputSchema.safeParse({ ...factDraftOutputFixture, facts: [fact({ id: "Grad 2" })] }).success).toBe(false);
    expect(FactDraftOutputSchema.safeParse({ ...factDraftOutputFixture, facts: [{ ...fact(), extra: 1 }] }).success).toBe(false);
    expect(FactDraftOutputSchema.safeParse({ ...factDraftOutputFixture, facts: [fact({ type: "hobby" as never })] }).success).toBe(false);
    expect(BOT_OUTPUT_RULES.FactDraftOutput.length).toBeGreaterThan(0);
  });

  it("uses FactDraftOutput and its own self-check on the CV bot", () => {
    const cv = BotDefinitionSchema.parse(botDefinitionFixtures.find((d) => d.name === "cv"));
    expect(resolveOutputSchemaName(cv, "fact_draft")).toBe("FactDraftOutput");
    expect(resolveOutputSchemaName(cv, "tailor")).toBe("CvOutput");
    expect(resolveSelfCheckItems(cv, "fact_draft")).toEqual([...FACT_DRAFT_SELF_CHECK]);
    expect(FACT_DRAFT_SELF_CHECK).toContain("Every claim in the facts appears in Ba's text");
  });
});

describe("screenDraftedFacts: the invented-detail guard", () => {
  const source = { text: cvFactDraftInputFixture.text, question: cvFactDraftInputFixture.question, existingFacts: cvFactDraftInputFixture.existingFacts };

  it("accepts a fact built only from Ba's words, the question and his existing role", () => {
    expect(screenDraftedFacts([fact()], source)).toEqual({ accepted: [fact()], rejected: [] });
  });

  it("rejects a number Ba did not write (text, Vietnamese text or tags)", () => {
    const r = screenDraftedFacts([fact({ text: "Deployed 12 Next.js apps to AWS ECS with Terraform." })], source);
    expect(r.accepted).toEqual([]);
    expect(r.rejected[0]!.reasons).toEqual(["the number 12 is not in your words"]);
    expect(screenDraftedFacts([fact({ textVi: "Giảm 40% chi phí AWS." })], source).rejected[0]!.reasons).toEqual(["the number 40 is not in your words"]);
    expect(screenDraftedFacts([fact({ tags: ["aws", "2023"] })], source).rejected).toHaveLength(1);
  });

  it("rejects a year Ba did not give, but keeps the dates of the role he refers to", () => {
    expect(screenDraftedFacts([fact({ dates: "2019 – 2021" })], source).rejected[0]!.reasons).toEqual([
      "the date 2019 is not in your words",
      "the date 2021 is not in your words",
    ]);
    expect(screenDraftedFacts([fact({ dates: "2022 – present" })], source).accepted).toHaveLength(1);
    const own = { ...source, text: "Since 2021 I have run our CI on GitHub Actions." };
    expect(screenDraftedFacts([fact({ text: "Ran CI on GitHub Actions.", textVi: null, tags: [], org: null, dates: "2021 – present" })], own).accepted).toHaveLength(1);
  });

  it("rejects a capitalised tool or name that is not in Ba's words", () => {
    const r = screenDraftedFacts([fact({ text: "Deployed Next.js apps to AWS ECS with Terraform and Kubernetes." })], source);
    expect(r.rejected[0]!.reasons).toEqual(["“Kubernetes” is not in your words"]);
    // Inner capitals and digits count even at the start of a sentence.
    expect(screenDraftedFacts([fact({ text: "GraphQL on AWS." })], source).rejected[0]!.reasons).toEqual(["“GraphQL” is not in your words"]);
    expect(screenDraftedFacts([fact({ text: "K8s clusters on AWS." })], source).rejected[0]!.reasons).toContain("“K8s” is not in your words");
  });

  it("allows a sentence-initial verb, months, case differences and his existing organisations", () => {
    const vi = { text: "Có, ở công ty hiện tại tôi deploy app Next.js lên aws ecs bằng terraform từ tháng 3/2023.", question: null, existingFacts: source.existingFacts };
    const f = fact({ text: "Deployed Next.js apps to AWS ECS with Terraform at Gradion since March 2023.", textVi: "Triển khai ứng dụng Next.js lên AWS ECS bằng Terraform tại Gradion từ tháng 3/2023.", dates: null });
    expect(screenDraftedFacts([f], vi)).toEqual({ accepted: [f], rejected: [] });
  });

  it("rejects an organisation from nowhere", () => {
    expect(screenDraftedFacts([fact({ org: "Amazon" })], source).rejected[0]!.reasons).toEqual(["the organisation “Amazon” is not in your words or your facts"]);
  });

  it("reads number words as numbers (EN and VI)", () => {
    const words = { ...source, text: "Ba năm dùng AWS ở Gradion; three services." };
    expect(screenDraftedFacts([fact({ text: "3 years with AWS at Gradion; 3 services.", textVi: null, tags: [] })], words).accepted).toHaveLength(1);
  });

  it("finds capitalised names but skips plain sentence starts and Vietnamese words", () => {
    expect(capitalisedNames("Built a Next.js app. Used Docker and AWS. Led CI.")).toEqual(["Next.js", "Docker", "AWS", "CI"]);
    expect(capitalisedNames("Triển khai ở Đà Nẵng")).toEqual([]);
    expect(capitalisedNames("Kubernetes runs it")).toEqual([]);
  });
});

describe("withFreeFactIds and draftedToFact", () => {
  it("renames a taken id to the next free number of its prefix", () => {
    const out = withFreeFactIds([{ id: "grad-1" }, { id: "grad-1" }, { id: "skill-9" }], ["grad-1", "grad-4", "skill-1"]);
    expect(out.map((f) => f.id)).toEqual(["grad-5", "grad-6", "skill-9"]);
  });

  it("normalises tags and empty Vietnamese text", () => {
    expect(draftedToFact(fact({ tags: ["AWS", "aws", " ecs "], textVi: " " }))).toMatchObject({ tags: ["aws", "ecs"], textVi: null });
  });
});

describe("fact draft API shapes", () => {
  it("takes Ba's text, the request he answers and the version he sees", () => {
    expect(FactDraftRequestSchema.parse({ text: "  Yes, on AWS  ", factRequestId: "2102-0", version: 7 })).toEqual({ text: "Yes, on AWS", factRequestId: "2102-0", version: 7 });
    expect(FactDraftRequestSchema.safeParse({ text: "", version: 7 }).success).toBe(false);
    expect(FactDraftRequestSchema.safeParse({ text: "x", version: 7, extra: 1 }).success).toBe(false);
    expect(FactDraftRequestSchema.safeParse({ text: "x" }).success).toBe(false);
    expect(FactUndoRequestSchema.safeParse({ version: 8 }).success).toBe(true);
  });

  it("describes a settled draft", () => {
    const view = {
      taskId: "31",
      status: "added",
      text: "Yes",
      factRequestId: "2102-0",
      facts: [draftedToFact(fact())],
      version: 8,
      previousVersion: 7,
      notes: null,
      rejected: [],
      error: null,
      undone: false,
      undoable: true,
      retailor: { jobId: "101", company: "Hubble", stepIds: ["9"], note: null },
    };
    expect(FactDraftViewSchema.safeParse(view).success).toBe(true);
    expect(FactDraftViewSchema.safeParse({ ...view, status: "done" }).success).toBe(false);
  });
});
