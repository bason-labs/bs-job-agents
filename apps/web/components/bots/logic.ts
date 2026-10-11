// Bots screen rules (§5.3 trust levels, UC-19 promotion, §4.4/§6.2 engine locks, PM S21/S25).
import { canPromote, maxTrustLevel, type BotView, type Engine, type TrustLevel } from "@bs-job-agents/shared";

/** §5.3 automatic demotion, when the API reports it (additive API need, see data.ts). */
export interface Demotion {
  fromLevel: TrustLevel;
  at: string;
  reason: string;
}

/** BotView plus the optional demotion record (the W3a API does not send one yet). */
export type BotScreenView = BotView & { demotion?: Demotion | null };

/** §5.3 trust levels, addressed to Ba (shared TRUST_LEVEL_MEANINGS speak about him). */
export const TRUST_MEANINGS: Record<TrustLevel, string> = {
  0: "Draft only; every output needs your acceptance",
  1: "Acts, but every outward-facing action needs your approval",
  2: "Acts on its own within its allowed tools",
};

export const ENGINE_LABELS: Record<Engine, string> = { claude: "Claude", codex: "Codex" };
export const ENGINE_OPTIONS = (["claude", "codex"] as const).map((value) => ({ value, label: ENGINE_LABELS[value] }));

/**
 * Bots whose engine switch is disabled, and why (§4.4: a browser bot that writes runs on
 * Claude, where the site allowlist is a hook; §6.2: the Figma guard is a Claude hook).
 */
const ENGINE_LOCKS: Record<string, string> = {
  apply: "Locked to Claude: Apply fills forms in your Chrome, and its site allowlist runs only on Claude.",
  cv: "Locked to Claude: CV edits Figma; its Drafts-only guard runs only on Claude.",
};

export function engineLockReason(botName: string): string | null {
  return ENGINE_LOCKS[botName] ?? null;
}

/** "System suggests promoting Apply to L2 (10 approved in a row without edits)." (prototype) */
export function promotionText(bot: Pick<BotScreenView, "displayName" | "trustLevel" | "trackRecord">): string {
  const record = bot.trackRecord ? ` (${bot.trackRecord})` : "";
  return `System suggests promoting ${bot.displayName} to L${Math.min(2, bot.trustLevel + 1)}${record}.`;
}

export interface PromoteAction {
  allowed: boolean;
  label: string;
  reason: string | null;
  to: TrustLevel;
}

/** The suggestion card's button: only Ba promotes, and never Apply in Phase 1 (UC-19). */
export function promoteAction(bot: Pick<BotScreenView, "name" | "displayName" | "trustLevel" | "promoteAllowed">): PromoteAction {
  const to = Math.min(2, bot.trustLevel + 1) as TrustLevel;
  const check = canPromote(bot.name, bot.trustLevel);
  if (!check.allowed || !bot.promoteAllowed) {
    const label = bot.name === "apply" ? `Promote (disabled in Phase 1 for ${bot.displayName})` : `Promote to L${to}`;
    return { allowed: false, label, reason: check.reason ?? "Promotion isn't available for this bot", to };
  }
  return { allowed: true, label: `Promote to L${to}`, reason: null, to };
}

/** The level "Restore" goes back to: one level up, not above the demotion or the Phase 1 cap. */
export function restoreTarget(bot: Pick<BotScreenView, "name" | "trustLevel" | "demotion">): TrustLevel | null {
  if (!bot.demotion) return null;
  const to = Math.min(bot.trustLevel + 1, bot.demotion.fromLevel, maxTrustLevel(bot.name));
  return to > bot.trustLevel ? (to as TrustLevel) : null;
}

/**
 * The W3a API's trust rule (PATCH /bots/:name): a level rises one step at a time, up to the
 * Phase 1 cap (`promoteAllowed` = below the cap; Apply stays L1), and may always go down.
 */
export function raiseTarget(bot: Pick<BotScreenView, "trustLevel" | "promoteAllowed">): TrustLevel | null {
  return bot.promoteAllowed && bot.trustLevel < 2 ? ((bot.trustLevel + 1) as TrustLevel) : null;
}

export function lowerTarget(bot: Pick<BotScreenView, "trustLevel">): TrustLevel | null {
  return bot.trustLevel > 0 ? ((bot.trustLevel - 1) as TrustLevel) : null;
}

/** §5.2: QA is deliberately on a different engine from CV. */
export function qaEngineWarning(bots: readonly Pick<BotScreenView, "name" | "engine">[]): string | null {
  const qa = bots.find((b) => b.name === "qa");
  const cv = bots.find((b) => b.name === "cv");
  if (!qa || !cv || qa.engine !== cv.engine) return null;
  return `QA checks CV's work, so it should run on a different engine from CV (both are on ${ENGINE_LABELS[qa.engine]} now).`;
}
