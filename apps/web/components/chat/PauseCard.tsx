"use client";

import { parsePauseReason, type MessageCard } from "@bs-job-agents/shared";
import { Check, ExternalLink, Frame, Globe, KeyRound, PauseCircle, ShieldQuestion } from "lucide-react";
import { useState, type ReactNode } from "react";
import { errorMessage } from "@/lib/api/errors";
import { useApi } from "@/lib/api/react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { botDisplay, useChat } from "./ChatContext";
import { pauseCopy } from "./model";

type PauseCardData = Extract<MessageCard, { type: "pause" }>;

const ICONS: Record<string, ReactNode> = {
  needs_login: <KeyRound aria-hidden className="size-3.5" />,
  captcha: <ShieldQuestion aria-hidden className="size-3.5" />,
  domain_confirm: <ExternalLink aria-hidden className="size-3.5" />,
  needs_figma: <Frame aria-hidden className="size-3.5" />,
  needs_browser: <Globe aria-hidden className="size-3.5" />,
};

/** Whose task paused, when no event named it yet. */
const BOT_BY_REASON: Record<string, string> = { domain_confirm: "apply", needs_figma: "cv" };

/**
 * UC-17 pause card (login, CAPTCHA, Figma, Chrome) and UC-11 e's domain confirm. Done calls
 * POST /tasks/:id/resume; a domain confirm sends the host it shows (PM S24 copy).
 */
export function PauseCard({ card }: { card: PauseCardData }) {
  const api = useApi();
  const { bots, taskPhase, taskBot } = useChat();
  const code = parsePauseReason(card.reason)?.code ?? "";
  const botName = taskBot(card.taskId) ?? BOT_BY_REASON[code];
  const copy = pauseCopy(card.reason, botName ? botDisplay(bots, botName) : null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [declined, setDeclined] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const phase = taskPhase(card.taskId);
  const state = declined ? "declined" : done || phase === "running" ? "resumed" : phase === "ended" ? "ended" : "live";

  /** UC-11 e "Don't allow": Apply stops instead of filling the form on the other site. */
  const decline = async () => {
    setPending(true);
    setError(null);
    try {
      await api.declineDomain(card.taskId);
      setDeclined(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  const resume = async () => {
    if (!copy.action) return;
    setPending(true);
    setError(null);
    try {
      await api.resumeTask(card.taskId, { confirmDomain: copy.action.confirmDomain });
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      data-testid="pause-card"
      data-state={state}
      data-reason={code}
      className={cn("space-y-2 rounded-2xl border p-3", state === "live" ? "border-warn/40 bg-warn/5" : "border-border bg-surface-2/30")}
    >
      <p className={cn("flex items-center gap-1.5 text-xs", state === "live" ? "text-warn" : "text-muted")}>
        {ICONS[code] ?? <PauseCircle aria-hidden className="size-3.5" />}
        {copy.title}
      </p>
      {copy.host ? (
        <p data-testid="pause-host" className="font-mono text-base font-semibold break-all">
          {copy.host}
        </p>
      ) : null}
      <p className="text-sm leading-relaxed">{copy.body}</p>
      {state === "live" && copy.action ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" size="sm" pill loading={pending} onClick={() => void resume()}>
            {copy.action.label}
          </Button>
          {code === "domain_confirm" ? (
            <Button size="sm" pill disabled={pending} onClick={() => void decline()}>
              Don&apos;t allow
            </Button>
          ) : null}
        </div>
      ) : null}
      {state === "declined" ? (
        <p className="text-xs text-muted">Not allowed — Apply stopped{copy.host ? ` and won't continue on ${copy.host}` : ""}. Nothing was sent there.</p>
      ) : state === "resumed" ? (
        <p className="flex items-center gap-1.5 text-xs text-ok">
          <Check aria-hidden className="size-3.5" /> Resumed — {botName ? botDisplay(bots, botName) : "the bot"} picks up where it stopped.
        </p>
      ) : state === "ended" ? (
        <p className="text-xs text-muted">This task has ended.</p>
      ) : copy.note ? (
        <p className="text-xs text-muted">{copy.note}</p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
