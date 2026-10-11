// Flow canvas data (§11, UC-22): a one-line preview per step (the latest progress line of its
// running task, else a summary of its output) and the definition the run started with.
import type { WorkflowDefinition } from "@bs-job-agents/shared";
import { listEvents, type Db, type Step, type Task } from "../../db/index.js";
import type { WorkflowSource } from "../../engine/index.js";

const PREVIEW_MAX = 140;
const clip = (text: string): string => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= PREVIEW_MAX ? one : `${one.slice(0, PREVIEW_MAX - 1)}…`;
};

/** A short summary of a step's output (counts, a status), never the raw object. */
export function outputPreview(output: unknown): string | null {
  if (output === null || output === undefined) return null;
  if (Array.isArray(output)) return `${output.length} item${output.length === 1 ? "" : "s"}`;
  if (typeof output !== "object") return clip(String(output));
  const o = output as Record<string, unknown>;
  for (const key of ["jobs", "items", "results", "kept"]) {
    const v = o[key];
    if (Array.isArray(v)) return `${v.length} ${key === "jobs" ? (v.length === 1 ? "job" : "jobs") : key}`;
  }
  if (typeof o.total === "number") return `score ${o.total}`;
  if (typeof o.status === "string") return o.status.replace(/_/g, " ");
  if (typeof o.decision === "string") return o.decision.replace(/_/g, " ");
  return null;
}

export function stepPreviews(db: Db, runId: number, steps: readonly Step[], tasks: readonly Task[]): Record<string, string> {
  const latest = new Map<string, string>();
  for (const row of listEvents(db, { types: ["task.progress"], runId })) {
    const p = row.payload as { taskId?: unknown; text?: unknown };
    if (typeof p.taskId === "string" && typeof p.text === "string" && p.text.trim() !== "") latest.set(p.taskId, p.text);
  }
  const out: Record<string, string> = {};
  for (const step of steps) {
    const running = tasks.filter((t) => t.stepId === step.id && t.status === "running").at(-1);
    const live = running ? latest.get(String(running.id)) : undefined;
    const text = live ? clip(live) : step.error ? clip(step.error) : outputPreview(step.output);
    if (text) out[String(step.id)] = text;
  }
  return out;
}

export function runDefinition(workflows: WorkflowSource | null | undefined, name: string, version: number): WorkflowDefinition | null {
  try {
    return workflows?.get(name, version) ?? null;
  } catch {
    return null;
  }
}
