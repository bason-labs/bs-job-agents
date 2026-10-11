import { isTrustLevelAllowed, maxTrustLevel } from "@bs-job-agents/shared";
import { and, asc, desc, eq, isNull, lte } from "drizzle-orm";
import type { Conn } from "../client.js";
import { TRUST_LEVELS, type Engine, type TrustLevel } from "../enums.js";
import { NotFoundError, TrustLevelRefusedError } from "../errors.js";
import { botDemotions, bots, memoryChanges, promptVersions, workflows } from "../schema.js";
import { nowIso, type ClockOpts } from "../time.js";
import type { Bot, BotDemotion, MemoryChange, PromptVersion, Workflow } from "../types.js";

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

/**
 * Start-up sync from bot.json (§5.1), keeping what Ba changed on the Bots screen: a missing bot
 * is inserted as bot.json says; an existing row takes bot.json's name, model and prompt version
 * but keeps its engine, trust level and enabled flag.
 */
export function syncBotFromDefinition(db: Conn, input: UpsertBotInput): Bot {
  if (!getBot(db, input.name)) return upsertBot(db, input);
  const row = db
    .update(bots)
    .set({ displayName: input.displayName, model: input.model ?? null, promptVersion: input.promptVersion ?? 1 })
    .where(eq(bots.name, input.name))
    .returning()
    .get();
  return row!;
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
  // PM2 S8: raising a demoted bot back to the level it had closes that demotion.
  if (patch.trustLevel !== undefined) restoreBotDemotions(db, name, patch.trustLevel);
  return row;
}

// ---------------------------------------------------------------- demotions (§5.3, PM2 S8)

export interface RecordBotDemotionInput {
  botName: string;
  fromLevel: number;
  toLevel: number;
  reason: string;
  detail: string | null;
  taskId: number | null;
  runId: number | null;
}

export function recordBotDemotion(db: Conn, input: RecordBotDemotionInput, opts?: ClockOpts): BotDemotion {
  return db
    .insert(botDemotions)
    .values({ ...input, createdAt: nowIso(opts), restoredAt: null })
    .returning()
    .get();
}

/** Every demotion of a bot, oldest first. */
export function listBotDemotions(db: Conn, botName: string): BotDemotion[] {
  return db.select().from(botDemotions).where(eq(botDemotions.botName, botName)).orderBy(asc(botDemotions.id)).all();
}

/** The newest demotion Ba has not restored (the Bots screen shows it), or undefined. */
export function latestBotDemotion(db: Conn, botName: string): BotDemotion | undefined {
  return db
    .select()
    .from(botDemotions)
    .where(and(eq(botDemotions.botName, botName), isNull(botDemotions.restoredAt)))
    .orderBy(desc(botDemotions.id))
    .limit(1)
    .get();
}

/** Demotions of a task (one violation demotes once). */
export function demotionsForTask(db: Conn, taskId: number): BotDemotion[] {
  return db.select().from(botDemotions).where(eq(botDemotions.taskId, taskId)).orderBy(asc(botDemotions.id)).all();
}

/** Close the open demotions a bot at `level` has undone (from_level ≤ level). Returns how many. */
export function restoreBotDemotions(db: Conn, botName: string, level: number, opts?: ClockOpts): number {
  const rows = db
    .update(botDemotions)
    .set({ restoredAt: nowIso(opts) })
    .where(and(eq(botDemotions.botName, botName), isNull(botDemotions.restoredAt), lte(botDemotions.fromLevel, level)))
    .returning()
    .all();
  return rows.length;
}

/** Close one demotion by id (Ba said a protected-page change was his). */
export function closeBotDemotion(db: Conn, id: number, opts?: ClockOpts): BotDemotion | undefined {
  return db
    .update(botDemotions)
    .set({ restoredAt: nowIso(opts) })
    .where(and(eq(botDemotions.id, id), isNull(botDemotions.restoredAt)))
    .returning()
    .get();
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
