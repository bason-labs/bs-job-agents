// PM2 S6: the prompt-version lock. bots/prompt-versions.json records, per bot, the promptVersion
// of its bot.json and the SHA-256 of its ROLE.md. A test checks the lock against the files, so a
// ROLE.md that changed without a promptVersion bump fails CI instead of refusing the start on Ba's
// machine (decision 8; Engine.start compares ROLE.md with prompt_versions the same way).
// Update after a bump: pnpm --filter @bs-job-agents/orchestrator bots:lock
// The writer refuses a changed ROLE.md whose promptVersion was not bumped.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadBots, readBotPromptFiles } from "./bots.js";

export const PROMPT_LOCK_FILE = "prompt-versions.json";
const LOCK_PATH = `bots/${PROMPT_LOCK_FILE}`;
const UPDATE = "run pnpm --filter @bs-job-agents/orchestrator bots:lock";

export interface PromptLockEntry {
  promptVersion: number;
  roleMdSha256: string;
}

export type PromptLock = Record<string, PromptLockEntry>;

export class PromptLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptLockError";
  }
}

/** Every bot's promptVersion (bot.json) and ROLE.md SHA-256, as they are on disk now. */
export function currentPromptVersions(botsDir: string): PromptLock {
  const out: PromptLock = {};
  for (const def of loadBots(botsDir)) {
    out[def.name] = { promptVersion: def.promptVersion, roleMdSha256: readBotPromptFiles(join(botsDir, def.name)).roleMdHash };
  }
  return out;
}

/** bots/prompt-versions.json, or null when it does not exist. */
export function readPromptLock(botsDir: string): PromptLock | null {
  const path = join(botsDir, PROMPT_LOCK_FILE);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as PromptLock;
}

/** Changed ROLE.md files whose promptVersion stayed the same, and versions that went down. */
function forbiddenChanges(locked: PromptLock, current: PromptLock): string[] {
  const problems: string[] = [];
  for (const [name, now] of Object.entries(current)) {
    const was = locked[name];
    if (!was) continue;
    if (now.promptVersion < was.promptVersion) {
      problems.push(`bots/${name}: promptVersion went down from ${was.promptVersion} to ${now.promptVersion} in bots/${name}/bot.json`);
    } else if (now.promptVersion === was.promptVersion && now.roleMdSha256 !== was.roleMdSha256) {
      problems.push(
        `bots/${name}/ROLE.md changed without a promptVersion bump: bump promptVersion in bots/${name}/bot.json (now ${now.promptVersion}), then ${UPDATE}`,
      );
    }
  }
  return problems;
}

/** What is wrong with the lock (empty = in step with every bot.json and ROLE.md). */
export function checkPromptLock(botsDir: string): string[] {
  const locked = readPromptLock(botsDir);
  if (!locked) return [`${LOCK_PATH} is missing: ${UPDATE}`];
  const current = currentPromptVersions(botsDir);
  const problems = forbiddenChanges(locked, current);
  for (const [name, now] of Object.entries(current)) {
    const was = locked[name];
    if (!was) problems.push(`bots/${name}: not in ${LOCK_PATH}; ${UPDATE}`);
    else if (now.promptVersion > was.promptVersion) {
      problems.push(`bots/${name}: promptVersion is ${now.promptVersion} but the lock says ${was.promptVersion}; ${UPDATE}`);
    }
  }
  for (const name of Object.keys(locked)) {
    if (!current[name]) problems.push(`bots/${name}: in ${LOCK_PATH} but the bot is gone; ${UPDATE}`);
  }
  return problems;
}

/**
 * Write the lock from the files on disk. Refuses (PromptLockError, nothing written) when a ROLE.md
 * changed without a promptVersion bump or a version went down. Returns the bots whose entry changed.
 */
export function updatePromptLock(botsDir: string): string[] {
  const locked = readPromptLock(botsDir) ?? {};
  const current = currentPromptVersions(botsDir);
  const refused = forbiddenChanges(locked, current);
  if (refused.length > 0) throw new PromptLockError(refused.join("\n"));
  const names = [...new Set([...Object.keys(locked), ...Object.keys(current)])].sort();
  const changed = names.filter((n) => JSON.stringify(locked[n]) !== JSON.stringify(current[n]));
  if (changed.length === 0) return [];
  const sorted = Object.fromEntries(Object.keys(current).sort().map((n) => [n, current[n]]));
  writeFileSync(join(botsDir, PROMPT_LOCK_FILE), `${JSON.stringify(sorted, null, 2)}\n`);
  return changed;
}
