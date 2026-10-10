// bots/<name>/schemas/<OutputName>.json: the strict JSON Schemas each bot can produce (spike S4).
// Generated from packages/shared (getBotOutputJsonSchema), checked strict, committed for review;
// a test fails when they are stale. The runner itself writes a fresh copy into each task's work
// dir, so a stale file can never reach Codex.
// Regenerate: pnpm --filter @bs-job-agents/orchestrator bots:schemas
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertStrictJsonSchema,
  getBotOutputJsonSchema,
  resolveOutputSchemaName,
  type BotDefinition,
  type BotOutputSchemaName,
} from "@bs-job-agents/shared";
import { botTaskKinds, loadBots } from "./bots.js";

export function botSchemaNames(def: BotDefinition): BotOutputSchemaName[] {
  return [...new Set(botTaskKinds(def).map((kind) => resolveOutputSchemaName(def, kind)))].sort();
}

/** The schema's file content: pretty JSON with a trailing newline. */
export function schemaFileContent(name: BotOutputSchemaName): string {
  const schema = getBotOutputJsonSchema(name);
  assertStrictJsonSchema(schema, name);
  return `${JSON.stringify(schema, null, 2)}\n`;
}

/** Relative path ("schemas/<Name>.json") → content, for one bot. */
export function renderBotSchemaFiles(def: BotDefinition): Record<string, string> {
  return Object.fromEntries(botSchemaNames(def).map((name) => [`schemas/${name}.json`, schemaFileContent(name)]));
}

function existingSchemaFiles(botDir: string): string[] {
  const dir = join(botDir, "schemas");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && statSync(join(dir, f)).isFile())
    .map((f) => `schemas/${f}`);
}

/** Files (relative to botsDir) that are missing, different, or no longer produced. */
export function staleBotSchemas(botsDir: string): string[] {
  const stale: string[] = [];
  for (const def of loadBots(botsDir)) {
    const botDir = join(botsDir, def.name);
    const want = renderBotSchemaFiles(def);
    for (const [rel, content] of Object.entries(want)) {
      const path = join(botDir, rel);
      if (!existsSync(path) || readFileSync(path, "utf8") !== content) stale.push(`${def.name}/${rel}`);
    }
    for (const rel of existingSchemaFiles(botDir)) if (!(rel in want)) stale.push(`${def.name}/${rel}`);
  }
  return stale.sort();
}

/** Write every bot's schema files and remove ones no longer produced. Returns the paths written or removed. */
export function writeBotSchemas(botsDir: string): string[] {
  const changed: string[] = [];
  for (const def of loadBots(botsDir)) {
    const botDir = join(botsDir, def.name);
    mkdirSync(join(botDir, "schemas"), { recursive: true });
    const want = renderBotSchemaFiles(def);
    for (const [rel, content] of Object.entries(want)) {
      const path = join(botDir, rel);
      if (!existsSync(path) || readFileSync(path, "utf8") !== content) {
        writeFileSync(path, content);
        changed.push(`${def.name}/${rel}`);
      }
    }
    for (const rel of existingSchemaFiles(botDir)) {
      if (!(rel in want)) {
        rmSync(join(botDir, rel));
        changed.push(`${def.name}/${rel}`);
      }
    }
  }
  return changed;
}
