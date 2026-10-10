import { isTrustLevelAllowed, maxTrustLevel } from "@bs-job-agents/shared";
import { and, asc, desc, eq } from "drizzle-orm";
import type { Conn } from "../client.js";
import { TRUST_LEVELS, type Engine, type TrustLevel } from "../enums.js";
import { NotFoundError, TrustLevelRefusedError } from "../errors.js";
import { bots, memoryChanges, promptVersions, workflows } from "../schema.js";
import { nowIso, type ClockOpts } from "../time.js";
import type { Bot, MemoryChange, PromptVersion, Workflow } from "../types.js";

// ---------------------------------------------------------------- bots

export interface UpsertBotInput {
  name: string;
  displayName: string;
  engine: Engine;
  trustLevel: TrustLevel;
  model?: string | null;
  promptVersion?: number;
  enabled?: boolean;
}

/**
 * PM S1: Apply stays at L1 in Phase 1 (UC-19); throws TrustLevelRefusedError. A level outside
 * 0–2 is left to the trust_level CHECK constraint.
 */
function assertTrustLevel(name: string, level: number): void {
  if (!(TRUST_LEVELS as readonly number[]).includes(level)) return;
  if (!isTrustLevelAllowed(name, level as TrustLevel)) throw new TrustLevelRefusedError(name, level, maxTrustLevel(name));
}

/** Sync a bot from its `bot.json` (§5.1). Refuses a trust level above the Phase 1 cap (PM S1). */
export function upsertBot(db: Conn, input: UpsertBotInput): Bot {
  assertTrustLevel(input.name, input.trustLevel);
  const values = {
    name: input.name,
    displayName: input.displayName,
    engine: input.engine,
    trustLevel: input.trustLevel,
    model: input.model ?? null,
    promptVersion: input.promptVersion ?? 1,
    enabled: input.enabled ?? true,
  };
  const { name: _name, ...set } = values;
  return db.insert(bots).values(values).onConflictDoUpdate({ target: bots.name, set }).returning().get();
}

export function getBot(db: Conn, name: string): Bot | undefined {
  return db.select().from(bots).where(eq(bots.name, name)).get();
}

export function listBots(db: Conn): Bot[] {
  return db.select().from(bots).orderBy(asc(bots.name)).all();
}

/** Bots screen changes (engine switch, trust level, enabled). Refuses Apply at L2 (PM S1, UC-19). */
export function updateBot(
  db: Conn,
  name: string,
  patch: Partial<Pick<Bot, "engine" | "model" | "trustLevel" | "promptVersion" | "enabled" | "displayName">>,
): Bot {
  if (patch.trustLevel !== undefined) assertTrustLevel(name, patch.trustLevel);
  const row = db.update(bots).set(patch).where(eq(bots.name, name)).returning().get();
  if (!row) throw new NotFoundError("bot", name);
  return row;
}

// ---------------------------------------------------------------- prompt versions

export interface RecordPromptVersionInput {
  botName: string;
  version: number;
  roleMdHash: string;
  roleMdText: string;
}

/** Idempotent per (bot, version): returns the existing row if already stored. */
export function recordPromptVersion(db: Conn, input: RecordPromptVersionInput, opts?: ClockOpts): PromptVersion {
  const existing = getPromptVersion(db, input.botName, input.version);
  if (existing) return existing;
  return db
    .insert(promptVersions)
    .values({ ...input, createdAt: nowIso(opts) })
    .returning()
    .get();
}

export function getPromptVersion(db: Conn, botName: string, version: number): PromptVersion | undefined {
  return db
    .select()
    .from(promptVersions)
    .where(and(eq(promptVersions.botName, botName), eq(promptVersions.version, version)))
    .get();
}

export function latestPromptVersion(db: Conn, botName: string): PromptVersion | undefined {
  return db
    .select()
    .from(promptVersions)
    .where(eq(promptVersions.botName, botName))
    .orderBy(desc(promptVersions.version))
    .limit(1)
    .get();
}

// ---------------------------------------------------------------- memory changes (§5.4)

export function appendMemoryChange(
  db: Conn,
  input: { botName: string; note: string; runId?: number | null; taskId?: number | null },
  opts?: ClockOpts,
): MemoryChange {
  return db
    .insert(memoryChanges)
    .values({
      botName: input.botName,
      note: input.note,
      runId: input.runId ?? null,
      taskId: input.taskId ?? null,
      createdAt: nowIso(opts),
    })
    .returning()
    .get();
}

export function listMemoryChanges(db: Conn, botName: string): MemoryChange[] {
  return db
    .select()
    .from(memoryChanges)
    .where(eq(memoryChanges.botName, botName))
    .orderBy(asc(memoryChanges.id))
    .all();
}

// ---------------------------------------------------------------- workflows (§7)

/** Store a workflow definition version. Re-saving the same YAML is a no-op; different YAML for an existing version throws. */
export function saveWorkflow(
  db: Conn,
  input: { name: string; version: number; definitionYaml: string },
  opts?: ClockOpts,
): Workflow {
  const existing = getWorkflow(db, input.name, input.version);
  if (existing) {
    if (existing.definitionYaml !== input.definitionYaml) {
      throw new Error(`workflow ${input.name} v${input.version} already exists with a different definition`);
    }
    return existing;
  }
  return db
    .insert(workflows)
    .values({ ...input, createdAt: nowIso(opts) })
    .returning()
    .get();
}

/** A specific version, or the latest when `version` is omitted. */
export function getWorkflow(db: Conn, name: string, version?: number): Workflow | undefined {
  return db
    .select()
    .from(workflows)
    .where(and(eq(workflows.name, name), version !== undefined ? eq(workflows.version, version) : undefined))
    .orderBy(desc(workflows.version))
    .limit(1)
    .get();
}
