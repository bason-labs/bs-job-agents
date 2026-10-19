"use client";

// The review step's CV guidance result (design screens/review.md; components language-tabs,
// review-guidance-panel, fact-request-card): one panel per CV language, showing only what needs
// Ba (not met, needs fact, disputed and not applied, each with its sources), or "All CV guidance
// rules met". It never blocks the review actions. Plain text throughout (SEC-26).
import { guidanceAttention, type CvLanguage, type GuidanceReviewEntry, type ReviewCard, type ReviewGuidance } from "@bs-job-agents/shared";
import { CheckCircle2, ChevronDown, CircleAlert, CircleHelp, Split } from "lucide-react";
import Link from "next/link";
import { useId, useState, type ReactNode } from "react";
import { Badge, Tabs, TabsContent, TabsList, TabsTrigger, buttonClass } from "@/components/ui";
import { cn } from "@/lib/cn";
import { STATUS_TEXT, reviewSummary, sourceName } from "@/components/guidance/model";

const tabLabel = (lang: CvLanguage): string => (lang === "vi" ? "Vietnamese CV" : "English CV");

const ICON: Partial<Record<GuidanceReviewEntry["status"], ReactNode>> = {
  not_met: <CircleAlert aria-hidden className="size-3" />,
  needs_fact: <CircleHelp aria-hidden className="size-3" />,
  disputed_not_applied: <Split aria-hidden className="size-3" />,
};

function ItemBadge({ status }: { status: GuidanceReviewEntry["status"] }) {
  return (
    <Badge tone={status === "not_met" ? "warn" : status === "needs_fact" ? "accent" : "neutral"} data-testid="guidance-item-status">
      {ICON[status]} {STATUS_TEXT[status]}
    </Badge>
  );
}

function AttentionItem({ item, lastRound }: { item: GuidanceReviewEntry; lastRound: boolean }) {
  return (
    <li data-testid="guidance-item" data-rule={item.ruleId} className="space-y-1 border-t border-border py-3 first:border-t-0">
      <div className="flex flex-wrap items-center gap-2">
        <ItemBadge status={item.status} />
        {item.status === "not_met" && lastRound ? <span className="text-xs text-muted">Still not met after round 3</span> : null}
      </div>
      <p className="text-sm font-semibold break-words">{item.applied ?? item.point}</p>
      <p className="text-xs break-words">{item.reason}</p>
      <p className="text-[11px] break-words text-muted" data-testid="guidance-item-sources">
        Sources: {item.sources.map(sourceName).join(", ")}
      </p>
      {item.factRequests.map((r) => (
        <div key={`${r.factId}-${r.field}`} data-testid="guidance-fact-request" className="mt-1 rounded-xl border border-accent/30 bg-accent/5 px-3 py-2 text-xs">
          <p className="text-muted">From CV guidance: {item.point}</p>
          <p className="break-words">
            {r.question} <span className="text-muted">({r.factId === "contact" ? "your contact details" : `fact ${r.factId}`})</span>
          </p>
          <Link href="/cv" className={cn(buttonClass({ size: "sm", pill: true }), "mt-1 min-h-11")}>
            Answer
          </Link>
        </div>
      ))}
    </li>
  );
}

export function GuidancePanel({ guidance }: { guidance: ReviewGuidance }) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const attention = guidanceAttention(guidance.result);
  if (attention.length === 0) {
    return (
      <section data-testid="guidance-panel" className="flex items-center gap-2 rounded-2xl border border-border bg-surface/60 px-4 py-3 text-sm">
        <CheckCircle2 aria-hidden className="size-4 text-ok" />
        <span data-testid="guidance-all-met">All CV guidance rules met</span>
      </section>
    );
  }
  return (
    <section data-testid="guidance-panel" className="space-y-1 rounded-2xl border border-border bg-surface/60 px-4 py-3" aria-labelledby={`${listId}-h`}>
      <h3 id={`${listId}-h`} className="text-sm font-semibold">
        CV guidance
      </h3>
      <p className="text-xs text-muted" data-testid="guidance-summary">
        {reviewSummary(guidance, attention.length)}
      </p>
      <ul>
        {attention.map((item) => (
          <AttentionItem key={item.ruleId} item={item} lastRound={guidance.lastRound} />
        ))}
      </ul>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-xs text-accent hover:bg-surface-2 active:bg-surface-3"
      >
        All {guidance.result.items.length} rules in this review <ChevronDown aria-hidden className={cn("size-3.5 transition", open && "rotate-180")} />
      </button>
      {open ? (
        <dl id={listId} data-testid="guidance-all-rules" className="grid animate-fade-in grid-cols-1 gap-x-4 gap-y-1 text-xs motion-reduce:animate-none sm:grid-cols-[auto_1fr]">
          {guidance.result.items.map((i) => (
            <div key={i.ruleId} className="contents">
              <dt className="text-muted">{STATUS_TEXT[i.status]}</dt>
              <dd className="break-words">{i.point}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}

/** Language tabs (ARIA tab pattern: arrow keys, Home/End, roving tabindex) over one panel each. */
export function ReviewGuidance({ card, lang, onSelect }: { card: Pick<ReviewCard, "cvOptions">; lang: CvLanguage; onSelect: (lang: CvLanguage) => void }) {
  const options = card.cvOptions.filter((o) => o.guidance);
  if (options.length === 0) return null;
  if (options.length === 1) return <GuidancePanel guidance={options[0]!.guidance!} />;
  const selected = options.some((o) => o.cvVersion.language === lang) ? lang : options[0]!.cvVersion.language;
  return (
    <Tabs variant="underline" value={selected} onValueChange={(v) => onSelect(v as CvLanguage)} data-testid="guidance-tabs">
      <TabsList aria-label="CV language">
        {options.map((o) => (
          <TabsTrigger key={o.cvVersion.language} value={o.cvVersion.language} className="min-h-11 font-medium">
            {tabLabel(o.cvVersion.language)}
          </TabsTrigger>
        ))}
      </TabsList>
      {options.map((o) => (
        <TabsContent key={o.cvVersion.language} value={o.cvVersion.language}>
          <GuidancePanel guidance={o.guidance!} />
        </TabsContent>
      ))}
    </Tabs>
  );
}
