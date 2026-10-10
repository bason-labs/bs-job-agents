"use client";

import type { Message, MessageCard } from "@bs-job-agents/shared";
import { ArrowRight, Check, CircleHelp, Inbox } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { errorMessage } from "@/lib/api/errors";
import { useReviewQueue } from "@/lib/api/hooks";
import { useApi } from "@/lib/api/react";
import { botChatHref } from "@/lib/routes";
import { cn } from "@/lib/cn";
import { Button, buttonClass } from "@/components/ui/Button";
import { botDisplay, useChat } from "./ChatContext";
import { PauseCard } from "./PauseCard";
import { QuestionCard } from "./QuestionCard";
import { RunCard } from "./RunCard";

type Card<T extends MessageCard["type"]> = Extract<MessageCard, { type: T }>;

/** UC-21b a: "Just this run" / "Save to my criteria" and other chip choices. */
function ChoiceCard({ message, card }: { message: Message; card: Card<"choice"> }) {
  const api = useApi();
  const [chosen, setChosen] = useState(card.chosen);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (chosen) {
    const label = card.options.find((o) => o.id === chosen)?.label ?? chosen;
    return (
      <p data-testid="choice-card" className="flex items-center gap-1.5 text-xs text-muted">
        <Check aria-hidden className="size-3.5 text-ok" /> You chose “{label}”.
      </p>
    );
  }
  const choose = async (optionId: string) => {
    setPending(optionId);
    setError(null);
    try {
      await api.chooseOption({ messageId: message.id, key: card.key, optionId });
      setChosen(optionId);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(null);
    }
  };
  return (
    <div data-testid="choice-card" className="space-y-1">
      <div className="flex flex-wrap gap-2">
        {card.options.map((o, i) => (
          <Button
            key={o.id}
            size="sm"
            pill
            variant={i === card.options.length - 1 ? "primary" : "secondary"}
            loading={pending === o.id}
            disabled={pending !== null}
            onClick={() => void choose(o.id)}
          >
            {o.label}
          </Button>
        ))}
      </div>
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** UC-25 a: in a consult chat, the way to Lead; in the Lead chat, where the request came from. */
function HandoffCard({ card }: { card: Card<"handoff"> }) {
  const { room, bots } = useChat();
  if (room.kind === "lead") {
    return (
      <p data-testid="handoff-card" className="text-xs text-muted">
        From{" "}
        <Link href={botChatHref(card.fromBot)} className="text-accent hover:underline">
          @{botDisplay(bots, card.fromBot)}
        </Link>
        &apos;s consult chat
      </p>
    );
  }
  return (
    <Link href="/chat" data-testid="handoff-card" className={buttonClass({ variant: "primary", size: "sm", pill: true })}>
      Open Lead chat <ArrowRight aria-hidden className="size-3.5" />
    </Link>
  );
}

function DelegationCard({ card }: { card: Card<"delegation"> }) {
  const { bots } = useChat();
  return (
    <p data-testid="delegation-card" className="flex flex-wrap items-center gap-1.5 rounded-xl border border-border bg-surface/70 px-3 py-2 text-xs">
      <span className="text-muted">Lead →</span>
      <b>@{botDisplay(bots, card.bot)}</b>
      <span className="text-muted">
        : {card.task} · {card.status}
      </span>
    </p>
  );
}

function FactRequestCard({ card }: { card: Card<"fact_request"> }) {
  return (
    <div data-testid="fact-request-card" className="flex flex-wrap items-center gap-2 rounded-2xl border border-warn/40 bg-warn/5 p-3 text-xs">
      <CircleHelp aria-hidden className="size-3.5 text-warn" />
      <span>
        <b>CV asks:</b> “{card.question}”
      </span>
      <Link href="/cv" className="text-accent underline">
        Add a fact
      </Link>
    </div>
  );
}

/** A job with its fit and QA (from the review queue when it is there). */
function JobCard({ card }: { card: Card<"job"> }) {
  const { data } = useReviewQueue();
  const review = data?.find((c) => c.job.id === card.jobId);
  if (!review) return <p className="text-xs text-muted">Job #{card.jobId}</p>;
  const qa = review.cvOptions[0]?.qaRounds.at(-1);
  return (
    <Link href="/review" data-testid="job-card" data-clickable className="block rounded-2xl border border-border bg-surface/70 p-3 text-xs transition hover:border-accent">
      <p className="font-medium text-fg">
        {review.job.title} — {review.job.company}
      </p>
      <p className="text-muted">
        Fit {review.job.fitScore ?? "—"} · QA {qa?.total ?? "—"} {qa ? (qa.passed ? "✓" : "✗") : ""} · open in Review
      </p>
    </Link>
  );
}

/** The rich parts under a message (shared MessageCard union, §11 Chat). */
export function MessageCards({ message }: { message: Message }) {
  const hasRun = message.cards.some((c) => c.type === "run");
  if (!message.cards.length) return null;
  return (
    <div className="space-y-2.5">
      {message.cards.map((card, i) => {
        const key = `${card.type}-${i}`;
        switch (card.type) {
          case "run":
            return <RunCard key={key} runId={card.runId} />;
          case "delegation":
            // The run card already traces delegated work live.
            return hasRun ? null : <DelegationCard key={key} card={card} />;
          case "review_link":
            return (
              <Link key={key} href="/review" data-testid="review-link" className={cn(buttonClass({ variant: "primary", size: "sm", pill: true }), "w-fit")}>
                <Inbox aria-hidden className="size-3.5" /> Open review queue <ArrowRight aria-hidden className="size-3.5" />
              </Link>
            );
          case "question":
            return <QuestionCard key={key} card={card} />;
          case "pause":
            return <PauseCard key={key} card={card} />;
          case "choice":
            return <ChoiceCard key={key} message={message} card={card} />;
          case "handoff":
            return <HandoffCard key={key} card={card} />;
          case "fact_request":
            return <FactRequestCard key={key} card={card} />;
          case "job":
            return <JobCard key={key} card={card} />;
          default:
            return null;
        }
      })}
    </div>
  );
}
