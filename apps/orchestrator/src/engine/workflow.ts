// The workflow engine (§7.1): advances a run step by step from what the database says. Every
// call is idempotent, so a restart simply calls it again (UC-18). Run-level steps run in order;
// steps with `branch: <key>` run once per item of that step (per-job pipelines), and one branch
// never waits for another. Task steps finish when their task settles (queue.ts); pure steps
// (join, filter, record) run here, inside the same call.
import {
  PRE_SUBMIT_APPLICATION_STATUSES,
  cvLanguagesForJd,
  taskKey,
  type ActionStepSchema,
  type FilterStepSchema,
  type GateStepSchema,
  type HumanStepSchema,
  type JoinStepSchema,
  type MapStepSchema,
  type RecordStepSchema,
  type TaskStepSchema,
  type WorkflowStep,
} from "@bs-job-agents/shared";
import type { z } from "zod";
import {
  getApplication,
  getFreshCompanyProfile,
  getJob,
  getStepByKey,
  getSubmissionRecord,
  getTask,
  listTasks,
  updateRunStatus,
  type Conn,
  type Step,
} from "../db/index.js";
import { writeRecordStep } from "./apply.js";
import { RUN_SCOPE, loadRunCtx, templateScope, type RunCtx, type Scope } from "./context.js";
import type { EngineCore } from "./core.js";
import { EngineError, errorMessage } from "./errors.js";
import { runFilter } from "./filters.js";
import { pollGate, startGate } from "./gate.js";
import { startReview } from "./review.js";
import type {
  ActionStepOutput,
  FilterStepOutput,
  GateStepOutput,
  HumanStepOutput,
  JobRef,
  JoinStepOutput,
  MapCounts,
  MapItemState,
  MapStepOutput,
  TaskStepRunning,
} from "./state.js";
import { isTerminalStep, openStep, setStep } from "./steps.js";
import { createWorkflowTask, ensureStepRow } from "./task-factory.js";
import { resolveList, resolveTemplate } from "./templates.js";

type TaskStep = z.infer<typeof TaskStepSchema>;
type MapStep = z.infer<typeof MapStepSchema>;
type JoinStep = z.infer<typeof JoinStepSchema>;
type FilterStep = z.infer<typeof FilterStepSchema>;
type GateStep = z.infer<typeof GateStepSchema>;
type HumanStep = z.infer<typeof HumanStepSchema>;
type ActionStep = z.infer<typeof ActionStepSchema>;
type RecordStep = z.infer<typeof RecordStepSchema>;

export type StepState = "done" | "active" | "failed";

function terminalState(row: Step): StepState {
  return row.status === "failed" || row.status === "cancelled" ? "failed" : "done";
}

/** Run a step body in a transaction; an EngineError (bad input, missing data) fails the step. */
function guarded(core: EngineCore, ctx: RunCtx, key: string, scope: Scope, body: (tx: Conn) => StepState): StepState {
  try {
    return core.db.transaction((tx) => body(tx));
  } catch (err) {
    if (!(err instanceof EngineError)) throw err;
    core.db.transaction((tx) => openStep(core, tx, ctx, key, scope, "failed", { error: errorMessage(err) }));
    return "failed";
  }
}

// ---------------------------------------------------------------- task

function taskPreview(output: unknown): string | null {
  const o = output as Record<string, unknown> | null;
  if (!o) return null;
  if (Array.isArray(o.jobs)) return `${o.jobs.length} JobCandidate`;
  if (o.company && typeof o.company === "object") return `profile: ${(o.company as { name?: string }).name ?? ""}`.trim();
  return null;
}

function advanceTaskStep(core: EngineCore, ctx: RunCtx, step: TaskStep, scope: Scope): StepState {
  const row = getStepByKey(core.db, ctx.run.id, step.key, scope.branchKey);
  if (!row || row.status === "pending") {
    return guarded(core, ctx, step.key, scope, (tx) => {
      // UC-05 a: a company profile younger than cacheDays is reused (cache hit shown on the node).
      if (taskKey(step.task.bot, step.task.kind) === "research.company" && step.cacheDays && scope.item) {
        const job = getJob(tx, scope.item.jobId);
        const fresh = job ? getFreshCompanyProfile(tx, job.companyId, { now: core.now(), maxAgeDays: step.cacheDays }) : undefined;
        if (fresh?.profile) {
          openStep(core, tx, ctx, step.key, scope, "skipped", { output: { company: fresh.profile, cacheHit: true }, preview: "cache hit" });
          return "done";
        }
      }
      const stepRow = ensureStepRow(tx, ctx, step.key, scope);
      const { task } = createWorkflowTask(core, tx, ctx, stepRow, step.task, scope, { item: scope.item });
      setStep(core, tx, stepRow, "running", { output: { taskId: task.id } satisfies TaskStepRunning });
      return "active";
    });
  }
  if (isTerminalStep(row)) return terminalState(row);
  const taskId = (row.output as TaskStepRunning | null)?.taskId;
  const task = taskId === undefined ? undefined : getTask(core.db, taskId);
  return core.db.transaction((tx) => {
    if (!task) {
      setStep(core, tx, row, "failed", { error: "the step's task is missing" });
      return "failed";
    }
    switch (task.status) {
      case "done":
        setStep(core, tx, row, "done", { output: task.output, preview: taskPreview(task.output) });
        return "done";
      case "failed":
      case "interrupted":
        setStep(core, tx, row, "failed", { error: task.error ?? "the task failed" });
        return "failed";
      case "paused":
        if (row.status !== "paused") setStep(core, tx, row, "paused");
        return "active";
      default:
        if (row.status !== "running") setStep(core, tx, row, "running");
        return "active";
    }
  });
}

// ---------------------------------------------------------------- map / join / filter

function countsOf(items: readonly MapItemState[], statuses: readonly (string | undefined)[]): MapCounts {
  const counts: MapCounts = { total: items.length, queued: 0, running: 0, done: 0, failed: 0 };
  for (const s of statuses) {
    if (s === "done") counts.done++;
    else if (s === "failed" || s === "interrupted" || s === undefined) counts.failed++;
    else if (s === "running") counts.running++;
    else counts.queued++;
  }
  return counts;
}

function advanceMapStep(core: EngineCore, ctx: RunCtx, step: MapStep, scope: Scope): StepState {
  const row = getStepByKey(core.db, ctx.run.id, step.key, scope.branchKey);
  const key = taskKey(step.task.bot, step.task.kind);
  if (!row || row.status === "pending") {
    return guarded(core, ctx, step.key, scope, (tx) => {
      const items = resolveList(step.over, templateScope(tx, ctx, scope));
      if (!items) {
        openStep(core, tx, ctx, step.key, scope, "failed", { error: `"over" (${step.over}) did not resolve to a list` });
        return "failed";
      }
      const stepRow = ensureStepRow(tx, ctx, step.key, scope);
      const states: MapItemState[] = items.map((item) => {
        // One item whose input cannot be built fails alone; the others still run.
        try {
          const { task, jobId } = createWorkflowTask(core, tx, ctx, stepRow, step.task, { ...scope, item: item as JobRef }, { item });
          return jobId === undefined ? { item, taskId: task.id } : { item, taskId: task.id, jobId };
        } catch (err) {
          if (!(err instanceof EngineError)) throw err;
          return { item, taskId: -1, status: "failed" as const, error: errorMessage(err) };
        }
      });
      const counts = countsOf(states, states.map((s) => (s.taskId < 0 ? "failed" : "queued")));
      const output: MapStepOutput = { taskKey: key, items: states, counts };
      if (states.every((s) => s.taskId < 0)) {
        setStep(core, tx, stepRow, "done", { output, preview: items.length === 0 ? "nothing to do" : `${counts.failed} failed`, counts });
        return "done";
      }
      setStep(core, tx, stepRow, "running", { output, counts, preview: `×${items.length}` });
      return "active";
    });
  }
  if (isTerminalStep(row)) return terminalState(row);
  const out = row.output as MapStepOutput;
  const tasks = out.items.map((i) => (i.taskId < 0 ? undefined : getTask(core.db, i.taskId)));
  const statuses = tasks.map((t, idx) => (out.items[idx]!.taskId < 0 ? "failed" : t?.status));
  const counts = countsOf(out.items, statuses);
  return core.db.transaction((tx) => {
    const allSettled = statuses.every((s) => s === "done" || s === "failed" || s === "interrupted");
    if (allSettled) {
      const items: MapItemState[] = out.items.map((i, idx) => {
        const t = tasks[idx];
        if (i.taskId < 0 || !t) return { ...i, status: "failed" as const, error: i.error ?? "no task" };
        return t.status === "done" ? { ...i, status: "done" as const, output: t.output } : { ...i, status: "failed" as const, error: t.error ?? "failed" };
      });
      setStep(core, tx, row, "done", { output: { ...out, items, counts }, counts, preview: `${counts.done} done, ${counts.failed} failed` });
      return "done";
    }
    if (JSON.stringify(counts) !== JSON.stringify(out.counts)) {
      setStep(core, tx, row, "running", { output: { ...out, counts }, counts });
    }
    return "active";
  });
}

function advanceJoinStep(core: EngineCore, ctx: RunCtx, step: JoinStep, scope: Scope): StepState {
  const row = getStepByKey(core.db, ctx.run.id, step.key, scope.branchKey);
  if (row && isTerminalStep(row)) return terminalState(row);
  const map = getStepByKey(core.db, ctx.run.id, step.of, scope.branchKey);
  if (!map || map.status !== "done") return "active";
  const out = map.output as MapStepOutput;
  const results = out.items.filter((i) => i.status === "done").map((i) => ({ item: i.item, jobId: i.jobId, output: i.output }));
  const failures = out.items.filter((i) => i.status !== "done").map((i) => ({ item: i.item, jobId: i.jobId, error: i.error ?? "failed" }));
  const output: JoinStepOutput = { taskKey: out.taskKey, results, failures };
  return core.db.transaction((tx) => {
    // §7.1: continue with successes and record failures, unless requireAll. Nothing at all is a failure.
    if ((step.requireAll && failures.length > 0) || (out.items.length > 0 && results.length === 0)) {
      openStep(core, tx, ctx, step.key, scope, "failed", { output, error: `${failures.length} of ${out.items.length} failed` });
      return "failed";
    }
    openStep(core, tx, ctx, step.key, scope, "done", { output, preview: `${results.length} ok${failures.length ? `, ${failures.length} failed` : ""}` });
    return "done";
  });
}

function filterPreview(fn: string, out: FilterStepOutput): string {
  if (fn === "top") return out.items.length === 0 ? "no strong matches" : `top ${out.items.length}`;
  if (Array.isArray(out.alreadyApplied) && out.alreadyApplied.length > 0 && out.items.length === 0) return "already applied";
  return `${out.items.length} new${typeof out.duplicates === "number" ? `, ${out.duplicates} duplicates` : ""}`;
}

function advanceFilterStep(core: EngineCore, ctx: RunCtx, step: FilterStep, scope: Scope): StepState {
  const row = getStepByKey(core.db, ctx.run.id, step.key, scope.branchKey);
  if (row && isTerminalStep(row)) return terminalState(row);
  return guarded(core, ctx, step.key, scope, (tx) => {
    const from = getStepByKey(tx, ctx.run.id, step.from, scope.branchKey)?.output;
    const options = (resolveTemplate(step.options, templateScope(tx, ctx, scope)) ?? {}) as Record<string, unknown>;
    const out = runFilter(tx, ctx, step.fn, from, options, core.now());
    openStep(core, tx, ctx, step.key, scope, "done", { output: out, preview: filterPreview(step.fn, out) });
    return "done";
  });
}

// ---------------------------------------------------------------- gate

function advanceGateStep(core: EngineCore, ctx: RunCtx, step: GateStep, scope: Scope & { language: NonNullable<Scope["language"]> }): StepState {
  const row = getStepByKey(core.db, ctx.run.id, step.key, scope.branchKey);
  if (!row || row.status === "pending") {
    return guarded(core, ctx, step.key, scope, (tx) => {
      startGate(core, tx, ctx, step, scope);
      return "active";
    });
  }
  if (isTerminalStep(row)) return terminalState(row);
  return core.db.transaction((tx) => pollGate(core, tx, row));
}

/** The gate rows of one job: one per CV language (§6.3), keyed `<jobId>:<lang>`. */
export function gateScopes(conn: Conn, step: GateStep, item: JobRef): (Scope & { language: "en" | "vi" })[] {
  const job = getJob(conn, item.jobId);
  const languages = cvLanguagesForJd(job?.language ?? "en");
  return (step.perLanguage ? languages : languages.slice(0, 1)).map((language) => ({
    branchKey: step.perLanguage ? `${item.jobId}:${language}` : String(item.jobId),
    item,
    language,
  }));
}

function advanceGateGroup(core: EngineCore, ctx: RunCtx, step: GateStep, item: JobRef): StepState {
  const states = gateScopes(core.db, step, item).map((scope) => advanceGateStep(core, ctx, step, scope));
  if (states.includes("active")) return "active";
  // A language whose gate failed drops out of the review; all failed = the branch failed.
  return states.every((s) => s === "failed") ? "failed" : "done";
}

// ---------------------------------------------------------------- human / action / record

function advanceHumanStep(core: EngineCore, ctx: RunCtx, step: HumanStep, scope: Scope): StepState {
  const row = getStepByKey(core.db, ctx.run.id, step.key, scope.branchKey);
  if (row && isTerminalStep(row)) return terminalState(row);
  if (row && row.status === "waiting") return "active";
  return guarded(core, ctx, step.key, scope, (tx) => startReview(core, tx, ctx, step, scope, row));
}

function advanceActionStep(core: EngineCore, ctx: RunCtx, step: ActionStep, scope: Scope): StepState {
  const row = getStepByKey(core.db, ctx.run.id, step.key, scope.branchKey);
  if (!row) {
    core.db.transaction((tx) => openStep(core, tx, ctx, step.key, scope, "locked"));
    return "active";
  }
  if (isTerminalStep(row)) return terminalState(row);
  if (row.status === "locked" || row.status === "pending") return "active";
  const out = row.output as ActionStepOutput;
  const task = out.taskId === null ? undefined : getTask(core.db, out.taskId);
  return core.db.transaction((tx) => {
    if (!task) {
      setStep(core, tx, row, "failed", { error: "the Apply task is missing" });
      return "failed";
    }
    switch (task.status) {
      case "done": {
        const outcome = out.outcome ?? ((task.output as { status?: string } | null)?.status === "submitted" ? "submitted" : "needs_check");
        setStep(core, tx, row, "done", { output: { ...out, outcome }, preview: outcome === "submitted" ? "submitted" : "needs check" });
        return "done";
      }
      case "failed":
      case "interrupted": {
        const outcome = out.outcome ?? "needs_check";
        // Denied before anything ran (e.g. the token expired while Apply waited for Ba): the
        // card waits for Ba to approve again, which issues a new token (PM M2).
        if (outcome === "denied" && out.applicationId !== null && canApproveAgain(tx, out.applicationId)) {
          setStep(core, tx, row, "locked", { output: { ...out, outcome }, error: out.error ?? task.error, preview: "approve again" });
          return "active";
        }
        // Refused (SHA-256) or denied for good: red, Ba acts. Otherwise it may have submitted:
        // needs_check, never retried (UC-11 c, UC-18, PM FYI c).
        if (outcome === "denied" || outcome === "refused") {
          setStep(core, tx, row, "failed", { output: { ...out, outcome }, error: out.error ?? task.error });
          return "failed";
        }
        setStep(core, tx, row, "done", { output: { ...out, outcome, error: out.error ?? task.error }, preview: "needs check" });
        return "done";
      }
      case "paused":
        if (row.status !== "paused") setStep(core, tx, row, "paused");
        return "active";
      default:
        if (row.status !== "running") setStep(core, tx, row, "running");
        return "active";
    }
  });
}

/** Still in the apply flow with nothing recorded: Ba may approve again (PM M2). */
export function canApproveAgain(conn: Conn, applicationId: number): boolean {
  const app = getApplication(conn, applicationId);
  return (
    app !== undefined &&
    (PRE_SUBMIT_APPLICATION_STATUSES as readonly string[]).includes(app.status) &&
    getSubmissionRecord(conn, applicationId)?.submission === undefined
  );
}

function advanceRecordStep(core: EngineCore, ctx: RunCtx, step: RecordStep, scope: Scope): StepState {
  const row = getStepByKey(core.db, ctx.run.id, step.key, scope.branchKey);
  if (row && isTerminalStep(row)) return terminalState(row);
  if (step.fn !== "submission") {
    core.db.transaction((tx) => openStep(core, tx, ctx, step.key, scope, "done", { output: {} }));
    return "done";
  }
  const action = ctx.def.steps.find((s) => s.type === "action" && s.branch === step.branch);
  const actionRow = action ? getStepByKey(core.db, ctx.run.id, action.key, scope.branchKey) : undefined;
  if (!actionRow) return "active";
  if (actionRow.status === "skipped") {
    core.db.transaction((tx) => openStep(core, tx, ctx, step.key, scope, "skipped", { output: { recorded: false } }));
    return "done";
  }
  if (actionRow.status !== "done") return "active";
  return guarded(core, ctx, step.key, scope, (tx) => writeRecordStep(core, tx, ctx, step.key, scope, actionRow));
}

// ---------------------------------------------------------------- dispatch by type

function advanceStep(core: EngineCore, ctx: RunCtx, step: WorkflowStep, scope: Scope): StepState {
  switch (step.type) {
    case "task":
      return advanceTaskStep(core, ctx, step, scope);
    case "map":
      return advanceMapStep(core, ctx, step, scope);
    case "join":
      return advanceJoinStep(core, ctx, step, scope);
    case "filter":
      return advanceFilterStep(core, ctx, step, scope);
    case "gate":
      return advanceGateGroup(core, ctx, step, scope.item!);
    case "human":
      return advanceHumanStep(core, ctx, step, scope);
    case "action":
      return advanceActionStep(core, ctx, step, scope);
    case "record":
      return advanceRecordStep(core, ctx, step, scope);
  }
}

export function branchItems(conn: Conn, ctx: RunCtx, sourceKey: string): JobRef[] {
  const out = getStepByKey(conn, ctx.run.id, sourceKey, "")?.output as FilterStepOutput | null | undefined;
  return (out?.items ?? []).filter((i): i is JobRef => typeof (i as JobRef | null)?.jobId === "number");
}

function advanceBranch(core: EngineCore, ctx: RunCtx, steps: WorkflowStep[], item: JobRef): StepState {
  for (const step of steps) {
    const state = step.type === "gate" ? advanceGateGroup(core, ctx, step, item) : advanceStep(core, ctx, step, { branchKey: String(item.jobId), item });
    if (state !== "done") return state;
  }
  return "done";
}

// ---------------------------------------------------------------- the run

export interface BranchOutcome {
  item: JobRef;
  state: StepState;
}

function summaryOf(core: EngineCore, ctx: RunCtx, branches: BranchOutcome[]): string {
  if (branches.length === 0) {
    for (const step of ctx.def.steps) {
      const out = getStepByKey(core.db, ctx.run.id, step.key, "")?.output as FilterStepOutput | null | undefined;
      if (step.type === "filter" && Array.isArray(out?.alreadyApplied) && out.alreadyApplied.length > 0) return "Already applied to this job";
    }
    const top = ctx.def.steps.find((s) => s.type === "filter" && s.fn === "top");
    const out = top ? (getStepByKey(core.db, ctx.run.id, top.key, "")?.output as FilterStepOutput | null | undefined) : undefined;
    const below = (out?.belowThreshold as { title: string; company: string; fitScore: number }[] | undefined) ?? [];
    return below.length > 0
      ? `No strong matches. Best below the threshold: ${below.map((b) => `${b.company} – ${b.title} (fit ${b.fitScore})`).join("; ")}`
      : "No strong matches";
  }
  const counts = { submitted: 0, needsCheck: 0, skipped: 0, failed: 0 };
  const human = ctx.def.steps.find((s) => s.type === "human");
  const action = ctx.def.steps.find((s) => s.type === "action");
  for (const b of branches) {
    if (b.state === "failed") {
      counts.failed++;
      continue;
    }
    const decisions = human ? (getStepByKey(core.db, ctx.run.id, human.key, String(b.item.jobId))?.output as HumanStepOutput | null)?.decisions : undefined;
    if (decisions?.at(-1)?.decision === "skip") counts.skipped++;
    const outcome = action ? (getStepByKey(core.db, ctx.run.id, action.key, String(b.item.jobId))?.output as ActionStepOutput | null)?.outcome : null;
    if (outcome === "submitted") counts.submitted++;
    if (outcome === "needs_check") counts.needsCheck++;
  }
  const parts = [
    `${branches.length} job${branches.length === 1 ? "" : "s"}`,
    counts.submitted ? `${counts.submitted} submitted` : null,
    counts.needsCheck ? `${counts.needsCheck} need a check` : null,
    counts.skipped ? `${counts.skipped} skipped` : null,
    counts.failed ? `${counts.failed} failed` : null,
  ];
  return parts.filter(Boolean).join(", ");
}

function finishRun(core: EngineCore, ctx: RunCtx, status: "done" | "failed", summary: string | null, error: string | null): void {
  core.db.transaction((tx) => {
    updateRunStatus(tx, ctx.run.id, status, { now: core.now(), error });
    core.bus.emit(tx, { type: "run.finished", runId: String(ctx.run.id), status, summary });
  });
}

/**
 * Advance a run from the database state. Nothing new starts while the run is paused (UC-23).
 * The run is `running` while it has queued or running tasks, `waiting` while it waits only for
 * Ba, a bridge or an engine limit, and finishes when every step and branch has.
 */
export function advanceRun(core: EngineCore, runId: number): void {
  const ctx = loadRunCtx(core, runId);
  if (!ctx || ["done", "failed", "cancelled", "paused"].includes(ctx.run.status)) return;
  let failure: string | null = null;
  let active = false;
  const branches: BranchOutcome[] = [];
  for (const step of ctx.def.steps) {
    if (step.branch) continue;
    const state = advanceStep(core, ctx, step, RUN_SCOPE);
    if (state === "failed") {
      failure = `${step.key}: ${getStepByKey(core.db, runId, step.key, "")?.error ?? "failed"}`;
      break;
    }
    if (state === "active") {
      active = true;
      break;
    }
    const branchSteps = ctx.def.steps.filter((s) => s.branch === step.key);
    if (branchSteps.length === 0) continue;
    for (const item of branchItems(core.db, ctx, step.key)) branches.push({ item, state: advanceBranch(core, ctx, branchSteps, item) });
  }
  if (failure) return finishRun(core, ctx, "failed", null, failure);
  if (!active && branches.every((b) => b.state !== "active")) {
    const allFailed = branches.length > 0 && branches.every((b) => b.state === "failed");
    return finishRun(core, ctx, allFailed ? "failed" : "done", summaryOf(core, ctx, branches), allFailed ? "every job's branch failed" : null);
  }
  const busy = listTasks(core.db, { runId, status: ["queued", "running"] }).length > 0;
  const desired = busy ? "running" : "waiting";
  if (ctx.run.status !== desired) {
    core.db.transaction((tx) => {
      updateRunStatus(tx, runId, desired, { now: core.now() });
      core.bus.emit(tx, { type: "run.updated", runId: String(runId), status: desired });
    });
  }
}

/** The gate rows' outputs of one job (review card data). */
export function gateOutputsOf(conn: Conn, ctx: RunCtx, item: JobRef): { row: Step; out: GateStepOutput }[] {
  const gate = ctx.def.steps.find((s): s is GateStep => s.type === "gate");
  if (!gate) return [];
  return gateScopes(conn, gate, item)
    .map((scope) => getStepByKey(conn, ctx.run.id, gate.key, scope.branchKey))
    .filter((row): row is Step => row !== undefined)
    .map((row) => ({ row, out: row.output as GateStepOutput }));
}

export { ensureStepRow };
