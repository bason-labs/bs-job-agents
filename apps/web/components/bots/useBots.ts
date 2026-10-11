"use client";

import type { BotUpdateRequest, Engine, TrustLevel } from "@bs-job-agents/shared";
import { useState } from "react";
import { useToast } from "@/components/ui";
import { errorText } from "@/components/schedules/apiError";
import type { BotsData } from "./data";
import { ENGINE_LABELS, engineSwitchRisk, type BotScreenView } from "./logic";

export interface MemoryNote {
  id: string;
  text: string;
}

/** A trust change waiting for Ba's confirmation (raising or lowering a level). */
export interface PendingTrust {
  bot: BotScreenView;
  to: TrustLevel;
  /** promote = accepting the system's suggestion (UC-19). */
  kind: "promote" | "raise" | "lower";
}

/** An engine switch waiting for Ba to accept its risk (CV to Codex, owner decision 2026-10-11). */
export interface PendingEngine {
  bot: BotScreenView;
  engine: Engine;
  /** What Ba accepts, in plain words (engineSwitchRisk). */
  risk: string;
}

const TRUST_VERB ={ promote: "promoted", raise: "raised", lower: "lowered" } as const;

/** State and actions shared by the Bots grid and a bot's settings page. */
export function useBots(initial: BotScreenView[], data: BotsData) {
  const [bots, setBots] = useState(initial);
  const [seen, setSeen] = useState(initial);
  if (seen !== initial) {
    // A live re-read (bot.updated from another tab, the engine's demotion or activity).
    setSeen(initial);
    setBots(initial);
  }
  const [pendingMemory, setPendingMemory] = useState<{ bot: BotScreenView; note: MemoryNote } | null>(null);
  const [pendingTrust, setPendingTrust] = useState<PendingTrust | null>(null);
  const [pendingEngine, setPendingEngine] = useState<PendingEngine | null>(null);
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

  const switchEngine = (bot: BotScreenView, engine: Engine, acknowledgeRisk: boolean) =>
    update(bot, acknowledgeRisk ? { engine, acknowledgeRisk } : { engine }, (b) => `${b.displayName} now runs on ${ENGINE_LABELS[b.engine]}. Queued tasks keep their engine.`);

  return {
    bots,
    pendingMemory,
    pendingTrust,
    pendingEngine,
    /** A switch with a risk (CV to Codex) waits for Ba's confirmation; the others save at once. */
    setEngine: (bot: BotScreenView, engine: Engine) => {
      const risk = engineSwitchRisk(bot.name, engine);
      if (risk) {
        setPendingEngine({ bot, engine, risk });
        return Promise.resolve();
      }
      return switchEngine(bot, engine, false);
    },
    cancelEngine: () => setPendingEngine(null),
    /** Owner decision 2026-10-11: Ba accepted the risk, so the request carries acknowledgeRisk. */
    confirmEngine: async () => {
      if (!pendingEngine) return;
      const { bot, engine } = pendingEngine;
      setPendingEngine(null);
      await switchEngine(bot, engine, true);
    },
    /** Live run 1: Ba's model for this bot (null = bot.json's default). */
    setModel: (bot: BotScreenView, model: string | null) =>
      update(bot, { model }, (b) => (model === null ? `${b.displayName} uses the default model again` : `${b.displayName} now uses ${b.model ?? model}`)),
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
    askDeleteMemory: (bot: BotScreenView, note: MemoryNote) => setPendingMemory({ bot, note }),
    cancelDeleteMemory: () => setPendingMemory(null),
    confirmDeleteMemory: async () => {
      if (!pendingMemory) return;
      const { bot, note } = pendingMemory;
      setPendingMemory(null);
      try {
        put(await data.deleteMemoryNote(bot.name, note.id));
        toast({ title: `Deleted a memory note from ${bot.displayName}` });
      } catch (e) {
        toast({ title: `Couldn't delete the note: ${errorText(e)}`, tone: "err" });
      }
    },
  };
}

export type BotsController = ReturnType<typeof useBots>;
