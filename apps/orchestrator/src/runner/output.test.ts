import { describe, expect, it } from "vitest";
import { applyPausedFixture, consultReplyFixture, qaPassFixture } from "@bs-job-agents/shared/fixtures";
import { checkOutput, failedSelfCheckItems, repairPrompt } from "./output.js";

const QA_ITEMS = ["Every score has a justification", "Every fix is actionable and refers to a section"];

describe("checkOutput (§5.5 step 4)", () => {
  it("accepts a valid output that reports every self-check item", () => {
    expect(checkOutput("QaOutput", qaPassFixture, QA_ITEMS)).toEqual({ ok: true, output: qaPassFixture });
  });

  it("reports a missing output", () => {
    expect(checkOutput("QaOutput", undefined, QA_ITEMS)).toEqual({ ok: false, missing: true, errors: ["no structured output"] });
  });

  it("lists Zod issues with their paths (cross-field rules the JSON Schema cannot express)", () => {
    const bad = { ...applyPausedFixture, pendingQuestions: [], pauseReason: null };
    const r = checkOutput("ApplyOutput", bad, ["All required fields are filled"]);
    expect(r).toEqual({ ok: false, missing: false, errors: ["pauseReason: paused needs a pauseReason or pendingQuestions"] });
  });

  it("an empty reply fails the min length (the live repair case)", () => {
    const r = checkOutput("ConsultOutput", { ...consultReplyFixture, reply: "" }, ["Answered within my role; no work was done"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/^reply: /);
  });

  it("requires every bot.json self-check item to be reported (rule 4), tolerating case and punctuation", () => {
    const relaxed = {
      ...qaPassFixture,
      selfCheck: [
        { item: "every score has a justification.", passed: true, note: null },
        { item: "Every fix is actionable and refers to a section", passed: true, note: null },
      ],
    };
    expect(checkOutput("QaOutput", relaxed, QA_ITEMS).ok).toBe(true);
    const missing = { ...qaPassFixture, selfCheck: [{ item: "Every score has a justification", passed: true, note: null }] };
    expect(checkOutput("QaOutput", missing, QA_ITEMS)).toEqual({
      ok: false,
      missing: false,
      errors: ['selfCheck: missing item "Every fix is actionable and refers to a section"'],
    });
  });

  it("caps the error list", () => {
    const r = checkOutput("QaOutput", { nope: 1 }, QA_ITEMS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeLessThanOrEqual(20);
  });
});

describe("failedSelfCheckItems (§5.5 step 5)", () => {
  it("lists failed items with their notes", () => {
    expect(failedSelfCheckItems(qaPassFixture)).toEqual([]);
    expect(
      failedSelfCheckItems({
        ...qaPassFixture,
        selfCheck: [
          { item: "Every score has a justification", passed: false, note: "clarity has none" },
          { item: "Every fix is actionable and refers to a section", passed: false, note: null },
        ],
      }),
    ).toEqual(["Every score has a justification — clarity has none", "Every fix is actionable and refers to a section"]);
  });
});

describe("repairPrompt", () => {
  it("names the schema and every error, and keeps tools off", () => {
    const p = repairPrompt({ schemaName: "ConsultOutput", errors: ["reply: String must contain at least 1 character(s)"], missing: false, engine: "claude" });
    expect(p).toContain("schema ConsultOutput");
    expect(p).toContain("- reply: String must contain at least 1 character(s)");
    expect(p).toMatch(/do not use any tool/i);
    expect(p).toMatch(/do not redo the work/i);
    expect(p).toMatch(/keep the self-check results/i);
    expect(p).toContain("StructuredOutput");
  });

  it("asks for the missing output based on the work already done", () => {
    const p = repairPrompt({ schemaName: "QaOutput", errors: ["no structured output"], missing: true, engine: "codex" });
    expect(p).toMatch(/ended without/);
    expect(p).toMatch(/final message must be only the JSON object/);
  });
});
