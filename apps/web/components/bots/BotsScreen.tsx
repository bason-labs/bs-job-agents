"use client";

import Link from "next/link";
import { ConfirmDialog } from "@/components/ui";
import { BotCard } from "./BotCard";
import { botsData, type BotsData } from "./data";
import { TRUST_MEANINGS, qaEngineWarning, type BotScreenView } from "./logic";
import { useBots, type BotsController } from "./useBots";

export interface BotsScreenProps {
  initial: BotScreenView[];
  /** Show only this bot, as its settings page (/bots/[name]). */
  only?: string;
  /** Defaults to the app's data source; tests pass their own. */
  data?: BotsData;
}

function MemoryConfirm({ controller }: { controller: BotsController }) {
  const pending = controller.pendingMemory;
  return (
    <ConfirmDialog
      open={pending !== null}
      onOpenChange={(open) => !open && controller.cancelDeleteMemory()}
      title={pending ? `Delete this note from ${pending.bot.displayName}'s memory?` : ""}
      description={pending ? `“${pending.note}” — ${pending.bot.displayName} stops using it in its prompts. The change is logged.` : undefined}
      confirmLabel="Delete note"
      onConfirm={() => void controller.confirmDeleteMemory()}
    />
  );
}

function TrustConfirm({ controller }: { controller: BotsController }) {
  const p = controller.pendingTrust;
  const up = p ? p.kind !== "lower" : true;
  const stopsApply = p?.bot.name === "apply" && p.to === 0;
  return (
    <ConfirmDialog
      open={p !== null}
      onOpenChange={(open) => !open && controller.cancelTrust()}
      tone={up ? "brand" : "danger"}
      title={p ? `${up ? (p.kind === "promote" ? "Promote" : "Raise") : "Lower"} ${p.bot.displayName} to L${p.to}?` : ""}
      description={
        p
          ? `L${p.to}: ${TRUST_MEANINGS[p.to]}.${up ? " Only raise a bot whose work you have checked." : ""}${stopsApply ? " Every Apply task is refused until you raise it again." : ""}`
          : undefined
      }
      confirmLabel={p ? `${up ? (p.kind === "promote" ? "Promote" : "Raise") : "Lower"} to L${p.to}` : ""}
      onConfirm={() => void controller.confirmTrust()}
    />
  );
}

/** §11 Bots: one card per bot in a two-column grid, or one bot's settings page. */
export function BotsScreen({ initial, only, data = botsData }: BotsScreenProps) {
  const controller = useBots(initial, data);
  const warning = qaEngineWarning(controller.bots);
  const shown = only ? controller.bots.filter((b) => b.name === only) : controller.bots;

  return (
    <>
      {only ? (
        <div className="space-y-3">
          <Link href="/bots" className="text-xs text-accent hover:underline">
            ← All bots
          </Link>
          {shown.map((bot) => (
            <BotCard key={bot.name} bot={bot} controller={controller} warning={bot.name === "qa" ? warning : null} detailed />
          ))}
        </div>
      ) : (
        <div data-testid="bots-grid" className="grid content-start gap-4 md:grid-cols-2">
          {shown.map((bot) => (
            <BotCard key={bot.name} bot={bot} controller={controller} warning={bot.name === "qa" ? warning : null} />
          ))}
        </div>
      )}
      <MemoryConfirm controller={controller} />
      <TrustConfirm controller={controller} />
    </>
  );
}
