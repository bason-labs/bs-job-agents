"use client";

import type { BotUpdateRequest, Engine, TrustLevel } from "@bs-job-agents/shared";
import { useState } from "react";
import { useToast } from "@/components/ui";
import { errorText } from "@/components/schedules/apiError";
import type { BotsData } from "./data";
import { ENGINE_LABELS, type BotScreenView } from "./logic";

/** A trust change waiting for Ba's confirmation (raising or lowering a level). */
export interface PendingTrust {
  bot: BotScreenView;
  to: TrustLevel;
  /** promote = accepting the system's suggestion (UC-19). */
  kind: "promote" | "raise" | "lower";
}

const TRUST_VERB = { promote: "promoted", raise: "raised", lower: "lowered" } as const;

/** State and actions shared by the Bots grid and a bot's settings page. */
export function useBots(initial: BotScreenView[], data: BotsData) {
  const [bots, setBots] = useState(initial);
  const [pendingMemory, setPendingMemory] = useState<{ bot: BotScreenView; note: string } | null>(null);
  const [pendingTrust, setPendingTrust] = useState<PendingTrust | null>(null);
  const { toast } = useToast();

  const put = (bot: BotScreenView) => setBots((bs) => bs.map((b) => (b.name === bot.name ? bot : b)));

  const update = async (bot: BotScreenView, body: BotUpdateRequest, done: (saved: BotScreenView) => string) => {
    try {
      const saved = await data.update(bot.name, body);
      put(saved);
      toast({ title: done(saved) });
    } catch (e) {
      toast({ title: `Couldn't update ${bot.displayName}: ${errorText(e)}`, tone: "err" });
    }
  };

  return {
    bots,
    pendingMemory,
    pendingTrust,
    setEngine: (bot: BotScreenView, engine: Engine) =>
      update(bot, { engine }, (b) => `${b.displayName} now runs on ${ENGINE_LABELS[b.engine]}. Queued tasks keep their engine.`),
    setEnabled: (bot: BotScreenView, enabled: boolean) =>
      update(bot, { enabled }, (b) => (b.enabled ? `${b.displayName} enabled` : `${b.displayName} disabled — Lead won't assign it new tasks`)),
    /** Back to the level a demotion took away (§5.3); no confirmation needed. */
    restore: (bot: BotScreenView, to: TrustLevel) => update(bot, { trustLevel: to }, (b) => `${b.displayName} restored to L${b.trustLevel}`),
    askTrust: (bot: BotScreenView, to: TrustLevel, kind: PendingTrust["kind"]) => setPendingTrust({ bot, to, kind }),
    cancelTrust: () => setPendingTrust(null),
    confirmTrust: async () => {
      if (!pendingTrust) return;
      const { bot, to, kind } = pendingTrust;
      setPendingTrust(null);
      await update(bot, { trustLevel: to }, (b) => `${b.displayName} ${TRUST_VERB[kind]} to L${b.trustLevel}`);
    },
    dismissPromotion: async (bot: BotScreenView) => {
      try {
        put(await data.dismissPromotion(bot.name));
      } catch (e) {
        toast({ title: `Couldn't dismiss the suggestion: ${errorText(e)}`, tone: "err" });
      }
    },
    askDeleteMemory: (bot: BotScreenView, note: string) => setPendingMemory({ bot, note }),
    cancelDeleteMemory: () => setPendingMemory(null),
    confirmDeleteMemory: async () => {
      if (!pendingMemory) return;
      const { bot, note } = pendingMemory;
      setPendingMemory(null);
      try {
        put(await data.deleteMemoryNote(bot.name, note));
        toast({ title: `Deleted a memory note from ${bot.displayName}` });
      } catch (e) {
        toast({ title: `Couldn't delete the note: ${errorText(e)}`, tone: "err" });
      }
    },
  };
}

export type BotsController = ReturnType<typeof useBots>;
