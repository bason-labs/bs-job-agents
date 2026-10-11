import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BOT_TASK_KINDS,
  PHASE1_BOTS,
  getBotOutputJsonSchema,
  resolveOutputSchemaName,
  resolveSelfCheckItems,
  trustLevelLabel,
} from "@bs-job-agents/shared";
import { BotDefinitionError, loadBotDefinition, loadBots, readBotPromptFiles, rolePromptHash } from "./bots.js";
import { defaultBotsDir } from "./config.js";
import { botSchemaNames, renderBotSchemaFiles, staleBotSchemas, writeBotSchemas } from "./schemas.js";

const BOTS = defaultBotsDir();
const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempBot(name: string, patch: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "bsja-bots-"));
  temps.push(root);
  const dir = join(root, name);
  mkdirSync(dir);
  const base = JSON.parse(readFileSync(join(BOTS, name === "scout" ? "qa" : name, "bot.json"), "utf8")) as Record<string, unknown>;
  writeFileSync(join(dir, "bot.json"), JSON.stringify({ ...base, ...(name === "scout" ? { name: "scout" } : {}), ...patch }));
  return dir;
}

describe("bots/<name>/bot.json (§5.1, §5.2)", () => {
  it("loads the five Phase 1 bots with the spec's engines and trust levels", () => {
    const defs = loadBots(BOTS);
    expect(defs.map((d) => d.name)).toEqual([...PHASE1_BOTS].sort());
    expect(Object.fromEntries(defs.map((d) => [d.name, `${d.engine}/${trustLevelLabel(d.trustLevel)}`]))).toEqual({
      lead: "claude/L1",
      research: "claude/L2", // E1 option A (owner-decisions.md)
      cv: "claude/L2",
      qa: "codex/L2",
      apply: "claude/L1",
    });
  });

  it("Lead has only orchestrator MCP tools (rule 5); Apply writes only in the browser, on approved sites", () => {
    const lead = loadBotDefinition(join(BOTS, "lead"));
    expect(lead.allowedTools.every((t) => t.startsWith("mcp:orchestrator:"))).toBe(true);
    expect(lead.browser).toBeNull();
    expect(lead.mcpServers).toEqual(["orchestrator"]);
    const apply = loadBotDefinition(join(BOTS, "apply"));
    expect(apply.browser).toEqual({ mode: "write", allowedSites: [], sitesFromApproval: true });
    expect(apply.allowedTools).not.toContain("web_search");
  });

  it("resolves an output schema and self-check list for every task kind", () => {
    for (const def of loadBots(BOTS)) {
      for (const kind of [...BOT_TASK_KINDS[def.name as keyof typeof BOT_TASK_KINDS], "consult"]) {
        expect(() => resolveOutputSchemaName(def, kind), `${def.name}.${kind}`).not.toThrow();
        expect(resolveSelfCheckItems(def, kind).length, `${def.name}.${kind}`).toBeGreaterThan(0);
      }
    }
  });

  it.each([
    ["Apply switched to Codex (S6)", "apply", { engine: "codex" }, /must run on Claude/],
    ["Apply promoted to L2 (S6)", "apply", { trustLevel: 2 }, /L1/],
    ["Lead given a file tool (rule 5)", "lead", { allowedTools: ["mcp:orchestrator:get_status", "read"] }, /rule 5/],
    ["an unknown tool", "qa", { allowedTools: ["shell"] }, /unknown tool/],
    ["a schema violation", "qa", { trustLevel: 5 }, /trustLevel/],
    ["a folder that does not match the name", "scout", { name: "qa" }, /folder/],
  ])("refuses to load %s", (_label, name, patch, message) => {
    const dir = tempBot(name, patch);
    expect(() => loadBotDefinition(dir)).toThrow(BotDefinitionError);
    expect(() => loadBotDefinition(dir)).toThrow(message);
  });
});

describe("ROLE.md and memory.md", () => {
  it("every bot has a ROLE.md draft; memory.md is runtime state (gitignored, PM2 S5), so its content is not checked here", () => {
    for (const def of loadBots(BOTS)) {
      const files = readBotPromptFiles(join(BOTS, def.name));
      expect(files.roleMd.length, def.name).toBeGreaterThan(200);
      expect(typeof files.memoryMd, def.name).toBe("string");
      expect(files.roleMdHash).toBe(rolePromptHash(files.roleMd));
    }
  });

  it("each ROLE.md states the untrusted-content rule, the self-check items and the output schema", () => {
    for (const def of loadBots(BOTS)) {
      const role = readBotPromptFiles(join(BOTS, def.name)).roleMd;
      expect(role, def.name).toMatch(/untrusted/i);
      for (const kind of BOT_TASK_KINDS[def.name as keyof typeof BOT_TASK_KINDS]) {
        expect(role, `${def.name}.${kind}`).toContain(resolveOutputSchemaName(def, kind));
        for (const item of resolveSelfCheckItems(def, kind)) expect(role, `${def.name}: ${item}`).toContain(item);
      }
    }
  });

  it("rolePromptHash is a stable SHA-256", () => {
    expect(rolePromptHash("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("readBotPromptFiles needs ROLE.md; memory.md may be missing", () => {
    const root = mkdtempSync(join(tmpdir(), "bsja-role-"));
    temps.push(root);
    expect(() => readBotPromptFiles(root)).toThrow(/ROLE\.md/);
    writeFileSync(join(root, "ROLE.md"), "role");
    expect(readBotPromptFiles(root)).toMatchObject({ roleMd: "role", memoryMd: "" });
  });
});

describe("bots/<name>/schemas/*.json (spike S4)", () => {
  it("lists every schema a bot can produce", () => {
    const research = loadBotDefinition(join(BOTS, "research"));
    expect(botSchemaNames(research)).toEqual(["ConsultOutput", "ResearchCompanyOutput", "ResearchFitOutput", "ResearchScanOutput"]);
    expect(botSchemaNames(loadBotDefinition(join(BOTS, "apply")))).toEqual(["ApplyOutput", "ConsultOutput"]);
  });

  it("renders strict schemas from getBotOutputJsonSchema", () => {
    const files = renderBotSchemaFiles(loadBotDefinition(join(BOTS, "qa")));
    expect(Object.keys(files)).toEqual(["schemas/ConsultOutput.json", "schemas/QaOutput.json"]);
    expect(JSON.parse(files["schemas/QaOutput.json"]!)).toEqual(getBotOutputJsonSchema("QaOutput"));
  });

  it("the committed schema files are up to date (run: pnpm --filter @bs-job-agents/orchestrator bots:schemas)", () => {
    expect(staleBotSchemas(BOTS)).toEqual([]);
  });

  it("writeBotSchemas writes the files and removes ones no longer produced", () => {
    const root = mkdtempSync(join(tmpdir(), "bsja-schemas-"));
    temps.push(root);
    mkdirSync(join(root, "qa", "schemas"), { recursive: true });
    writeFileSync(join(root, "qa", "bot.json"), readFileSync(join(BOTS, "qa", "bot.json")));
    writeFileSync(join(root, "qa", "schemas", "Old.json"), "{}");
    expect(staleBotSchemas(root)).toEqual(["qa/schemas/ConsultOutput.json", "qa/schemas/Old.json", "qa/schemas/QaOutput.json"]);
    writeBotSchemas(root);
    expect(staleBotSchemas(root)).toEqual([]);
  });
});
