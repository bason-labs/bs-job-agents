// Additive helpers the runner needs (Phase 2, W2b): S5 prompt inputs, per-kind self-checks,
// S6 safety rules and the Zod-only output rules listed in prompts.
import { describe, expect, it } from "vitest";
import { botDefinitionFixtures, researchBotJson } from "../fixtures/bot-definitions.js";
import { applyInputFixture, cvTailorInputFixture } from "../fixtures/task-inputs.js";
import {
  BotDefinitionSchema,
  CONSULT_SELF_CHECK,
  SafeBotDefinitionSchema,
  checkBotSafety,
  resolveSelfCheckItems,
} from "./definition.js";
import {
  ApplyPromptInputSchema,
  BOT_TASK_INPUT_SCHEMAS,
  BOT_TASK_PROMPT_INPUT_SCHEMAS,
  ConversationInputSchema,
  PROMPT_FORBIDDEN_KEYS,
  findForbiddenPromptKeys,
  promptInputSchemaFor,
  splitApplySubmitInput,
} from "./inputs.js";
import { BOT_OUTPUT_RULES, BOT_OUTPUT_SCHEMA_NAMES, COMMON_OUTPUT_RULES } from "./registry.js";

const def = (name: string) => BotDefinitionSchema.parse(botDefinitionFixtures.find((d) => d.name === name));

describe("S5: the approval token never reaches a prompt", () => {
  it("splits apply.submit into the prompt input and the guard-only token", () => {
    const { prompt, approvalToken } = splitApplySubmitInput(applyInputFixture);
    expect(approvalToken).toBe(applyInputFixture.approvalToken);
    expect(prompt).not.toHaveProperty("approvalToken");
    expect(JSON.stringify(prompt)).not.toContain(applyInputFixture.approvalToken);
    expect(ApplyPromptInputSchema.parse(prompt)).toEqual(prompt);
  });

  it("the Apply prompt schema rejects a stray approval token instead of stripping it", () => {
    const r = ApplyPromptInputSchema.safeParse(applyInputFixture);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("approvalToken");
  });

  it("the guard-side schema is unchanged (still requires the token)", () => {
    const { approvalToken: _t, ...noToken } = applyInputFixture;
    expect(BOT_TASK_INPUT_SCHEMAS["apply.submit"].safeParse(noToken).success).toBe(false);
  });

  it("prompt input schemas match the task schemas except apply.submit", () => {
    expect(Object.keys(BOT_TASK_PROMPT_INPUT_SCHEMAS).sort()).toEqual(Object.keys(BOT_TASK_INPUT_SCHEMAS).sort());
    for (const key of Object.keys(BOT_TASK_INPUT_SCHEMAS) as Array<keyof typeof BOT_TASK_INPUT_SCHEMAS>) {
      if (key === "apply.submit") expect(BOT_TASK_PROMPT_INPUT_SCHEMAS[key]).toBe(ApplyPromptInputSchema);
      else expect(BOT_TASK_PROMPT_INPUT_SCHEMAS[key]).toBe(BOT_TASK_INPUT_SCHEMAS[key]);
    }
  });

  it("promptInputSchemaFor picks the task schema, the conversation schema, or none", () => {
    expect(promptInputSchemaFor("apply", "submit")).toBe(ApplyPromptInputSchema);
    expect(promptInputSchemaFor("cv", "tailor")).toBe(BOT_TASK_INPUT_SCHEMAS["cv.tailor"]);
    expect(promptInputSchemaFor("qa", "consult")).toBe(ConversationInputSchema);
    expect(promptInputSchemaFor("lead", "discussion")).toBe(ConversationInputSchema);
    expect(promptInputSchemaFor("lead", "chat")).toBeNull();
  });

  it("finds forbidden keys at any depth", () => {
    expect(PROMPT_FORBIDDEN_KEYS).toContain("approvalToken");
    expect(findForbiddenPromptKeys(cvTailorInputFixture)).toEqual([]);
    expect(findForbiddenPromptKeys(applyInputFixture)).toEqual(["$.approvalToken"]);
    expect(findForbiddenPromptKeys({ a: [{ b: { approvalToken: "x" } }], approvalToken: null })).toEqual([
      "$.a[0].b.approvalToken",
      "$.approvalToken",
    ]);
    expect(findForbiddenPromptKeys("approvalToken")).toEqual([]);
  });
});

describe("self-check items per task kind (rule 4)", () => {
  it("uses the bot's list by default", () => {
    expect(resolveSelfCheckItems(def("qa"), "review")).toEqual(def("qa").selfCheck);
  });

  it("uses a per-kind list when bot.json has one", () => {
    const research = BotDefinitionSchema.parse({
      ...researchBotJson,
      selfCheckByKind: { fit: ["Every reason cites master data"] },
    });
    expect(resolveSelfCheckItems(research, "fit")).toEqual(["Every reason cites master data"]);
    expect(resolveSelfCheckItems(research, "scan")).toEqual(research.selfCheck);
  });

  it("uses the consult item for consult and discussion", () => {
    expect(resolveSelfCheckItems(def("cv"), "consult")).toEqual([...CONSULT_SELF_CHECK]);
    expect(resolveSelfCheckItems(def("qa"), "discussion")).toEqual([...CONSULT_SELF_CHECK]);
  });

  it("selfCheckByKind defaults to {} and rejects empty lists", () => {
    expect(BotDefinitionSchema.parse(researchBotJson).selfCheckByKind).toEqual({});
    expect(BotDefinitionSchema.safeParse({ ...researchBotJson, selfCheckByKind: { fit: [] } }).success).toBe(false);
  });
});

describe("S6: Phase 1 bot safety rules", () => {
  it("the five fixture bots are safe", () => {
    for (const d of botDefinitionFixtures) {
      expect(checkBotSafety(BotDefinitionSchema.parse(d)), d.name).toEqual([]);
      expect(SafeBotDefinitionSchema.safeParse(d).success, d.name).toBe(true);
    }
  });

  it("a browser bot that writes must run on Claude", () => {
    const apply = { ...botDefinitionFixtures.find((d) => d.name === "apply")!, engine: "codex" as const };
    expect(checkBotSafety(BotDefinitionSchema.parse(apply)).join()).toMatch(/must run on Claude/);
    expect(SafeBotDefinitionSchema.safeParse(apply).success).toBe(false);
    const scout = { ...researchBotJson, name: "scout", browser: { mode: "write" as const, allowedSites: ["topcv.vn"] } };
    expect(SafeBotDefinitionSchema.safeParse(scout).success).toBe(false);
    expect(SafeBotDefinitionSchema.safeParse({ ...scout, engine: "claude" }).success).toBe(true);
  });

  it("Apply stays at trust level L1", () => {
    const apply = botDefinitionFixtures.find((d) => d.name === "apply")!;
    for (const trustLevel of [0, 2] as const) {
      expect(checkBotSafety(BotDefinitionSchema.parse({ ...apply, trustLevel })).join(), String(trustLevel)).toMatch(/L1/);
    }
  });

  it("Lead only has orchestrator MCP tools (rule 5)", () => {
    const lead = botDefinitionFixtures.find((d) => d.name === "lead")!;
    expect(checkBotSafety(BotDefinitionSchema.parse({ ...lead, allowedTools: [...lead.allowedTools!, "read"] })).join()).toMatch(/rule 5/);
    expect(
      checkBotSafety(BotDefinitionSchema.parse({ ...lead, browser: { mode: "read", allowedSites: ["topcv.vn"] } })).join(),
    ).toMatch(/rule 5/);
    expect(checkBotSafety(BotDefinitionSchema.parse({ ...lead, mcpServers: ["orchestrator", "figma"] })).join()).toMatch(/rule 5/);
  });
});

describe("output rules the JSON Schema cannot express", () => {
  it("has a non-empty rule list for every output schema, plus common rules", () => {
    expect(COMMON_OUTPUT_RULES.length).toBeGreaterThan(0);
    for (const name of BOT_OUTPUT_SCHEMA_NAMES) {
      expect(BOT_OUTPUT_RULES[name].length, name).toBeGreaterThan(0);
      for (const rule of BOT_OUTPUT_RULES[name]) expect(rule.trim().length, name).toBeGreaterThan(10);
    }
  });

  it("names the cross-field rules that live models broke in the QA live check", () => {
    expect(BOT_OUTPUT_RULES.ApplyOutput.join("\n")).toMatch(/paused needs pauseReason/);
    expect(BOT_OUTPUT_RULES.CvOutput.join("\n")).toMatch(/<COMPANY>_<ROLE>_<LANG>_v<n>/);
    expect(BOT_OUTPUT_RULES.QaOutput.join("\n")).toMatch(/total equals/);
    expect(COMMON_OUTPUT_RULES.join("\n")).toMatch(/placeholder/);
  });
});
