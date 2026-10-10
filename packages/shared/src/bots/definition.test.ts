import { describe, expect, it } from "vitest";
import { botDefinitionFixtures, researchBotJson } from "../fixtures/bot-definitions.js";
import { TRUST_LEVEL_LABELS, trustLevelLabel } from "../common/primitives.js";
import {
  BOT_TASK_KINDS,
  BotDefinitionSchema,
  isOutwardFacingBrowser,
  resolveOutputSchemaName,
} from "./definition.js";
import { BOT_TASK_INPUT_SCHEMAS } from "./inputs.js";
import {
  applyInputFixture,
  cvTailorInputFixture,
  qaReviewInputFixture,
  researchCompanyInputFixture,
  researchFileInputFixture,
  researchFitInputFixture,
  researchScanInputFixture,
  researchSingleInputFixture,
} from "../fixtures/task-inputs.js";

describe("BotDefinitionSchema (bot.json, §5.1)", () => {
  it("parses the spec's research example", () => {
    const def = BotDefinitionSchema.parse(researchBotJson);
    expect(def.engine).toBe("codex");
    expect(def.trustLevel).toBe(2);
    expect(def.browser?.allowedSites).toContain("topcv.vn");
  });

  it("parses all five Phase 1 bots with the spec's engines and trust levels", () => {
    const defs = botDefinitionFixtures.map((d) => BotDefinitionSchema.parse(d));
    const summary = Object.fromEntries(defs.map((d) => [d.name, `${d.engine}/${trustLevelLabel(d.trustLevel)}`]));
    expect(summary).toEqual({
      lead: "claude/L1",
      research: "codex/L2",
      cv: "claude/L2",
      qa: "codex/L2",
      apply: "claude/L1",
    });
  });

  it("applies defaults (timeoutSec 600, empty lists, no browser)", () => {
    const def = BotDefinitionSchema.parse({
      name: "scout",
      displayName: "Scout",
      role: "Look around.",
      engine: "claude",
      model: null,
      trustLevel: 0,
      outputSchema: "ConsultOutput",
      selfCheck: ["Did nothing outward-facing"],
      promptVersion: 1,
    });
    expect(def.timeoutSec).toBe(600);
    expect(def.allowedTools).toEqual([]);
    expect(def.mcpServers).toEqual([]);
    expect(def.browser).toBeNull();
  });

  it.each([
    ["uppercase name", { name: "Research" }],
    ["unknown engine", { engine: "gemini" }],
    ["trust level 3", { trustLevel: 3 }],
    ["trust level as label", { trustLevel: "L2" }],
    ["unknown output schema", { outputSchema: "MadeUpOutput" }],
    ["empty selfCheck", { selfCheck: [] }],
    ["zero prompt version", { promptVersion: 0 }],
    ["site with scheme", { browser: { mode: "read", allowedSites: ["https://topcv.vn"] } }],
    ["browser mode without sites", { browser: { mode: "write", allowedSites: [] } }],
  ])("rejects %s", (_label, patch) => {
    expect(BotDefinitionSchema.safeParse({ ...researchBotJson, ...patch }).success).toBe(false);
  });

  it("accepts a per-kind outputSchema map and resolves it", () => {
    const def = BotDefinitionSchema.parse(researchBotJson);
    expect(resolveOutputSchemaName(def, "scan")).toBe("ResearchScanOutput");
    expect(resolveOutputSchemaName(def, "single")).toBe("ResearchScanOutput");
    expect(resolveOutputSchemaName(def, "fit")).toBe("ResearchFitOutput");
    expect(resolveOutputSchemaName(def, "company")).toBe("ResearchCompanyOutput");
    expect(resolveOutputSchemaName(def, "consult")).toBe("ConsultOutput");
    expect(() => resolveOutputSchemaName(def, "submit")).toThrow(/no output schema/);
  });

  it("a single outputSchema name applies to every kind except consult", () => {
    const qa = BotDefinitionSchema.parse(botDefinitionFixtures.find((d) => d.name === "qa"));
    expect(resolveOutputSchemaName(qa, "review")).toBe("QaOutput");
    expect(resolveOutputSchemaName(qa, "consult")).toBe("ConsultOutput");
  });

  it("flags browser bots that write", () => {
    const apply = BotDefinitionSchema.parse(botDefinitionFixtures.find((d) => d.name === "apply"));
    const research = BotDefinitionSchema.parse(researchBotJson);
    expect(isOutwardFacingBrowser(apply)).toBe(true);
    expect(isOutwardFacingBrowser(research)).toBe(false);
  });

  it("exposes trust labels", () => {
    expect(TRUST_LEVEL_LABELS).toEqual({ 0: "L0", 1: "L1", 2: "L2" });
  });

  it("lists task kinds per Phase 1 bot", () => {
    expect(BOT_TASK_KINDS.research).toEqual(["scan", "single", "file", "fit", "company"]);
    expect(BOT_TASK_KINDS.apply).toEqual(["submit"]);
  });
});

describe("task inputs", () => {
  it.each([
    ["research.scan", researchScanInputFixture],
    ["research.single", researchSingleInputFixture],
    ["research.file", researchFileInputFixture],
    ["research.fit", researchFitInputFixture],
    ["research.company", researchCompanyInputFixture],
    ["cv.tailor", cvTailorInputFixture],
    ["qa.review", qaReviewInputFixture],
    ["apply.submit", applyInputFixture],
  ] as const)("%s fixture parses", (key, fixture) => {
    const r = BOT_TASK_INPUT_SCHEMAS[key].safeParse(fixture);
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });

  it("apply.submit requires an approval token and allowed domains (§10.2 rules 1–2)", () => {
    const { approvalToken: _t, ...noToken } = applyInputFixture;
    expect(BOT_TASK_INPUT_SCHEMAS["apply.submit"].safeParse(noToken).success).toBe(false);
    expect(
      BOT_TASK_INPUT_SCHEMAS["apply.submit"].safeParse({ ...applyInputFixture, allowedDomains: [] }).success,
    ).toBe(false);
  });

  it("cv.tailor round must be 1..3", () => {
    expect(BOT_TASK_INPUT_SCHEMAS["cv.tailor"].safeParse({ ...cvTailorInputFixture, round: 4 }).success).toBe(false);
  });
});
