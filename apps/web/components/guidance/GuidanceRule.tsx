"use client";

// One CV guidance rule with the sources behind it (design components guidance-rule,
// rule-status-badge, guidance-refresh-banner). Everything from the rule set is rendered as plain
// text (SEC-26): React escapes it, and a source address is a link only when it is https.
import type { GuidancePositionApplies, GuidanceRuleView, GuidanceSourceView } from "@bs-job-agents/shared";
import { AlertTriangle, Check, ChevronDown, Lock, Minus, Power, Split } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { Badge, Button } from "@/components/ui";
import { cn } from "@/lib/cn";
import { dateLabel, safeHref, sourceAddress, sourceName } from "./model";

export function RuleStatusBadge({ rule }: { rule: Pick<GuidanceRuleView, "status" | "overriddenBy"> }) {
  switch (rule.status) {
    case "turned_off":
      return (
        <Badge tone="neutral" data-testid="rule-status">
          <Power aria-hidden className="size-3" /> Turned off by you
        </Badge>
      );
    case "overridden":
      return (
        <Badge tone="neutral" data-testid="rule-status">
          <Lock aria-hidden className="size-3" /> QA limit {rule.overriddenBy.join(", ")} applies
        </Badge>
      );
    case "disputed":
      return (
        <Badge tone="warn" data-testid="rule-status">
          <Split aria-hidden className="size-3" /> Disputed
        </Badge>
      );
    default:
      return (
        <Badge tone="ok" data-testid="rule-status">
          <Check aria-hidden className="size-3" /> Sources agree
        </Badge>
      );
  }
}

const APPLIES: Record<GuidancePositionApplies, { text: string; icon: ReactNode; tone: "ok" | "neutral" }> = {
  applied: { text: "Applied", icon: <Check aria-hidden className="size-3" />, tone: "ok" },
  applied_vn: { text: "Applied for Vietnam jobs", icon: <Check aria-hidden className="size-3" />, tone: "ok" },
  applied_global: { text: "Applied for global jobs", icon: <Check aria-hidden className="size-3" />, tone: "ok" },
  not_applied: { text: "Not applied", icon: <Minus aria-hidden className="size-3" />, tone: "neutral" },
};

/** One source: title (strong), its address (a link only for https), the retrieval date and the quote. */
export function SourceLine({ source }: { source: GuidanceSourceView }) {
  const href = safeHref(source.url);
  const address = sourceAddress(source);
  return (
    <li data-testid="guidance-source" className="space-y-0.5 text-xs">
      <p className="font-medium break-words">{sourceName(source)}</p>
      <p className="font-mono text-[11px] break-all text-muted">
        {href ? (
          <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
            {address}
          </a>
        ) : (
          address
        )}{" "}
        · retrieved {dateLabel(source.retrievedAt)}
      </p>
      {source.evidence ? <p className="text-muted italic break-words">“{source.evidence}”</p> : null}
    </li>
  );
}

export interface GuidanceRuleCardProps {
  rule: GuidanceRuleView;
  onToggle: (rule: GuidanceRuleView) => void;
  /** The turn-off / turn-on call is on its way. */
  busy?: boolean;
}

export function GuidanceRuleCard({ rule, onToggle, busy = false }: GuidanceRuleCardProps) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const disputed = rule.positions.length > 1;
  const sources = rule.positions.flatMap((p) => p.sources).filter((s, i, all) => all.findIndex((x) => x.id === s.id) === i);
  return (
    <article
      data-testid="guidance-rule"
      data-rule={rule.ruleId}
      className={cn("space-y-2 rounded-2xl border border-border bg-surface/60 px-6 py-4", disputed && "border-s-2 border-s-warn")}
      aria-labelledby={`${listId}-title`}
    >
      <div className="flex flex-wrap items-start gap-2">
        <RuleStatusBadge rule={rule} />
        <h2 id={`${listId}-title`} className="min-w-0 flex-1 text-sm font-semibold break-words">
          {disputed ? rule.point : rule.positions[0]?.text ?? rule.point}
        </h2>
      </div>
      {rule.appliesWhen === "has_profile_link" ? <p className="text-xs text-muted">Applies only when your master CV has a LinkedIn, GitHub or portfolio link.</p> : null}
      {disputed ? (
        <div className="space-y-3">
          {rule.positions.map((p, i) => {
            const a = APPLIES[p.applies];
            return (
              <section key={p.id} data-testid="guidance-position" className="space-y-1.5 border-s border-border ps-3">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium break-words">
                    Position {i + 1}: {p.text}
                  </p>
                  <Badge tone={a.tone}>
                    {a.icon} {a.text}
                  </Badge>
                </div>
                <ul className="space-y-1.5">
                  {p.sources.map((s) => (
                    <SourceLine key={s.id} source={s} />
                  ))}
                </ul>
              </section>
            );
          })}
          <p className="text-xs text-muted" data-testid="guidance-why">
            {rule.reason}
          </p>
        </div>
      ) : (
        <div>
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => setOpen((o) => !o)}
            className="min-h-11 px-2"
            rightIcon={<ChevronDown aria-hidden className={cn("size-3.5 transition", open && "rotate-180")} />}
          >
            Sources ({sources.length})
          </Button>
          {open ? (
            <ul id={listId} className="mt-1 animate-fade-in space-y-2 motion-reduce:animate-none" data-testid="guidance-sources">
              {sources.map((s) => (
                <SourceLine key={s.id} source={s} />
              ))}
            </ul>
          ) : null}
        </div>
      )}
      <div className="flex justify-end">
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => onToggle(rule)} data-testid="rule-toggle" className="min-h-11 text-muted">
          {rule.turnedOff ? "Turn on" : "Turn off for my CVs"}
        </Button>
      </div>
    </article>
  );
}

/** The last refresh failed: the previous rules are in force (no action: nothing Ba must do). */
export function GuidanceRefreshBanner({ reason, lastSuccess }: { reason: string; lastSuccess: string | null }) {
  return (
    <div role="status" data-testid="guidance-refresh-banner" className="flex items-start gap-2 rounded-2xl border border-border border-s-2 border-s-warn bg-surface px-4 py-3 text-sm">
      <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" />
      <div className="space-y-1">
        <p>
          <strong>CV guidance refresh failed:</strong> {reason}.
        </p>
        <p className="text-muted">
          The previous rule set stays in force and tailoring goes on with it. The next job-scan run tries the refresh again.
          {lastSuccess ? ` Last successful check ${dateLabel(lastSuccess)}.` : ""}
        </p>
      </div>
    </div>
  );
}
