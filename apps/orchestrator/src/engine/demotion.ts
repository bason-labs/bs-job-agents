// §5.3 automatic demotion (PM2 S8, decision 2): one level down (never below L0), stored on
// bots.trust_level with a bot_demotions row, a bot.updated event and a Lead message with the
// reason. Triggers:
// - a safety violation by the bot's own conduct during a task: a site-guard block it did not turn
//   into a domain_confirm pause, a protected-page change attributable to the task, page_mismatch,
//   dry_run_submitted, a runtime permission denial (trust_level); a Figma-guard block only when the
//   protected pages could not be checked afterwards (protected_page_blocked);
// - for CV, a version that leaves the QA gate escalated with hard fails still present.
// Not triggers: the orchestrator's own refusals before a spawn (token, SHA-256, injection flag,
// bot disabled), the bot's own injection report, the after-run page check (PM2 S10), and (live
// run 1) a Figma-guard block after which the protected pages are verifiably unchanged: the block
// is prevention that worked, logged as figma_guard_blocked.
// One task demotes at most once. Ba restores on the Bots screen (updateBot closes the demotion),
// or, for a protected-page change, says it was his ("that was me": restore + retry the step).
import { demotionReasonLabel, maxTrustLevel, type MessageCard, type SafetyDenialReason, type TrustLevel } from "@bs-job-agents/shared";
import {
  closeBotDemotion,
  demotionsForTask,
  getBot,
  getOrCreateLeadRoom,
  getStep,
  getTask,
  latestBotDemotion,

  listMessages,
  recordBotDemotion,
  setMessageCards,
  syncBotFromDefinition,
  updateBot,
  type BotDemotion,
  type Conn,
} from "../db/index.js";
import { rerunStep } from "./control.js";
import type { EngineCore } from "./core.js";
import { invalidState, notFound } from "./errors.js";
import { postNotice } from "./notices.js";
import { isTerminalStep } from "./steps.js";


/**
 * Safety reasons that demote when they come from the bot's own conduct during a task.
 * `figma_guard_blocked` is deliberately absent (informational, F5).
 */
export const DEMOTING_SAFETY_REASONS: readonly SafetyDenialReason[] = [
  "off_allowlist",
  "protected_page_blocked",
  "protected_page_changed",
  "page_mismatch",
  "dry_run_submitted",
  "trust_level",
];

export type DemotionReason = SafetyDenialReason | "qa_hard_fail";

export interface DemoteInput {
  botName: string;
  reason: DemotionReason;
  detail: string | null;
  taskId: number | null;
  runId: number | null;
  /** The caller posts its own Lead message (the protected-page alert with Ba's choice). */
  silent?: boolean;
}

export const FIGMA_CHANGE_CHOICE = (taskId: number): MessageCard => ({
  type: "choice",
  key: `figma-change:${taskId}`,
  options: [{ id: "was_me", label: "That was me — retry" }],
  chosen: null,
});

/** bot.updated after the engine changed a bot's level. */
export function emitBotUpdated(core: EngineCore, conn: Conn, botName: string): void {
  const row = getBot(conn, botName);
  if (!row) return;
  core.bus.emit(conn, {
    type: "bot.updated",
    botName,
    engine: row.engine,
    trustLevel: row.trustLevel as TrustLevel,
    enabled: row.enabled,
    activity: "idle",
    promotionSuggested: false,
  });
}

const displayName = (core: EngineCore, botName: string): string => core.deps.bots.get(botName)?.displayName ?? botName;

/** Demote one level, inside `conn`'s transaction. Null when nothing changed (already L0, or this task already demoted). */
export function demoteBot(core: EngineCore, conn: Conn, input: DemoteInput): BotDemotion | null {
  if (input.taskId !== null && demotionsForTask(conn, input.taskId).length > 0) return null;
  let row = getBot(conn, input.botName);
  const def = core.deps.bots.get(input.botName);
  if (!row && def) {
    row = syncBotFromDefinition(conn, { name: def.name, displayName: def.displayName, engine: def.engine, trustLevel: def.trustLevel, model: def.model, promptVersion: def.promptVersion, enabled: def.enabled });
  }
  if (!row || row.trustLevel <= 0) return null;
  const from = row.trustLevel;
  const to = from - 1;
  updateBot(conn, input.botName, { trustLevel: to as TrustLevel });
  const demotion = recordBotDemotion(
    conn,
    { botName: input.botName, fromLevel: from, toLevel: to, reason: input.reason, detail: input.detail, taskId: input.taskId, runId: input.runId },
    { now: core.now() },
  );
  emitBotUpdated(core, conn, input.botName);
  if (!input.silent) {
    const name = displayName(core, input.botName);
    const stop = input.botName === "apply" && to === 0 ? " Apply will not run until you restore it." : "";
    postNotice(core, conn, {
      text: `I moved ${name} from L${from} to L${to} after ${demotionReasonLabel(input.reason)}${input.detail ? `: ${input.detail}` : ""}.${stop} You can restore it on the Bots screen.`,
      runId: input.runId,
    });
  }
  return demotion;
}

/**
 * §6.2 + S8: a protected Figma page changed during (or since) a CV task. Lead alerts Ba; when the
 * bot was demoted for it, the message says so and offers "That was me — retry" (choice card
 * `figma-change:<taskId>`, answered through Engine.protectedChangeWasBa).
 */
export function postProtectedChangeAlert(core: EngineCore, conn: Conn, task: { id: number; botName: string; runId: number | null }, lead: string, demoted: BotDemotion | null): void {
  const restore = "Please check the file and restore the page from Figma's version history.";
  const level = demoted
    ? ` I moved ${displayName(core, task.botName)} from L${demoted.fromLevel} to L${demoted.toLevel}; if the change was yours, choose “That was me — retry”.`
    : "";
  postNotice(core, conn, { text: `${lead.trim()} ${restore}${level}`, runId: task.runId, ...(demoted ? { cards: [FIGMA_CHANGE_CHOICE(task.id)] } : {}) });
}

/** Ba restores a demoted bot one level (Bots screen); capped at the Phase 1 limit (Apply: L1). */
export function restoreBot(core: EngineCore, botName: string): void {
  core.db.transaction((tx) => {
    const demotion = latestBotDemotion(tx, botName);
    if (!demotion) throw invalidState(`${botName} has no demotion to restore`);
    const level = Math.min(demotion.fromLevel, maxTrustLevel(botName)) as TrustLevel;
    updateBot(tx, botName, { trustLevel: level });
    closeBotDemotion(tx, demotion.id, { now: core.now() });
    emitBotUpdated(core, tx, botName);
  });
  core.bus.flush();
}

/**
 * "That was me" (S8): Ba changed the protected page during the CV task himself. The task's
 * demotion is undone and the failed step runs again (a new CV task, with a new "before" fingerprint).
 */
export function protectedChangeWasBa(core: EngineCore, taskId: number): { retried: boolean } {
  const stepId = core.db.transaction((tx) => {
    const task = getTask(tx, taskId);
    if (!task) throw notFound("task", taskId);
    const demotion = demotionsForTask(tx, taskId).find((d) => d.reason === "protected_page_changed" && d.restoredAt === null);
    if (!demotion) throw invalidState(`task ${taskId} has no open demotion for a protected-page change`);
    closeBotDemotion(tx, demotion.id, { now: core.now() });
    const current = getBot(tx, demotion.botName)?.trustLevel ?? demotion.toLevel;
    // Only this demotion's level comes back; a later demotion of the same bot stays.
    const level = Math.min(current + 1, demotion.fromLevel, maxTrustLevel(demotion.botName));
    if (level > current) updateBot(tx, demotion.botName, { trustLevel: level as TrustLevel });
    emitBotUpdated(core, tx, demotion.botName);
    chooseFigmaCard(core, tx, taskId);
    return task.stepId;
  });
  core.bus.flush();
  if (stepId === null) return { retried: false };
  const step = getStep(core.db, stepId);
  if (!step || !isTerminalStep(step)) return { retried: false };
  try {
    rerunStep(core, stepId);
    return { retried: true };
  } catch {
    return { retried: false };
  }
}

function chooseFigmaCard(core: EngineCore, conn: Conn, taskId: number): void {
  const room = getOrCreateLeadRoom(conn, { now: core.now() });
  const key = `figma-change:${taskId}`;
  for (const message of listMessages(conn, room.id)) {
    const cards = (message.meta?.cards as Array<Record<string, unknown>> | undefined) ?? [];
    if (!cards.some((c) => c.type === "choice" && c.key === key)) continue;
    setMessageCards(conn, message.id, cards.map((c) => (c.type === "choice" && c.key === key ? { ...c, chosen: "was_me" } : c)));
  }
}
