// Loading bot definitions (§5.1): bots/<name>/bot.json, ROLE.md, memory.md.
// A definition loads only if it passes BotDefinitionSchema, the Phase 1 safety rules (PM S6:
// write-mode browser bots on Claude, Apply at L1, Lead with orchestrator tools only) and the
// tool vocabulary, and its folder name equals its name.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  BOT_TASK_KINDS,
  CONVERSATION_TASK_KINDS,
  SafeBotDefinitionSchema,
  checkBotSafety,
  resolveOutputSchemaName,
  type BotDefinition,
} from "@bs-job-agents/shared";
import { planTools, ToolConfigError } from "./tools.js";

export class BotDefinitionError extends Error {
  constructor(where: string, message: string) {
    super(`${where}: ${message}`);
    this.name = "BotDefinitionError";
  }
}

/** Task kinds a bot runs: its BOT_TASK_KINDS (Phase 1 bots) plus consult/discussion. */
export function botTaskKinds(def: Pick<BotDefinition, "name" | "outputSchema">): string[] {
  const own = (BOT_TASK_KINDS as Record<string, readonly string[]>)[def.name] ?? (typeof def.outputSchema === "string" ? [] : Object.keys(def.outputSchema));
  return [...own, ...CONVERSATION_TASK_KINDS];
}

/**
 * The checks a definition must pass to run, at load time and again before every spawn
 * (the engine may hand the runner a definition changed in the UI or the DB).
 */
export function assertRunnableBot(def: BotDefinition, where: string = def.name): void {
  const unsafe = checkBotSafety(def);
  if (unsafe.length > 0) throw new BotDefinitionError(where, unsafe.join("; "));
  try {
    planTools(def);
  } catch (err) {
    if (err instanceof ToolConfigError) throw new BotDefinitionError(where, err.message);
    throw err;
  }
}

export function loadBotDefinition(botDir: string): BotDefinition {
  const file = join(botDir, "bot.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new BotDefinitionError(file, `cannot read bot.json (${err instanceof Error ? err.message : String(err)})`);
  }
  const parsed = SafeBotDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new BotDefinitionError(file, issues.join("; "));
  }
  const def = parsed.data;
  if (def.name !== basename(botDir)) throw new BotDefinitionError(file, `folder ${basename(botDir)} must be named after the bot (${def.name})`);
  assertRunnableBot(def, file);
  for (const kind of botTaskKinds(def)) {
    try {
      resolveOutputSchemaName(def, kind);
    } catch (err) {
      throw new BotDefinitionError(file, err instanceof Error ? err.message : String(err));
    }
  }
  return def;
}

/** Every bots/<name>/ folder with a bot.json, sorted by name. */
export function loadBots(botsDir: string): BotDefinition[] {
  return readdirSync(botsDir)
    .filter((name) => statSync(join(botsDir, name)).isDirectory() && existsSync(join(botsDir, name, "bot.json")))
    .sort()
    .map((name) => loadBotDefinition(join(botsDir, name)));
}

export interface BotPromptFiles {
  roleMd: string;
  memoryMd: string;
  /** SHA-256 of ROLE.md; the engine compares it with prompt_versions before starting (PM brief). */
  roleMdHash: string;
}

export function rolePromptHash(roleMd: string): string {
  return createHash("sha256").update(roleMd, "utf8").digest("hex");
}

/** ROLE.md (required) and memory.md (may be missing or empty) from a bot folder. */
export function readBotPromptFiles(botDir: string): BotPromptFiles {
  const rolePath = join(botDir, "ROLE.md");
  if (!existsSync(rolePath)) throw new BotDefinitionError(botDir, "ROLE.md is missing");
  const roleMd = readFileSync(rolePath, "utf8");
  const memoryPath = join(botDir, "memory.md");
  const memoryMd = existsSync(memoryPath) ? readFileSync(memoryPath, "utf8") : "";
  return { roleMd, memoryMd, roleMdHash: rolePromptHash(roleMd) };
}
