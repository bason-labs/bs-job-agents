// Data access for the Bots screen and bot settings (§11 Bots, UC-19, §5.3, §5.4).
//
// Screens import `botsData` from here and nothing else, so wiring the real API is a one-line
// change: replace the fixture implementation below with an adapter over lib/api (W3b's typed
// client). Shapes are the shared API schemas.
//   GET   /bots         → BotsResponseSchema (BotView[])
//   GET   /bots/:name   → BotView
//   PATCH /bots/:name   → body BotUpdateRequestSchema (engine, enabled, trustLevel) → BotView
// Additive API needs (handoff): BotView.demotion ({ fromLevel, at, reason } | null, §5.3);
// DELETE /bots/:name/memory (one note, PM S14); POST /bots/:name/promotion/dismiss (UC-19).
import { BotUpdateRequestSchema, canPromote, isTrustLevelAllowed, type BotUpdateRequest } from "@bs-job-agents/shared";
import { BOT_VIEWS } from "./fixtures";
import { engineLockReason, restoreTarget, type BotScreenView } from "./logic";

export interface BotsData {
  list(): Promise<BotScreenView[]>;
  get(name: string): Promise<BotScreenView | null>;
  /** Engine switch, enable, promote (accepting a suggestion) or restore after a demotion. */
  update(name: string, body: BotUpdateRequest): Promise<BotScreenView>;
  /** Removes one memory note (PM S14: a poisoned note reaches every later prompt). */
  deleteMemoryNote(name: string, note: string): Promise<BotScreenView>;
  /** Hides a promotion suggestion (UC-19: Ba accepts or dismisses). */
  dismissPromotion(name: string): Promise<BotScreenView>;
}

/** In-memory stand-in seeded from the fixtures; it refuses what the API refuses (PM S21). */
export function createFixtureBotsData(seed: BotScreenView[] = BOT_VIEWS): BotsData {
  const bots = new Map(structuredClone(seed).map((b) => [b.name, b]));
  const find = (name: string) => {
    const b = bots.get(name);
    if (!b) throw new Error(`bot ${name} not found`);
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
      if (req.engine && req.engine !== bot.engine && engineLockReason(name)) throw new Error(engineLockReason(name)!);
      if (req.trustLevel !== undefined && req.trustLevel !== bot.trustLevel) {
        const to = req.trustLevel;
        if (!isTrustLevelAllowed(name, to)) throw new Error(`${bot.displayName} can't be at L${to} in Phase 1`);
        if (to > bot.trustLevel) {
          const restoring = restoreTarget(bot) === to;
          const promoting = bot.promotionSuggested && bot.promoteAllowed && canPromote(name, bot.trustLevel).allowed && to === bot.trustLevel + 1;
          if (!restoring && !promoting) throw new Error("only a system suggestion or a demotion restore can raise a trust level");
          if (bot.demotion && to >= bot.demotion.fromLevel) bot.demotion = null;
          if (promoting) bot.promotionSuggested = false;
        }
        bot.trustLevel = to;
        bot.promoteAllowed = canPromote(name, to).allowed;
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
