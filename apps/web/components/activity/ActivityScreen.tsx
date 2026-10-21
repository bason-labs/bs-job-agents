"use client";

// The activity log (/activity, design screens/activity.md, components activity-entry and skill-diff):
// what the system changed on its own, newest first, in one list:
// - CV guidance: "Rule added" or "Rule changed", the rule, its previous and new text, the sources (REQ-36);
// - skill self-repair (REQ-11, sub-project 4 §7): Repairing, Adopted (diff, "Not applied", Restore
//   previous skill), Not adopted (reason, the draft that was tried), Restored, Paused (Try repair
//   again), and a board's API changed or recovered.
// Plain text throughout (SEC-26). Removed lines carry "-", added lines "+", not only a colour.
import type { ActivityEntry, GuidanceActivityEntry, SkillRepairActivityEntry, SourceApiActivityEntry } from "@bs-job-agents/shared";
import { ChevronDown, CircleCheck, CircleX, History, Loader, Pause, Pencil, Plus, RefreshCw, RotateCcw, Unplug, Wrench, WifiOff } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { Badge, Button, EmptyState, Skeleton, useToast } from "@/components/ui";
import { useLiveResource } from "@/lib/api/live-resource";
import { errorMessage } from "@/lib/api/errors";
import { cn } from "@/lib/cn";
import { useGuidanceData, type GuidanceData } from "@/components/guidance/data";
import { safeHref, sourceName, timeLabel } from "@/components/guidance/model";

const REFRESH_TYPES = new Set(["guidance.rule_added", "guidance.rule_changed", "skill_repair.progress", "skill_repair.adopted", "skill_repair.not_adopted", "skill_repair.restored", "skill_repair.restore_failed", "skill_repair.paused", "source_api.changed", "source_api.recovered"]);

export function ActivityLive() {
  const data = useGuidanceData();
  const read = useLiveResource("activity", () => data.activity(), { refreshOn: (e) => REFRESH_TYPES.has(e.type) });
  if (read.data !== undefined) return <ActivityScreen entries={read.data} data={data} onChange={() => void read.reload()} />;
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

export interface ActivityScreenProps {
  entries: ActivityEntry[];
  /** Restore and retry go through it (absent: read-only, e.g. in a story). */
  data?: Pick<GuidanceData, "restoreSkill" | "retrySkillRepair">;
  onChange?: () => void;
}

export function ActivityScreen({ entries, data, onChange }: ActivityScreenProps) {
  const [list, setList] = useState(entries);
  const [seen, setSeen] = useState(entries);
  if (seen !== entries) {
    setSeen(entries);
    setList(entries);
  }
  const hasSkills = list.some((e) => e.kind.startsWith("skill"));
  return (
    <div className="mx-auto max-w-[68ch] space-y-4">
      <header>
        <h1 className="font-display text-xl font-semibold">Activity</h1>
        <p className="text-sm text-muted">What the system changed on its own, newest first.</p>
        {hasSkills ? (
          <p className="mt-1 text-xs text-muted" data-testid="activity-degraded-note">
            Adopted changes do not put the research bot in the degraded start state.
          </p>
        ) : null}
      </header>
      {list.length === 0 ? (
        <EmptyState
          icon={<History aria-hidden />}
          title="No changes yet"
          description="When a scan reports an adapter broken, the automatic repair is recorded here, adopted or not. When the CV guidance refresh adds or changes a rule, that is recorded here too."
        />
      ) : (
        <ul className="space-y-2" data-testid="activity-list">
          {list.map((e) => (
            <li key={e.id}>
              <ActivityEntryItem
                entry={e}
                {...(data
                  ? {
                      actions: {
                        restore: async (repairId) => {
                          setList(await data.restoreSkill(repairId));
                          onChange?.();
                        },
                        retry: async (source) => {
                          setList(await data.retrySkillRepair(source));
                          onChange?.();
                        },
                      },
                    }
                  : {})}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface EntryActions {
  restore(repairId: string): Promise<void>;
  retry(source: string): Promise<void>;
}

export function ActivityEntryItem({ entry, actions }: { entry: ActivityEntry; actions?: EntryActions }) {
  switch (entry.kind) {
    case "rule_added":
    case "rule_changed":
      return <GuidanceEntry entry={entry} />;
    case "api_changed":
    case "api_recovered":
      return <ApiEntry entry={entry} />;
    default:
      return <SkillEntry entry={entry} {...(actions ? { actions } : {})} />;
  }
}

/** The expandable row every entry uses: badge and label (3), reason (6), time (3); stacked on phones. */
function EntryShell(props: { kind: string; badge: ReactNode; label: ReactNode; reason: ReactNode; at: string; children?: ReactNode; open?: boolean }) {
  const bodyId = useId();
  const [open, setOpen] = useState(props.open ?? false);
  const expandable = props.children !== undefined && props.children !== null;
  const head = (
    <>
      <span className="flex flex-wrap items-center gap-2">
        {props.badge}
        <span className="text-sm font-medium">{props.label}</span>
      </span>
      <span className="text-sm break-words">{props.reason}</span>
      <span className="flex items-center justify-between gap-2 text-xs text-muted md:justify-end">
        <time dateTime={props.at}>{timeLabel(props.at)}</time>
        {expandable ? <ChevronDown aria-hidden className={cn("size-4 transition", open && "rotate-180")} /> : null}
      </span>
    </>
  );
  const grid = "grid min-h-11 w-full gap-2 rounded-2xl px-4 py-3 text-left md:grid-cols-[3fr_6fr_3fr]";
  return (
    <article data-testid="activity-entry" data-kind={props.kind} className="rounded-2xl border border-border bg-surface/60">
      {expandable ? (
        <button type="button" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((o) => !o)} className={cn(grid, "hover:bg-surface-2 active:bg-surface-3")}>
          {head}
        </button>
      ) : (
        <div className={grid}>{head}</div>
      )}
      {expandable && open ? (
        <div id={bodyId} className="animate-fade-in space-y-3 border-t border-border px-4 py-3 motion-reduce:animate-none" data-testid="activity-body">
          {props.children}
        </div>
      ) : null}
    </article>
  );
}

/** Previous and new text side by side from 1024 px, stacked below; "-" and "+" on every line. */
function Diff({ previous, next, previousEmpty }: { previous: string | null; next: string | null; previousEmpty: string }) {
  return (
    <div className="grid gap-3 lg:grid-cols-2" data-testid="skill-diff">
      <div className="min-w-0 rounded-xl border border-border p-3">
        <p className="mb-1 text-[11px] text-muted uppercase">Previous</p>
        <p className="max-h-96 overflow-auto font-mono text-xs break-words whitespace-pre-wrap" data-testid="activity-previous">
          {previous ? previous.split("\n").map((l) => `- ${l}`).join("\n") : previousEmpty}
        </p>
      </div>
      <div className="min-w-0 rounded-xl border border-border p-3">
        <p className="mb-1 text-[11px] text-muted uppercase">New</p>
        <p className="max-h-96 overflow-auto font-mono text-xs break-words whitespace-pre-wrap" data-testid="activity-new">
          {next ? next.split("\n").map((l) => `+ ${l}`).join("\n") : "(none)"}
        </p>
      </div>
    </div>
  );
}

function GuidanceEntry({ entry }: { entry: GuidanceActivityEntry }) {
  const added = entry.kind === "rule_added";
  return (
    <EntryShell
      kind={entry.kind}
      at={entry.at}
      badge={
        <Badge tone={added ? "ok" : "accent"}>
          {added ? <Plus aria-hidden className="size-3" /> : <Pencil aria-hidden className="size-3" />} {added ? "Rule added" : "Rule changed"}
        </Badge>
      }
      label="CV guidance"
      reason={entry.point}
    >
      {!entry.applied ? <p className="text-xs text-warn">Not applied: the new rule set could not be saved, so the previous one stays in force.</p> : null}
      <Diff previous={entry.previousText} next={entry.newText} previousEmpty="(empty: this rule is new)" />
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
    </EntryShell>
  );
}

const REPAIR_STATUS: Record<NonNullable<SkillRepairActivityEntry["status"]>, string> = {
  queued: "Waiting for the repair in progress",
  drafting: "Drafting a new skill",
  validating: "Validation scan running",
};

function SkillEntry({ entry, actions }: { entry: SkillRepairActivityEntry; actions?: EntryActions }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<void>, done: string) => {
    setBusy(true);
    try {
      await fn();
      toast({ title: done, tone: "ok" });
    } catch (err) {
      toast({ title: errorMessage(err), tone: "err" });
    } finally {
      setBusy(false);
    }
  };
  const trigger = entry.trigger ?? "";
  switch (entry.kind) {
    case "skill_repairing":
      return (
        <EntryShell
          kind={entry.kind}
          at={entry.at}
          badge={
            <Badge tone="accent">
              <Loader aria-hidden className="size-3 motion-safe:animate-spin" /> Repairing
            </Badge>
          }
          label={entry.sourceLabel}
          reason={
            <>
              {trigger}
              <span className="block text-xs text-muted" data-testid="repair-status">
                {entry.status ? REPAIR_STATUS[entry.status] : ""}
              </span>
            </>
          }
        />
      );
    case "skill_adopted":
      return (
        <EntryShell
          kind={entry.kind}
          at={entry.at}
          badge={
            <Badge tone="ok">
              <CircleCheck aria-hidden className="size-3" /> Adopted
            </Badge>
          }
          label={entry.sourceLabel}
          reason={trigger}
        >
          <Diff previous={entry.previousText} next={entry.newText} previousEmpty="(empty)" />
          <NotApplied items={entry.notApplied} />
          <p className="text-xs text-muted" data-testid="activity-scope">
            Only {entry.path} changed. This change is not committed to git yet.
          </p>
          {entry.canRestore && actions && entry.repairId ? (
            <Button
              size="sm"
              pill
              disabled={busy}
              leftIcon={<RotateCcw aria-hidden className="size-3.5" />}
              onClick={() => void act(() => actions.restore(entry.repairId!), `Restored the previous ${entry.sourceLabel} skill.`)}
            >
              Restore previous skill
            </Button>
          ) : null}
        </EntryShell>
      );
    case "skill_not_adopted":
      return (
        <EntryShell
          kind={entry.kind}
          at={entry.at}
          badge={
            <Badge tone="warn">
              <CircleX aria-hidden className="size-3" /> Not adopted
            </Badge>
          }
          label={entry.sourceLabel}
          reason={trigger}
        >
          <p className="text-sm" data-testid="activity-not-adopted">
            Not adopted. The skill text is unchanged.
          </p>
          <p className="text-xs text-muted break-words">Why: {entry.reason}</p>
          {entry.newText ? <Diff previous={entry.previousText} next={entry.newText} previousEmpty="(the skill in force, unchanged)" /> : null}
          <NotApplied items={entry.notApplied} />
        </EntryShell>
      );
    case "skill_restored":
      return (
        <EntryShell
          kind={entry.kind}
          at={entry.at}
          badge={
            <Badge tone="neutral">
              <RotateCcw aria-hidden className="size-3" /> Restored
            </Badge>
          }
          label={entry.sourceLabel}
          reason="Restored the previous skill"
        >
          <Diff previous={entry.previousText} next={entry.newText} previousEmpty="(empty)" />
          <p className="text-xs text-muted">Only {entry.path} changed. This change is not committed to git yet.</p>
        </EntryShell>
      );
    case "skill_repair_paused":
      return (
        <EntryShell
          kind={entry.kind}
          at={entry.at}
          badge={
            <Badge tone="warn">
              <Pause aria-hidden className="size-3" /> Paused
            </Badge>
          }
          label={entry.sourceLabel}
          reason={
            <>
              Automatic repair paused after 3 failed attempts
              {entry.canRetry && actions ? (
                <Button
                  size="sm"
                  pill
                  className="mt-2 flex"
                  disabled={busy}
                  leftIcon={<Wrench aria-hidden className="size-3.5" />}
                  onClick={() => void act(() => actions.retry(entry.source), `Repairing ${entry.sourceLabel} again.`)}
                >
                  Try repair again
                </Button>
              ) : null}
            </>
          }
        />
      );
  }
}

function NotApplied({ items }: { items: SkillRepairActivityEntry["notApplied"] }) {
  if (items.length === 0) return null;
  return (
    <div className="text-xs" data-testid="activity-not-applied">
      <p className="text-muted">Not applied</p>
      <ul className="mt-0.5 space-y-0.5">
        {items.map((c, i) => (
          <li key={`${c.file}-${i}`} className="break-words">
            <span className="font-mono">{c.file}</span>: {c.change}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ApiEntry({ entry }: { entry: SourceApiActivityEntry }) {
  const changed = entry.kind === "api_changed";
  const where = entry.host ? `${entry.method ?? "GET"} ${entry.host}${entry.path ?? ""}` : null;
  return (
    <EntryShell
      kind={entry.kind}
      at={entry.at}
      badge={
        <Badge tone={changed ? "warn" : "ok"}>
          {changed ? <Unplug aria-hidden className="size-3" /> : <CircleCheck aria-hidden className="size-3" />} {changed ? "API changed" : "API recovered"}
        </Badge>
      }
      label={entry.sourceLabel}
      reason={
        changed ? (
          <>
            {entry.reason}
            {where ? <span className="block font-mono text-xs text-muted">{where}</span> : null}
            <span className="block text-xs text-muted">Scans use the browser until the API works again.</span>
          </>
        ) : (
          "Scans are back on the API."
        )
      }
    />
  );
}
