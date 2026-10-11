// Run detail as the UI keeps it (chat run cards, the flow canvas, the step drawer): GET /runs/:id
// plus live step/task/run events applied in place, and a preview per step. The engine sends a
// step's preview only in step.* events (RunDetail steps have none yet; W3a handoff), so the last
// one seen is kept, and stepPreview() derives one from the step's output otherwise.
import type { AppEvent, RunDetail, Step, Task } from "@bs-job-agents/shared";

export type StepView = Step & { preview?: string | null };
export interface RunView extends Omit<RunDetail, "steps"> {
  steps: StepView[];
}

const TERMINAL = new Set(["done", "failed", "skipped", "cancelled"]);

/** Applies one live event to a run view (pure; returns the same object when it does not apply). */
export function applyRunEvent(view: RunView, e: AppEvent): RunView {
  switch (e.type) {
    case "run.updated":
      return e.runId === view.run.id ? { ...view, run: { ...view.run, status: e.status } } : view;
    case "run.finished":
      return e.runId === view.run.id ? { ...view, run: { ...view.run, status: e.status, finishedAt: e.at } } : view;
    case "step.started":
    case "step.updated":
    case "step.finished": {
      if (e.runId !== view.run.id) return view;
      const status = e.type === "step.started" ? "running" : e.status;
      const patch: Partial<StepView> = { status };
      if (e.type !== "step.finished") patch.round = e.round;
      if (e.type !== "step.started" && e.preview !== null) patch.preview = e.preview;
      if (e.type === "step.finished") {
        patch.finishedAt = e.at;
        patch.error = e.error;
      }
      const i = view.steps.findIndex((s) => s.id === e.stepId);
      if (i === -1) {
        const added: StepView = {
          id: e.stepId,
          runId: e.runId,
          stepKey: e.stepKey,
          branchKey: e.branchKey,
          status,
          round: null,
          output: null,
          error: null,
          startedAt: e.at,
          finishedAt: TERMINAL.has(status) ? e.at : null,
          preview: null,
          ...patch,
        };
        return { ...view, steps: [...view.steps, added] };
      }
      const prev = view.steps[i]!;
      const next = { ...prev, ...patch, startedAt: prev.startedAt ?? (status === "pending" || status === "locked" ? null : e.at) };
      return { ...view, steps: view.steps.map((s, j) => (j === i ? next : s)) };
    }
    case "task.started":
    case "task.paused":
    case "task.resumed":
    case "task.finished": {
      if (e.runId !== view.run.id) return view;
      const i = view.tasks.findIndex((t) => t.id === e.taskId);
      if (i === -1) return view;
      const patch: Partial<Task> =
        e.type === "task.started"
          ? { status: "running", attempt: e.attempt, startedAt: e.at, engine: e.engine }
          : e.type === "task.paused"
            ? { status: "paused", pauseReason: e.reason }
            : e.type === "task.resumed"
              ? { status: "running", pauseReason: null }
              : { status: e.status, pauseReason: null, finishedAt: e.at, error: e.error };
      return { ...view, tasks: view.tasks.map((t, j) => (j === i ? ({ ...t, ...patch } as Task) : t)) };
    }
    default:
      return view;
  }
}

/** A fresh read, keeping previews only live events carried. */
export function mergeRunDetail(prev: RunView | undefined, next: RunDetail | RunView): RunView {
  const previews = new Map((prev?.steps ?? []).map((s) => [s.id, s.preview ?? null]));
  return {
    ...next,
    steps: next.steps.map((s) => ({ ...s, preview: (s as StepView).preview ?? previews.get(s.id) ?? null })),
  };
}

const num = (v: unknown) => (typeof v === "number" ? v : null);

/** The step's preview, or one derived from its output (map counts, filter items, QA rounds…). */
export function stepPreview(step: StepView): string | null {
  if (step.preview) return step.preview;
  const out = (step.output ?? {}) as Record<string, unknown>;
  const counts = out.counts as { total: number; queued: number; running: number; done: number; failed: number } | undefined;
  if (counts && typeof counts.total === "number") {
    const parts = [`${counts.done}/${counts.total} done`];
    if (counts.running) parts.push(`${counts.running} running`);
    if (counts.failed) parts.push(`${counts.failed} failed`);
    return parts.join(" · ");
  }
  if (Array.isArray(out.rounds) && out.rounds.length) {
    const totals = out.rounds.map((r) => num((r as { total?: unknown }).total)).filter((t): t is number => t !== null);
    const verdict = out.outcome === "passed" ? " · passed" : out.outcome === "escalated" ? " · not passed" : "";
    return totals.length ? `QA ${totals.join(" → ")}${verdict}` : null;
  }
  if (Array.isArray(out.items) && step.stepKey !== "scan" && step.stepKey !== "fit") return `${out.items.length} ${out.items.length === 1 ? "job" : "jobs"}`;
  if (out.cacheHit === true) return "cache hit";
  if (step.stepKey === "review" && step.status === "waiting") return out.escalated ? "QA not passed · Ba decides" : "waiting for Ba";
  if (step.stepKey === "apply" && step.status === "locked") return "unlocks after approval";
  if (typeof out.outcome === "string") return out.outcome.replace(/_/g, " ");
  return step.error ?? null;
}
