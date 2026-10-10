"use client";

import type { BotUpdateRequest, Engine, TrustLevel } from "@bs-job-agents/shared";
import { useState } from "react";
import { useToast } from "@/components/ui";
import type { BotsData } from "./data";
import { ENGINE_LABELS, type BotScreenView } from "./logic";
import { errorText } from "@/components/schedules/apiError";

/** State and actions shared by the Bots grid and a bot's settings page. */
export function useBots(initial: BotScreenView[], data: BotsData) {
  const [bots, setBots] = useState(initial);
  const [pendingMemory, setPendingMemory] = useState<{ bot: BotScreenView; note: string } | null>(null);
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
    setEngine: (bot: BotScreenView, engine: Engine) =>
      update(bot, { engine }, (b) => `${b.displayName} now runs on ${ENGINE_LABELS[b.engine]}. Queued tasks keep their engine.`),
    setEnabled: (bot: BotScreenView, enabled: boolean) =>
      update(bot, { enabled }, (b) => (b.enabled ? `${b.displayName} enabled` : `${b.displayName} disabled — Lead won't assign it new tasks`)),
    promote: (bot: BotScreenView, to: TrustLevel) => update(bot, { trustLevel: to }, (b) => `${b.displayName} promoted to L${b.trustLevel}`),
    restore: (bot: BotScreenView, to: TrustLevel) => update(bot, { trustLevel: to }, (b) => `${b.displayName} restored to L${b.trustLevel}`),
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
