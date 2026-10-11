"use client";

import { SKIP_REASON_LABELS, type ReviewCard, type SkipReason } from "@bs-job-agents/shared";
import { ClipboardCheck } from "lucide-react";
import { useState } from "react";
import { errorMessage } from "@/lib/api/errors";
import { useReviewQueue } from "@/lib/api/hooks";
import { useAppEvents } from "@/lib/api/react";
import { Page } from "@/components/shell/Page";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { ReviewCardItem, type ActedOutcome } from "./ReviewCardItem";

interface Acted {
  card: ReviewCard;
  outcome: ActedOutcome;
}

/**
 * Cards to show, oldest first: the queue, plus cards Ba decided on that the bots still work on
 * (they keep their place and status line). A card that comes back with a newer readyAt (after
 * request changes) replaces its stand-in.
 */
export function visibleCards(cards: readonly ReviewCard[], acted: Readonly<Record<string, Acted>>, hidden: ReadonlySet<string>) {
  const inQueue = new Set(cards.map((c) => c.job.id));
  const rows = [
    ...cards.map((card) => {
      const a = acted[card.job.id];
      return { card, outcome: a && a.card.readyAt === card.readyAt ? a.outcome : null };
    }),
    ...Object.values(acted)
      .filter((a) => !inQueue.has(a.card.job.id))
      .map((a) => ({ card: a.card, outcome: a.outcome as ActedOutcome | null })),
  ];
  return rows.filter((r) => !hidden.has(r.card.job.id)).sort((x, y) => x.card.readyAt.localeCompare(y.card.readyAt));
}

/**
 * Review queue (§11, UC-07..10): one card per job waiting for Ba. A card Ba decided on stays in
 * place with its status line (Apply working, CV revising) until the bots are done with it.
 */
export function ReviewScreen() {
  const queue = useReviewQueue();
  const { toast } = useToast();
  const [acted, setActed] = useState<Record<string, Acted>>({});
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [skipped, setSkipped] = useState<{ company: string; reason: SkipReason }[]>([]);
  const cards = queue.data;

  // Apply finished with an approved card: it leaves the screen.
  useAppEvents((e) => {
    // A card that comes back (e.g. its dry run settled: Approve live, PM2 S15) is a new decision.
    if (e.type === "review.ready" && (hidden.has(e.jobId) || acted[e.jobId])) {
      setHidden((h) => {
        const next = new Set(h);
        next.delete(e.jobId);
        return next;
      });
      setActed(({ [e.jobId]: _gone, ...rest }) => rest);
      return;
    }
    if (e.type !== "application.updated" || !["submitted", "needs_check", "failed"].includes(e.status)) return;
    const a = acted[e.jobId];
    if (!a || a.outcome.kind !== "approved") return;
    setHidden((h) => new Set(h).add(e.jobId));
    toast({ title: e.status === "submitted" ? `${a.card.job.company} submitted` : `${a.card.job.company}: Apply needs a check`, tone: e.status === "submitted" ? "ok" : "err" });
  });

  const rows = cards ? visibleCards(cards, acted, hidden) : [];

  return (
    <Page width="wide">
      {queue.error && !cards ? (
        <div role="alert" className="space-y-2 rounded-2xl border border-danger/40 bg-danger/5 p-4 text-sm text-danger">
          <p>Couldn&apos;t load the review queue: {errorMessage(queue.error)}</p>
          <Button size="sm" onClick={() => void queue.reload()}>
            Retry
          </Button>
        </div>
      ) : !cards ? (
        <div className="space-y-4" aria-busy data-testid="review-loading">
          <Skeleton className="h-72 w-full rounded-3xl" />
          <Skeleton className="h-72 w-full rounded-3xl" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState icon={<ClipboardCheck aria-hidden />} title="Nothing to review 🎉" description="Lead will ping you after the next scan." />
      ) : (
        rows.map(({ card, outcome }) => (
          <ReviewCardItem
            key={`${card.job.id}:${card.readyAt}`}
            card={card}
            acted={outcome}
            onApproved={(c, result, dryRun) => {
              setActed((a) => ({ ...a, [c.job.id]: { card: c, outcome: { kind: "approved", result, dryRun } } }));
              toast({
                title: result.reapproval
                  ? `New approval issued for ${c.job.company} (same application)`
                  : result.taskId === null
                    ? `Approved ${c.job.company}: PDF only (no apply link)`
                    : `Approval token created for ${c.job.company}`,
              });
            }}
            onChangesRequested={(c) => {
              setActed((a) => ({ ...a, [c.job.id]: { card: c, outcome: { kind: "changes" } } }));
              toast({ title: `Sent your note to CV for ${c.job.company}` });
            }}
            onSkipped={(c, reason) => {
              setHidden((h) => new Set(h).add(c.job.id));
              setSkipped((s) => [...s, { company: c.job.company, reason }]);
              void queue.reload();
              toast({ title: `${c.job.company} skipped (${SKIP_REASON_LABELS[reason].toLowerCase()})` });
            }}
            onInjectionConfirmed={() => {
              void queue.reload();
              toast({ title: `Apply enabled for ${card.job.company}` });
            }}
          />
        ))
      )}
      {skipped.length ? (
        <p className="text-xs text-muted" data-testid="skipped">
          Skipped:{" "}
          {skipped.map((s) => (
            <span key={s.company} className="mr-3">
              {s.company} ({SKIP_REASON_LABELS[s.reason].toLowerCase()})
            </span>
          ))}
        </p>
      ) : null}
    </Page>
  );
}
