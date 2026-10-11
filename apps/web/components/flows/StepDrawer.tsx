"use client";

import { Check, RotateCcw, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { TranscriptLine } from "@/lib/api/contract";
import { errorMessage } from "@/lib/api/errors";
import { useReviewQueue } from "@/lib/api/hooks";
import { ENGINE_NAMES } from "@/lib/api/map";
import { useApi, useAppEvents, useResource } from "@/lib/api/react";
import type { RunView } from "@/lib/api/runs";
import { cn } from "@/lib/cn";
import { formatElapsed } from "@/lib/datetime";
import { useNow } from "@/lib/useNow";
import { useShell } from "@/components/shell/ShellContext";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { FileButton } from "@/components/ui/FileViewer";
import { StatusPill } from "@/components/ui/Badge";
import { useToast } from "@/components/ui/Toast";
import { canRerun, defaultTask, nodeTasks, outputSummary, selfCheckOf, type DrawerTask } from "./drawer";
import type { FlowNodeData } from "./graph";

const MAX_ATTEMPTS = 2;

function Stat({ label, children, testId }: { label: string; children: React.ReactNode; testId?: string }) {
  return (
    <div className="rounded-xl bg-surface-2 p-2" data-testid={testId}>
      <p className="text-muted">{label}</p>
      <b className="block truncate">{children}</b>
    </div>
  );
}

const json = (value: unknown) => {
  try {
    return JSON.stringify(value, null, 2) ?? "—";
  } catch {
    return String(value);
  }
};

/** Transcript of one task: what was saved, plus lines streamed live while it runs. */
function Transcript({ taskId, running }: { taskId: string; running: boolean }) {
  const saved = useResource<TranscriptLine[]>(`transcript:${taskId}`, (api) => api.getTranscript(taskId));
  const [live, setLive] = useState<TranscriptLine[]>([]);
  useAppEvents((e) => {
    if (e.type === "task.progress" && e.taskId === taskId) setLive((l) => [...l, { at: e.at, kind: e.kind, text: e.text, tool: e.tool }]);
  });
  const lines = useMemo(() => {
    const seen = new Set<string>();
    return [...(saved.data ?? []), ...live].filter((l) => {
      const k = `${l.at}|${l.kind}|${l.text}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [saved.data, live]);
  return (
    <div className="space-y-1 rounded-xl border border-border bg-bg p-3 font-mono text-[11px] text-muted" data-testid="transcript">
      {lines.length === 0 ? <p>{saved.data === undefined ? "Loading…" : running ? "Waiting for output…" : "No transcript saved for this task."}</p> : null}
      {lines.map((l, i) => (
        <p key={i} className={cn(l.kind === "tool_use" && "text-fg")}>
          › {l.kind === "tool_use" || l.kind === "tool_result" ? `${l.kind === "tool_use" ? "tool" : "result"}: ${l.tool ? `${l.tool} — ` : ""}` : ""}
          {l.text}
        </p>
      ))}
      {running ? (
        <p>
          › working
          <span aria-hidden className="ml-1 inline-block h-2.5 w-1.5 animate-blink bg-accent align-[-1px]" />
        </p>
      ) : null}
    </div>
  );
}

/** UC-22: input, output, self-check, transcript (live while running), duration, attempts, engine, prompt version. */
export function StepDrawer({ view, data, onClose }: { view: RunView; data: FlowNodeData | null; onClose: () => void }) {
  const api = useApi();
  const { toast } = useToast();
  const { data: shell } = useShell();
  const review = useReviewQueue();
  const tasks = useMemo<DrawerTask[]>(() => (data ? nodeTasks(view, data) : []), [view, data]);
  const [picked, setPicked] = useState<string | null>(null);
  const [rerunning, setRerunning] = useState(false);
  const selected = tasks.find((t) => t.task.id === picked) ?? defaultTask(tasks);
  const task = selected?.task ?? null;
  const rows = data ? view.steps.filter((s) => data.stepIds.includes(s.id)) : [];
  const live = rows.some((r) => r.status === "running");
  const now = useNow(live);
  const start = rows.map((r) => r.startedAt).filter((x): x is string => !!x).sort()[0] ?? null;
  const end = live ? null : (rows.map((r) => r.finishedAt).filter((x): x is string => !!x).sort().at(-1) ?? null);
  const bot = data?.bot ? shell.bots.find((b) => b.name === (task?.botName ?? data.bot)) : undefined;
  const engine = task ? ENGINE_NAMES[task.engine] : bot ? ENGINE_NAMES[bot.engine] : "—";
  const rerun = data ? canRerun(data) : { allowed: false, reason: null };
  const files = data?.kind === "gate" && data.lane ? (review.data?.find((c) => c.job.id === data.lane)?.cvOptions ?? []) : [];

  const doRerun = async () => {
    if (!data) return;
    setRerunning(true);
    try {
      await api.rerunStep(data.stepIds[0]!);
      toast({ title: `Re-running ${data.label}` });
    } catch (err) {
      toast({ title: errorMessage(err), tone: "err" });
    } finally {
      setRerunning(false);
    }
  };

  return (
    <Drawer
      open={data !== null}
      onOpenChange={(open) => !open && onClose()}
      title={data?.label ?? ""}
      eyebrow={data ? `${data.botLabel}${engine !== "—" ? ` · ${engine}` : ""}` : null}
      data-testid="step-drawer"
    >
      {data ? (
        <>
          <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            <Stat label="Status" testId="drawer-status">
              <StatusPill status={data.status === "waiting_limit" ? "waiting_limit" : data.status} />
            </Stat>
            <Stat label="Attempt" testId="drawer-attempt">
              {task ? `${task.attempt} of ${MAX_ATTEMPTS}` : "—"}
            </Stat>
            <Stat label="Prompt" testId="drawer-prompt">
              {task ? `v${task.promptVersion}` : "—"}
            </Stat>
            <Stat label="Duration" testId="drawer-duration">
              {formatElapsed(start, end, now ?? undefined)}
            </Stat>
          </div>
          {data.preview ? <p className="text-xs text-muted">{data.preview}</p> : null}

          {tasks.length > 1 ? (
            <div role="radiogroup" aria-label="Task" className="flex flex-wrap gap-1.5">
              {tasks.map((t) => (
                <button
                  key={t.task.id}
                  type="button"
                  role="radio"
                  aria-checked={t.task.id === task?.id}
                  onClick={() => setPicked(t.task.id)}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-[11px] transition",
                    t.task.id === task?.id ? "border-transparent bg-gradient-brand text-white" : "border-border text-muted hover:text-fg",
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>
          ) : null}

          {task ? (
            <>
              <section className="space-y-1">
                <p className="text-xs text-muted">Input</p>
                <pre className="max-h-48 overflow-auto rounded-xl bg-surface-2 p-3 text-[11px] whitespace-pre-wrap" data-testid="drawer-input">
                  {json(task.input)}
                </pre>
              </section>
              <section className="space-y-1">
                <p className="text-xs text-muted">Output</p>
                <p className="rounded-xl bg-surface-2 p-3 text-[11px]" data-testid="drawer-output">
                  {outputSummary(task)}
                </p>
                {task.output ? (
                  <details className="text-[11px]">
                    <summary className="text-muted hover:text-fg">Raw output</summary>
                    <pre className="mt-1 max-h-64 overflow-auto rounded-xl bg-surface-2 p-3 whitespace-pre-wrap">{json(task.output)}</pre>
                  </details>
                ) : null}
              </section>
              <section className="space-y-1">
                <p className="text-xs text-muted">Self-check (rule 4)</p>
                {selfCheckOf(task).length ? (
                  <ul className="space-y-1 text-xs" data-testid="drawer-selfcheck">
                    {selfCheckOf(task).map((c) => (
                      <li key={c.item} className="flex items-start gap-1.5 rounded-lg border border-border px-2 py-1">
                        {c.passed ? <Check aria-hidden className="mt-px size-3.5 shrink-0 text-ok" /> : <X aria-hidden className="mt-px size-3.5 shrink-0 text-danger" />}
                        <span>
                          {c.item}
                          {c.note ? <span className="text-muted"> — {c.note}</span> : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-muted">{task.status === "running" ? "Reported when the task hands in." : "No self-check reported."}</p>
                )}
              </section>
              <section className="space-y-1">
                <p className="text-xs text-muted">
                  Transcript <span className="text-muted/70">· {engine}</span>
                </p>
                <Transcript key={task.id} taskId={task.id} running={task.status === "running"} />
              </section>
            </>
          ) : (
            <p className="text-xs text-muted">
              {data.kind === "trigger"
                ? "The run started here."
                : data.kind === "human"
                  ? "This step waits for your decision on the review card."
                  : data.kind === "filter"
                    ? "A code step (no bot): it filters the previous step's results."
                    : "No task has run for this step yet."}
            </p>
          )}

          {files.length ? (
            <section className="space-y-1">
              <p className="text-xs text-muted">Output files</p>
              <div className="flex flex-wrap gap-2">
                {files
                  .filter((o) => o.pdf)
                  .map((o) => (
                    <FileButton
                      key={o.pdf!.id}
                      file={{
                        name: o.pdf!.filename,
                        kind: "pdf",
                        url: api.fileUrl(o.pdf!.id),
                        downloadUrl: api.fileUrl(o.pdf!.id, { download: true }),
                        figmaUrl: o.cvVersion.figmaFrameUrl ?? undefined,
                      }}
                    />
                  ))}
              </div>
            </section>
          ) : null}

          {data.kind !== "trigger" ? (
            <div className="space-y-1 border-t border-border/60 pt-4">
              <Button size="sm" leftIcon={<RotateCcw aria-hidden className="size-3.5" />} disabled={!rerun.allowed} loading={rerunning} onClick={() => void doRerun()}>
                Re-run step
              </Button>
              {rerun.reason ? <p className="text-[11px] text-muted">{rerun.reason}</p> : <p className="text-[11px] text-muted">Re-runs this step and the steps after it in this branch.</p>}
            </div>
          ) : null}
        </>
      ) : null}
    </Drawer>
  );
}
