// What the step drawer shows for a node (UC-22): its tasks (one per map item, or CV and QA per
// gate round), the selected task's self-check, an output summary, and whether it can be re-run.
import type { SelfCheckItem, Task } from "@bs-job-agents/shared";
import type { RunView } from "@/lib/api/runs";
import type { FlowNodeData } from "./graph";

export interface DrawerTask {
  label: string;
  task: Task;
}

const SOURCE_LABELS: Record<string, string> = { topcv: "TopCV", itviec: "ITviec", linkedin: "LinkedIn" };
const BOT_NAMES: Record<string, string> = { research: "Research", cv: "CV", qa: "QA", apply: "Apply", lead: "Lead" };

function itemLabel(item: unknown): string | null {
  if (typeof item === "string") return SOURCE_LABELS[item] ?? item;
  if (item && typeof item === "object" && "title" in item && typeof item.title === "string") return item.title;
  return null;
}

/** The node's tasks in run order, each with a label a person can tell apart. */
export function nodeTasks(view: RunView, data: FlowNodeData): DrawerTask[] {
  const rows = view.steps.filter((s) => data.stepIds.includes(s.id));
  const out: DrawerTask[] = [];
  for (const row of rows) {
    const tasks = view.tasks.filter((t) => t.stepId === row.id);
    const o = (row.output ?? {}) as {
      items?: { item?: unknown; taskId?: number | string }[];
      rounds?: { producerTaskId?: number | string; checkerTaskId?: number | string | null }[];
      language?: string;
    };
    const lang = (o.language ?? row.branchKey?.split(":")[1] ?? "").toUpperCase();
    for (const task of tasks) {
      let label: string | null = null;
      const item = o.items?.find((i) => String(i.taskId) === task.id);
      if (item) label = itemLabel(item.item);
      const r = o.rounds?.findIndex((x) => String(x.producerTaskId) === task.id || String(x.checkerTaskId) === task.id) ?? -1;
      if (r >= 0) label = `${lang ? `${lang} · ` : ""}Round ${r + 1} · ${task.botName === "qa" ? "QA" : "CV"}`;
      out.push({ label: label ?? `${BOT_NAMES[task.botName] ?? task.botName} · ${task.kind}${task.attempt > 1 ? ` (attempt ${task.attempt})` : ""}`, task });
    }
  }
  return out;
}

export function defaultTask(tasks: readonly DrawerTask[]): DrawerTask | null {
  return tasks.find((t) => t.task.status === "running" || t.task.status === "paused" || t.task.status === "waiting_limit") ?? tasks.at(-1) ?? null;
}

/** Rule 4: the bot's own checklist, from its output. */
export function selfCheckOf(task: Task): SelfCheckItem[] {
  const items = (task.output as { selfCheck?: unknown } | null)?.selfCheck;
  if (!Array.isArray(items)) return [];
  return items.filter((i): i is SelfCheckItem => !!i && typeof i === "object" && typeof (i as SelfCheckItem).item === "string");
}

/** One line about what the task produced. */
export function outputSummary(task: Task): string {
  const o = (task.output ?? null) as Record<string, unknown> | null;
  if (!o) return task.status === "running" ? "working…" : task.error ? `error: ${task.error}` : "no output";
  const key = `${task.botName}.${task.kind}`;
  if (Array.isArray(o.jobs)) return `${o.jobs.length} JobCandidate${typeof o.pageViews === "number" ? ` · ${o.pageViews} page views` : ""}`;
  if (o.fit && typeof o.fit === "object") return `FitScore ${(o.fit as { score?: number }).score ?? "?"}`;
  if (o.company && typeof o.company === "object") return `CompanyProfile (${(o.company as { confidence?: string }).confidence ?? "?"})`;
  if (key === "qa.review" && typeof o.total === "number") {
    const passed = o.total >= 80 && (!Array.isArray(o.hardFails) || o.hardFails.length === 0);
    return `QaReview ${o.total} · ${passed ? "passed" : "not passed"}`;
  }
  if (key === "cv.tailor") return `CvDraft${typeof o.figmaFrameName === "string" ? ` (Figma frame ${o.figmaFrameName})` : ""}`;
  if (typeof o.status === "string") return `ApplyResult: ${o.status}`;
  return Object.keys(o).slice(0, 4).join(", ");
}

/** UC-23: a finished or failed step can be re-run; Apply, the record and the review never. */
export function canRerun(data: FlowNodeData): { allowed: boolean; reason: string | null } {
  if (data.kind === "trigger") return { allowed: false, reason: "The trigger is not a step." };
  if (data.kind === "human") return { allowed: false, reason: "The review step is your decision: use the review card." };
  if (data.kind === "action") {
    return { allowed: false, reason: data.preview === "submitted" ? "A submitted apply step can never be re-run." : "Apply is never re-run; approve the card again instead." };
  }
  if (data.kind === "record") return { allowed: false, reason: "The submission record is written once and never changes." };
  if (!["done", "failed", "skipped"].includes(data.status) || data.stepIds.length === 0) return { allowed: false, reason: "Only a finished or failed step can be re-run." };
  return { allowed: true, reason: null };
}
