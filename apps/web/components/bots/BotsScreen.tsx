"use client";

import Link from "next/link";
import { ResourceGate } from "@/components/schedules/ResourceGate";
import { ConfirmDialog, EmptyState } from "@/components/ui";
import { useLiveResource } from "@/lib/api/live-resource";
import { BotCard } from "./BotCard";
import { useBotsData, type BotsData } from "./data";
import { WorkflowProposals } from "./WorkflowProposals";
import { ENGINE_LABELS, TRUST_MEANINGS, qaEngineWarning, type BotScreenView } from "./logic";
import { useBots, type BotsController } from "./useBots";

export interface BotsScreenProps {
  /** The latest read; a newer one (a live re-read) replaces the cards. */
  initial: BotScreenView[];
  /** Show only this bot, as its settings page (/bots/[name]). */
  only?: string;
  data: BotsData;
}

/**
 * The pages (/bots and /bots/[name]): bots through lib/api, re-read on bot.updated (another tab,
 * the engine's demotion, activity). The grid also lists Lead's workflow proposals.
 */
export function BotsLive({ only }: { only?: string }) {
  const data = useBotsData();
  const bots = useLiveResource("w3c:bots", () => data.list(), { refreshOn: (e) => e.type === "bot.updated" });
  return (
    <ResourceGate resource={bots} label="bots">
      {(initial) =>
        only && !initial.some((b) => b.name === only) ? (
          <EmptyState
            title="Not found"
            description={`There is no bot named “${only}”. Phase 1 has Lead, Research, CV, QA and Apply.`}
            action={
              <Link href="/bots" className="text-sm text-accent hover:underline">
                ← All bots
              </Link>
            }
          />
        ) : (
          <>
            <BotsScreen initial={initial} only={only} data={data} />
            {only ? null : <WorkflowProposals data={data} />}
          </>
        )
      }
    </ResourceGate>
  );
}

function MemoryConfirm({ controller }: { controller: BotsController }) {
  const pending = controller.pendingMemory;
  return (
    <ConfirmDialog
      open={pending !== null}
      onOpenChange={(open) => !open && controller.cancelDeleteMemory()}
      title={pending ? `Delete this note from ${pending.bot.displayName}'s memory?` : ""}
      description={pending ? `“${pending.note.text}” —${pending.bot.displayName} stops using it in its prompts. The change is logged.` : undefined}
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

/** Owner decision 2026-10-11: CV on Codex is an opt-in Ba confirms in plain words. */
function EngineConfirm({ controller }: { controller: BotsController }) {
  const p = controller.pendingEngine;
  const label = p ? `Run ${p.bot.displayName} on ${ENGINE_LABELS[p.engine]}` : "";
  return (
    <ConfirmDialog
      open={p !== null}
      onOpenChange={(open) => !open && controller.cancelEngine()}
      tone="danger"
      title={p ? `${label}?` : ""}
      description={p?.risk}
      confirmLabel={label}
      onConfirm={() => void controller.confirmEngine()}
    />
  );
}

/** §11 Bots: one card per bot in a two-column grid, or one bot's settings page. */
export function BotsScreen({ initial, only, data }: BotsScreenProps) {
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
      <EngineConfirm controller={controller} />
    </>
  );
}
