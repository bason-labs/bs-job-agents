// Data access for the Bots screen and bot settings (§11 Bots, UC-19, §5.3, §5.4).
//
// Screens import `botsData` from here and nothing else, so wiring the real API is a one-line
// change: replace the fixture implementation below with an adapter over lib/api (W3b's typed
// client). Shapes are the shared API schemas.
//   GET   /bots         → BotsResponseSchema (BotView[])
//   GET   /bots/:name   → BotView; 404 → null here
//   PATCH /bots/:name   → body BotUpdateRequestSchema (engine, enabled, trustLevel) → BotView.
//                         403 for Apply/CV on Codex (checkBotSafety) and for a trust level that
//                         rises more than one step or above the Phase 1 cap; lowering is allowed.
// Additive API needs (handoff): BotView.demotion ({ fromLevel, at, reason } | null, §5.3);
// DELETE /bots/:name/memory (one note, PM S14); POST /bots/:name/promotion/dismiss (UC-19).
import { BotUpdateRequestSchema, maxTrustLevel, type BotUpdateRequest } from "@bs-job-agents/shared";
import { FixtureApiError } from "@/components/schedules/apiError";
import { BOT_VIEWS } from "./fixtures";
import { engineLockReason, type BotScreenView } from "./logic";

export interface BotsData {
  list(): Promise<BotScreenView[]>;
  get(name: string): Promise<BotScreenView | null>;
  /** Engine switch, enable, or a trust level one step up (promote / restore) or any step down. */
  update(name: string, body: BotUpdateRequest): Promise<BotScreenView>;
  /** Removes one memory note (PM S14: a poisoned note reaches every later prompt). */
  deleteMemoryNote(name: string, note: string): Promise<BotScreenView>;
  /** Hides a promotion suggestion (UC-19: Ba accepts or dismisses). */
  dismissPromotion(name: string): Promise<BotScreenView>;
}

/** The API's trust rule (W3a routes/bots.ts trustRefusal). */
function trustRefusal(name: string, from: number, to: number): string | null {
  if (to <= from) return null;
  const cap = maxTrustLevel(name);
  if (to > cap) return name === "apply" ? "Apply stays at L1 in Phase 1: every submit needs Ba's approval (UC-19)" : `${name} may be at most L${cap} in Phase 1`;
  if (to > from + 1) return `raise ${name}'s trust level one step at a time (L${from} → L${from + 1})`;
  return null;
}

/** In-memory stand-in seeded from the fixtures; it refuses what the API refuses (PM S21). */
export function createFixtureBotsData(seed: BotScreenView[] = BOT_VIEWS): BotsData {
  const bots = new Map(structuredClone(seed).map((b) => [b.name, b]));
  const find = (name: string) => {
    const b = bots.get(name);
    if (!b) throw new FixtureApiError(404, "not_found", `bot ${name} not found`);
    return b;
  };

  return {
    async list() {
      return structuredClone([...bots.values()]);
    },
    async get(name) {
      const b = bots.get(name);
      return b ? structuredClone(b) : null;
    },
    async update(name, body) {
      const req = BotUpdateRequestSchema.parse(body);
      const bot = find(name);
      const lock = engineLockReason(name);
      if (req.engine && req.engine !== bot.engine && lock) throw new FixtureApiError(403, "forbidden", lock);
      if (req.trustLevel !== undefined) {
        const refusal = trustRefusal(name, bot.trustLevel, req.trustLevel);
        if (refusal) throw new FixtureApiError(403, "forbidden", refusal);
        if (req.trustLevel > bot.trustLevel) {
          bot.promotionSuggested = false;
          if (bot.demotion && req.trustLevel >= bot.demotion.fromLevel) bot.demotion = null;
        }
        bot.trustLevel = req.trustLevel;
        bot.promoteAllowed = bot.trustLevel < maxTrustLevel(name);
      }
      if (req.engine) bot.engine = req.engine;
      if (req.enabled !== undefined) bot.enabled = req.enabled;
      return structuredClone(bot);
    },
    async deleteMemoryNote(name, note) {
      const bot = find(name);
      bot.memory = bot.memory.filter((m) => m !== note);
      return structuredClone(bot);
    },
    async dismissPromotion(name) {
      const bot = find(name);
      bot.promotionSuggested = false;
      return structuredClone(bot);
    },
  };
}

export const botsData: BotsData = createFixtureBotsData();
