"use client";

import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { errorMessage } from "@/lib/api/errors";
import { useRun } from "@/lib/api/hooks";
import { cn } from "@/lib/cn";
import { Skeleton } from "@/components/ui/Skeleton";
import { botDisplay, useChat } from "./ChatContext";
import { delegationRows, type RowStatus } from "./model";

export const WORKFLOW_TITLES: Record<string, string> = {
  "job-scan": "Job scan",
  "apply-to-link": "Apply to link",
  "apply-to-file": "Apply to file",
};

export const workflowTitle = (name: string) => WORKFLOW_TITLES[name] ?? name.replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/** PM3 S4: a run started from a saved preset is named after it ("danang-react · Job scan"). */
export const runTitle = (workflowName: string, presetName?: string | null) =>
  presetName ? `${presetName} · ${workflowTitle(workflowName)}` : workflowTitle(workflowName);

const DOT: Record<string, string> = {
  done: "bg-ok",
  running: "bg-accent animate-pulse",
  failed: "bg-danger",
  waiting: "bg-warn",
  waiting_limit: "bg-warn",
  paused: "bg-warn",
  locked: "bg-warn",
  cancelled: "bg-muted/50",
};

const STATUS_TEXT: Partial<Record<RowStatus, string>> = { waiting_limit: "waiting (limit)" };
const STATUS_TONE: Partial<Record<RowStatus, string>> = {
  running: "text-accent",
  failed: "text-danger",
  waiting: "text-warn",
  waiting_limit: "text-warn",
  paused: "text-warn",
};

const RUN_STATE: Record<string, string> = {
  running: "running",
  waiting: "waiting for you",
  paused: "paused",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
};

/** Run progress card with the delegation trace "Lead → @Bot: task · status" (§11 Chat, UC-01). */
export function RunCard({ runId }: { runId: string }) {
  const { bots } = useChat();
  const { data, error, reload } = useRun(runId);
  const running = data?.run.status === "running";
  return (
    <div data-testid="run-card" data-run={runId} className="overflow-hidden rounded-2xl border border-border bg-surface/70">
      <div className="flex items-center justify-between gap-3 border-b border-border bg-surface-2/50 px-4 py-2 text-xs">
        <span className="flex min-w-0 items-center gap-2">
          <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", running ? "animate-pulse bg-accent" : data ? DOT[data.run.status] ?? "bg-ok" : "bg-surface-3")} />
          <b className="truncate">
            {data ? runTitle(data.run.workflowName, data.presetName) : "Run"} #{runId}
          </b>
          <span className="text-muted">· delegated tasks</span>
          {data && !running ? <span className="text-muted">· {RUN_STATE[data.run.status] ?? data.run.status}</span> : null}
        </span>
        <Link href={`/flows/${runId}`} className="inline-flex shrink-0 items-center gap-0.5 text-accent hover:underline">
          Open flow <ArrowUpRight aria-hidden className="size-3.5" />
        </Link>
      </div>
      {data ? (
        <ul className="divide-y divide-border/60 text-xs">
          {delegationRows(data).map((row) => (
            <li
              key={row.key}
              data-testid={`trace-${row.key}`}
              data-status={row.status}
              className={cn("flex items-center gap-3 px-4 py-2", row.status === "running" && "bg-accent/5", (row.status === "pending" || row.status === "locked") && "opacity-50")}
            >
              <span aria-hidden className={cn("size-2 shrink-0 rounded-full", DOT[row.status] ?? "bg-surface-3")} />
              <span className="shrink-0 text-muted">Lead →</span>
              <b className={cn("shrink-0", row.status === "running" && "text-accent")}>@{botDisplay(bots, row.bot)}</b>
              <span className="min-w-0 flex-1 truncate text-muted" title={`${row.label} — ${row.detail}`}>
                {row.label} — {row.detail}
              </span>
              <span className={cn("shrink-0", STATUS_TONE[row.status] ?? "text-muted")}>{STATUS_TEXT[row.status] ?? row.status}</span>
            </li>
          ))}
        </ul>
      ) : error ? (
        <p className="px-4 py-3 text-xs text-danger">
          Couldn&apos;t load run #{runId}: {errorMessage(error)}{" "}
          <button type="button" onClick={() => void reload()} className="underline">
            Retry
          </button>
        </p>
      ) : (
        <div className="space-y-2 px-4 py-3" aria-busy>
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-3 w-2/3" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      )}
    </div>
  );
}
