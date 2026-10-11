"use client";

import { ArrowRight, Workflow } from "lucide-react";
import Link from "next/link";
import { errorMessage } from "@/lib/api/errors";
import { useRuns } from "@/lib/api/hooks";
import { formatElapsed, formatWhen } from "@/lib/datetime";
import { runTitle } from "@/components/chat/RunCard";
import { Page } from "@/components/shell/Page";
import { StatusPill } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";

const TRIGGER: Record<string, string> = { chat: "from chat", schedule: "scheduled", link: "pasted link" };

/** Flows: every run, newest first; each opens its live canvas. */
export function FlowsList() {
  const runs = useRuns();
  return (
    <Page width="full">
      <div className="mx-auto w-full max-w-3xl space-y-3 p-5">
        {runs.error && !runs.data ? (
          <div role="alert" className="space-y-2 rounded-2xl border border-danger/40 bg-danger/5 p-4 text-sm text-danger">
            <p>Couldn&apos;t load the runs: {errorMessage(runs.error)}</p>
            <Button size="sm" onClick={() => void runs.reload()}>
              Retry
            </Button>
          </div>
        ) : !runs.data ? (
          <>
            <Skeleton className="h-16 w-full rounded-2xl" />
            <Skeleton className="h-16 w-full rounded-2xl" />
          </>
        ) : runs.data.length === 0 ? (
          <EmptyState
            icon={<Workflow aria-hidden />}
            title="No flows yet"
            description="Workflow runs show here as a live canvas: one node per step, animated edges while running, the QA loop and the locked Apply step. Ask Lead to find jobs to start one."
          />
        ) : (
          <ul className="space-y-2" aria-label="Runs">
            {runs.data.map((r) => (
              <li key={r.id}>
                <Link
                  href={`/flows/${r.id}`}
                  data-testid="run-row"
                  className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-surface/60 p-4 transition hover:border-accent"
                >
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-2">
                      <b className="font-display">
                        {runTitle(r.workflowName, r.presetName)} #{r.id}
                      </b>
                      <StatusPill status={r.status} />
                    </span>
                    <span className="block text-xs text-muted">
                      {TRIGGER[r.trigger] ?? r.trigger} · started {formatWhen(r.createdAt)}
                      {r.finishedAt ? ` · took ${formatElapsed(r.createdAt, r.finishedAt)}` : ""}
                    </span>
                  </span>
                  <span className="inline-flex shrink-0 items-center gap-1 text-xs text-accent">
                    Open flow <ArrowRight aria-hidden className="size-3.5" />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Page>
  );
}
