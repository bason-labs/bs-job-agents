"use client";

// The activity log (/activity, design screens/activity.md, component activity-entry): what the
// system changed on its own. CV guidance entries: "Rule added" or "Rule changed", the time, the
// rule, its previous and new text side by side, and the sources (REQ-36). Sub-project 4 adds skill
// repairs to the same list. Plain text throughout (SEC-26).
import type { ActivityEntry } from "@bs-job-agents/shared";
import { ChevronDown, History, Pencil, Plus, RefreshCw, WifiOff } from "lucide-react";
import { useId, useState } from "react";
import { Badge, Button, EmptyState, Skeleton } from "@/components/ui";
import { useLiveResource } from "@/lib/api/live-resource";
import { cn } from "@/lib/cn";
import { useGuidanceData } from "@/components/guidance/data";
import { safeHref, sourceName, timeLabel } from "@/components/guidance/model";

export function ActivityLive() {
  const data = useGuidanceData();
  const read = useLiveResource("activity", () => data.activity(), {
    refreshOn: (e) => e.type === "guidance.rule_added" || e.type === "guidance.rule_changed",
  });
  if (read.data !== undefined) return <ActivityScreen entries={read.data} />;
  if (read.error && !read.loading) {
    return (
      <EmptyState
        icon={<WifiOff aria-hidden />}
        title="Could not load the activity log"
        description={<span data-testid="activity-error">The orchestrator did not answer, so no entries are shown.</span>}
        action={
          <Button pill onClick={() => void read.reload()} leftIcon={<RefreshCw aria-hidden className="size-4" />}>
            Retry
          </Button>
        }
      />
    );
  }
  return (
    <div className="space-y-3" aria-busy aria-label="Loading the activity log" data-testid="activity-loading">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-14 w-full" />
      ))}
    </div>
  );
}

export function ActivityScreen({ entries }: { entries: ActivityEntry[] }) {
  return (
    <div className="mx-auto max-w-[68ch] space-y-4">
      <header>
        <h1 className="font-display text-xl font-semibold">Activity</h1>
        <p className="text-sm text-muted">What the system changed on its own, newest first.</p>
      </header>
      {entries.length === 0 ? (
        <EmptyState
          icon={<History aria-hidden />}
          title="No changes yet"
          description="When the CV guidance refresh adds or changes a rule, that is recorded here."
        />
      ) : (
        <ul className="space-y-2" data-testid="activity-list">
          {entries.map((e) => (
            <li key={e.id}>
              <ActivityEntryItem entry={e} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ActivityEntryItem({ entry }: { entry: ActivityEntry }) {
  const bodyId = useId();
  const [open, setOpen] = useState(false);
  const added = entry.kind === "rule_added";
  return (
    <article data-testid="activity-entry" data-kind={entry.kind} className="rounded-2xl border border-border bg-surface/60">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((o) => !o)}
        className="grid min-h-11 w-full gap-2 rounded-2xl px-4 py-3 text-left hover:bg-surface-2 active:bg-surface-3 md:grid-cols-[3fr_6fr_3fr]"
      >
        <span className="flex flex-wrap items-center gap-2">
          <Badge tone={added ? "ok" : "accent"}>
            {added ? <Plus aria-hidden className="size-3" /> : <Pencil aria-hidden className="size-3" />} {added ? "Rule added" : "Rule changed"}
          </Badge>
          <span className="text-sm font-medium">CV guidance</span>
        </span>
        <span className="text-sm break-words">{entry.point}</span>
        <span className="flex items-center justify-between gap-2 text-xs text-muted md:justify-end">
          <time dateTime={entry.at}>{timeLabel(entry.at)}</time>
          <ChevronDown aria-hidden className={cn("size-4 transition", open && "rotate-180")} />
        </span>
      </button>
      {open ? (
        <div id={bodyId} className="animate-fade-in space-y-3 border-t border-border px-4 py-3 motion-reduce:animate-none" data-testid="activity-body">
          {!entry.applied ? <p className="text-xs text-warn">Not applied: the new rule set could not be saved, so the previous one stays in force.</p> : null}
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="min-w-0 rounded-xl border border-border p-3">
              <p className="mb-1 text-[11px] text-muted uppercase">Previous</p>
              <p className="font-mono text-xs break-words whitespace-pre-wrap" data-testid="activity-previous">
                {entry.previousText ? entry.previousText.split("\n").map((l) => `- ${l}`).join("\n") : "(empty: this rule is new)"}
              </p>
            </div>
            <div className="min-w-0 rounded-xl border border-border p-3">
              <p className="mb-1 text-[11px] text-muted uppercase">New</p>
              <p className="font-mono text-xs break-words whitespace-pre-wrap" data-testid="activity-new">
                {entry.newText.split("\n").map((l) => `+ ${l}`).join("\n")}
              </p>
            </div>
          </div>
          <div className="text-xs">
            <p className="text-muted">Sources</p>
            <ul className="mt-0.5 space-y-0.5">
              {entry.sources.map((s) => {
                const href = safeHref(s.url);
                return (
                  <li key={s.id} className="break-words" data-testid="activity-source">
                    {href ? (
                      <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
                        {sourceName(s)}
                      </a>
                    ) : (
                      <>
                        {sourceName(s)}
                        {s.repoPath ? <span className="font-mono text-muted"> · {s.repoPath}</span> : null}
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      ) : null}
    </article>
  );
}
