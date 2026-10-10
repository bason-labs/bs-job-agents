"use client";

import type { TrustLevel } from "@bs-job-agents/shared";
import { ChevronDown, Lightbulb, Lock, Settings, ShieldAlert, Trash2, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { Badge, BotAvatar, Button, IconButton, Switch, Tooltip, TRUST_DESCRIPTIONS } from "@/components/ui";
import { cn } from "@/lib/cn";
import { botChatHref, botSettingsHref } from "@/lib/routes";
import { formatDateTime } from "@/components/schedules/datetime";
import { Segmented } from "@/components/schedules/Segmented";
import {
  ENGINE_OPTIONS,
  TRUST_MEANINGS,
  engineLockReason,
  lowerTarget,
  promoteAction,
  promotionText,
  raiseTarget,
  restoreTarget,
  type BotScreenView,
} from "./logic";
import type { BotsController } from "./useBots";

const TRUST_TONE = { 0: "danger", 1: "warn", 2: "ok" } as const;

function TrustLevelBadge({ level }: { level: TrustLevel }) {
  return (
    <Tooltip content={TRUST_DESCRIPTIONS[level]}>
      <span role="img" tabIndex={0} aria-label={`Trust level L${level}: ${TRUST_MEANINGS[level]}`} data-testid="bot-trust" className="rounded-full">
        <Badge tone={TRUST_TONE[level]} className="px-2 text-xs">
          L{level}
        </Badge>
      </span>
    </Tooltip>
  );
}

export interface BotCardProps {
  bot: BotScreenView;
  controller: BotsController;
  /** §5.2 warning when QA and CV share an engine (shown on QA's card). */
  warning?: string | null;
  /** The settings page: enable switch, trust ladder, model, memory open. */
  detailed?: boolean;
}

/** One bot (prototype Bots card): role, engine switch, trust, track record, promotion, memory. */
export function BotCard({ bot, controller, warning, detailed = false }: BotCardProps) {
  const [memoryOpen, setMemoryOpen] = useState(detailed);
  const ids = { engine: useId(), lock: useId(), memory: useId() };
  const lock = engineLockReason(bot.name);
  const promote = promoteAction(bot);
  const restoreTo = restoreTarget(bot);
  const raiseTo = raiseTarget(bot);
  const lowerTo = lowerTarget(bot);

  return (
    <article data-testid={`bot-card-${bot.name}`} aria-labelledby={`${ids.engine}-name`} className="space-y-3 rounded-3xl border border-border bg-surface/60 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <BotAvatar name={bot.displayName} lead={bot.name === "lead"} size="lg" />
          <div className="min-w-0">
            <h2 id={`${ids.engine}-name`} className="font-display font-semibold">
              {bot.displayName}
              {!bot.enabled ? <span className="ml-2 text-xs font-normal text-muted">disabled</span> : null}
            </h2>
            <p className="text-xs text-muted">{bot.role}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <TrustLevelBadge level={bot.trustLevel} />
          {detailed ? null : (
            <Link href={botSettingsHref(bot.name)} aria-label={`${bot.displayName} settings`} title="Bot settings" className="grid size-7 place-items-center rounded-xl text-muted transition hover:bg-surface-2 hover:text-fg">
              <Settings aria-hidden className="size-3.5" />
            </Link>
          )}
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center gap-2 text-xs">
          <span id={ids.engine} className="text-muted">
            Engine
          </span>
          <Segmented
            variant="pill"
            options={ENGINE_OPTIONS}
            value={bot.engine}
            onValueChange={(engine) => void controller.setEngine(bot, engine)}
            disabled={!!lock}
            aria-labelledby={ids.engine}
            aria-describedby={lock ? ids.lock : undefined}
            data-testid="bot-engine"
          />
          <span className="ml-auto text-muted" data-testid="bot-prompt-version">
            prompt v{bot.promptVersion}
          </span>
        </div>
        {lock ? (
          <p id={ids.lock} data-testid="bot-engine-lock" className="flex items-start gap-1.5 text-[11px] text-muted">
            <Lock aria-hidden className="mt-0.5 size-3 shrink-0" />
            {lock}
          </p>
        ) : null}
        {warning ? (
          <p data-testid="bot-engine-warning" className="flex items-start gap-1.5 text-[11px] text-warn">
            <TriangleAlert aria-hidden className="mt-0.5 size-3 shrink-0" />
            {warning}
          </p>
        ) : null}
      </div>

      <p className="text-xs text-muted">Track record: {bot.trackRecord ?? "—"}</p>

      {bot.promotionSuggested ? (
        <div data-testid="bot-promotion" className="space-y-2 rounded-xl border border-accent/40 bg-accent/5 p-3 text-xs">
          <p className="flex items-start gap-1.5">
            <Lightbulb aria-hidden className="mt-0.5 size-3.5 shrink-0 text-accent" />
            <span>{promotionText(bot)}</span>
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" pill variant={promote.allowed ? "primary" : "secondary"} disabled={!promote.allowed} title={promote.reason ?? undefined} onClick={() => controller.askTrust(bot, promote.to, "promote")}>
              {promote.label}
            </Button>
            <Button size="sm" pill variant="ghost" onClick={() => void controller.dismissPromotion(bot)}>
              Dismiss
            </Button>
          </div>
          {promote.reason && !promote.allowed ? <p className="text-[11px] text-muted">{promote.reason}. Only you can promote a bot, and Apply keeps asking for your approval on every submit.</p> : null}
        </div>
      ) : null}

      {bot.demotion ? (
        <div data-testid="bot-demotion" className="space-y-2 rounded-xl border border-warn/40 bg-warn/10 p-3 text-xs text-warn">
          <p className="flex items-start gap-1.5">
            <ShieldAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            <span>
              Demoted from L{bot.demotion.fromLevel} to L{bot.trustLevel} on {formatDateTime(bot.demotion.at)}: {bot.demotion.reason}.
            </span>
          </p>
          {restoreTo !== null ? (
            <Button size="sm" pill onClick={() => void controller.restore(bot, restoreTo)}>
              Restore to L{restoreTo}
            </Button>
          ) : null}
        </div>
      ) : null}

      {bot.residualRisk ? (
        <p data-testid="bot-residual-risk" className="flex items-start gap-1.5 rounded-xl border border-border bg-surface-2/50 p-3 text-[11px] text-muted">
          <TriangleAlert aria-hidden className="mt-0.5 size-3 shrink-0 text-warn" />
          <span>{bot.residualRisk}</span>
        </p>
      ) : null}

      {detailed ? (
        <div className="space-y-3 border-t border-border/60 pt-3">
          <Switch
            checked={bot.enabled}
            onCheckedChange={(on) => void controller.setEnabled(bot, on)}
            label={<span className="text-xs">Enabled — when off, Lead doesn&apos;t assign it new tasks</span>}
          />
          <p className="text-xs text-muted">Model: {bot.model ?? "the CLI's default for your subscription"}</p>
          <div className="space-y-1">
            <p className="text-xs font-medium">Trust levels</p>
            <ol className="space-y-1 text-xs" aria-label="Trust levels">
              {([0, 1, 2] as const).map((level) => (
                <li
                  key={level}
                  aria-current={level === bot.trustLevel ? "true" : undefined}
                  className={cn("flex gap-2 rounded-lg px-3 py-1.5", level === bot.trustLevel ? "bg-surface-2 text-fg" : "text-muted")}
                >
                  <b className="w-6 shrink-0">L{level}</b>
                  <span>{TRUST_MEANINGS[level]}</span>
                </li>
              ))}
            </ol>
            <div data-testid="bot-trust-actions" className="flex flex-wrap items-center gap-2 pt-1">
              {raiseTo !== null ? (
                <Button size="sm" pill onClick={() => controller.askTrust(bot, raiseTo, "raise")}>
                  Raise to L{raiseTo}
                </Button>
              ) : null}
              {lowerTo !== null ? (
                <Button size="sm" pill variant="ghost" onClick={() => controller.askTrust(bot, lowerTo, "lower")}>
                  Lower to L{lowerTo}
                </Button>
              ) : null}
              {raiseTo === null && bot.trustLevel < 2 ? (
                <span className="text-[11px] text-muted">
                  {bot.name === "apply" ? "Apply stays at L1 in Phase 1: every submit needs your approval." : `L${bot.trustLevel} is the highest level for ${bot.displayName} in Phase 1.`}
                </span>
              ) : null}
            </div>
            <p className="text-[11px] text-muted">
              The system suggests a promotion after 10 tasks accepted in a row without changes; only you raise a level, one step at a time. A safety violation lowers a bot one level automatically.
            </p>
          </div>
        </div>
      ) : null}

      <div className="text-xs">
        <button
          type="button"
          aria-expanded={memoryOpen}
          aria-controls={ids.memory}
          onClick={() => setMemoryOpen((o) => !o)}
          className="flex items-center gap-1 text-muted hover:text-fg"
        >
          <ChevronDown aria-hidden className={cn("size-3.5 transition-transform", memoryOpen ? "rotate-0" : "-rotate-90")} />
          Memory ({bot.memory.length} {bot.memory.length === 1 ? "note" : "notes"})
        </button>
        {memoryOpen ? (
          <ul id={ids.memory} data-testid="bot-memory" className="mt-2 space-y-1">
            {bot.memory.length === 0 ? <li className="text-muted italic">No notes yet.</li> : null}
            {bot.memory.map((note) => (
              <li key={note} className="group flex items-start justify-between gap-2 rounded-lg px-2 py-1 hover:bg-surface-2/60">
                <span>{note}</span>
                <IconButton size="sm" label={`Delete memory note: ${note}`} icon={<Trash2 aria-hidden />} onClick={() => controller.askDeleteMemory(bot, note)} className="hover:text-danger" />
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {detailed ? (
        <Link href={botChatHref(bot.name)} className="inline-block text-xs text-accent hover:underline">
          Chat with {bot.displayName} →
        </Link>
      ) : null}
    </article>
  );
}
