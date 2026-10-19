// CV auto-extend (§5.4): the `derive` step of a job's branch, after `company` and before the
// tailor gate. Deterministic first:
//   1. no gaps on the job (the fit step's) → the step settles at once, no task;
//   2. gaps an active fact (Ba's or derived) already covers, or that Ba denied, are dropped;
//   3. the implication table (no LLM) drafts the obvious skills from Ba's own facts;
//   4. only gaps that are left (and could be answered by a fact) go to one tool-less cv.derive task.
// Every draft goes through screenDerivedFacts, then the API's DerivedFactSink appends what passes as
// one new master revision, inside the transaction (it re-reads and re-screens first, SEC-17). The
// step never fails the branch: a failed cv.derive is logged and tailoring goes on (tailor raises
// fact requests for what is left). The tailor task is built after this step, so it sees the facts.
import {
  CvDeriveInputSchema,
  DERIVE_MAX_FACTS,
  DERIVE_MAX_GAPS,
  activeFacts,
  analyseGap,
  implicationTable,
  ownFacts,
  screenDerivedFacts,
  tableDrafts,
  tablePass,
  termsIn,
  type CvDeriveInput,
  type DeriveCandidate,
  type DeriveOutput,
  type Fact,
  type LearnedImplications,
  type MasterCv,
  type RejectedDerivedDraft,
  type TaskStepSchema,
} from "@bs-job-agents/shared";
import type { z } from "zod";
import { getCompany, getJob, getStep, getStepByKey, getTask, listSteps, type Conn, type Task } from "../db/index.js";
import { effectiveBot } from "./bots.js";
import type { RunCtx, Scope } from "./context.js";
import type { EngineCore } from "./core.js";
import { EngineError, errorMessage } from "./errors.js";
import { isTerminalStep, openStep, setStep } from "./steps.js";
import { createWorkflowTask, ensureStepRow } from "./task-factory.js";

type TaskStep = z.infer<typeof TaskStepSchema>;

export const DERIVE_BOT = "cv";
export const DERIVE_KIND = "derive";
export const DERIVE_TASK_KEY = "cv.derive";

/** The audit row (never streamed) listing derived drafts the screen rejected: fact ids and reasons only (SEC-15.AC-4). */
export const DERIVE_REJECTED_EVENT = "derive.rejected";

export const isDeriveTask = (task: Pick<Task, "botName" | "kind">): boolean => task.botName === DERIVE_BOT && task.kind === DERIVE_KIND;

/** What the sink reads: the master CV as it is now and the learned implications. */
export interface DeriveSource {
  cv: MasterCv;
  learned: LearnedImplications;
}

export interface DerivedFactSinkContext {
  /** The engine's transaction (a step advance or the settle of a cv.derive task). */
  conn: Conn;
  now: Date;
  runId: number | null;
  jobId: number;
  /** The cv.derive task, or null for the table pass. */
  task: Task | null;
}

export interface DerivedAddResult {
  added: Fact[];
  /** Drafts the re-screen against the current master CV dropped (Ba saved since, another branch covered it). */
  dropped: RejectedDerivedDraft[];
  /** The new master version, or null when nothing was added. */
  version: number | null;
}

/**
 * The API's port (AD-1): the only writer of the master CV for derived facts. Synchronous, inside
 * the engine's transaction, as FactDraftSink.done.
 */
export interface DerivedFactSink {
  /** The current master CV and learned implications; null when the file is missing or invalid. */
  read(): DeriveSource | null;
  /**
   * Re-read, re-screen (`company`: the job's employer, never named; `limit`: how many may still be
   * added for this job) and append what still passes as one new revision; learned implications too.
   */
  add(ctx: DerivedFactSinkContext, drafts: readonly DeriveCandidate[], opts: { company: string | null; limit: number }): DerivedAddResult;
}

/** The derive step's output (steps.output_json), kept while the cv.derive task runs. */
export interface DeriveStepOutput {
  gaps: number;
  /** Facts added by this step (table pass, then the model pass). */
  added: { id: string; text: string }[];
  rejected: number;
  /** none: no task was needed; queued: the cv.derive task runs; done / failed: it settled. */
  model: "none" | "queued" | "done" | "failed";
  taskId: number | null;
  /** Why the step did nothing (no gaps, no master CV). */
  note?: string;
  error?: string;
}

type StepState = "done" | "active" | "failed";

/** The JD lines that name a gap: what CV reads besides the gaps (at most 20 lines). */
export function requirementLines(jdText: string, gaps: readonly string[]): string[] {
  const words = new Set(gaps.flatMap((g) => [...termsIn(g).map((t) => t.toLowerCase()), ...g.toLowerCase().split(/[^\p{L}\p{N}+#./]+/u).filter((w) => w.length >= 4)]));
  const lines = jdText
    .split(/\n|(?<=[.;!?])\s+|•/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length >= 3);
  const hits = lines.filter((l) => [...words].some((w) => l.toLowerCase().includes(w)));
  return [...new Set(hits)].slice(0, 20).map((l) => (l.length > 300 ? `${l.slice(0, 297)}...` : l));
}

function auditRejected(core: EngineCore, conn: Conn, rejected: readonly RejectedDerivedDraft[], refs: { runId: number | null; taskId: number | null; jobId: number }): void {
  if (rejected.length === 0) return;
  // Fact ids, the requirement, the drafted text and the reasons; never contact data (SEC-15.AC-4).
  core.bus.audit(conn, DERIVE_REJECTED_EVENT, { jobId: String(refs.jobId), rejected: rejected.map((r) => ({ ...r })) }, { runId: refs.runId, taskId: refs.taskId });
}

/** Screen `drafts` against the source, hand what passes to the sink, audit every rejection. */
function screenAndAdd(
  core: EngineCore,
  conn: Conn,
  sink: DerivedFactSink,
  source: DeriveSource,
  drafts: readonly DeriveCandidate[],
  ctx: { runId: number | null; jobId: number; task: Task | null; company: string | null; limit: number },
): { added: Fact[]; rejected: number } {
  if (drafts.length === 0) return { added: [], rejected: 0 };
  const table = implicationTable(source.learned);
  const { accepted, rejected } = screenDerivedFacts(drafts, { cv: source.cv, table, forbiddenNames: ctx.company ? [ctx.company] : [], limit: ctx.limit });
  const result = accepted.length > 0 ? sink.add({ conn, now: core.now(), runId: ctx.runId, jobId: ctx.jobId, task: ctx.task }, accepted, { company: ctx.company, limit: ctx.limit }) : { added: [], dropped: [], version: null };
  const all = [...rejected, ...result.dropped];
  auditRejected(core, conn, all, { runId: ctx.runId, taskId: ctx.task?.id ?? null, jobId: ctx.jobId });
  return { added: result.added, rejected: all.length };
}

const view = (facts: readonly Fact[]) => facts.map((f) => ({ id: f.id, text: f.text }));

function preview(out: DeriveStepOutput): string {
  if (out.note) return out.note;
  const n = out.added.length;
  const added = n === 0 ? "no facts added" : `${n} fact${n === 1 ? "" : "s"} added`;
  if (out.model === "queued") return `${added} · CV checks ${out.gaps} gap${out.gaps === 1 ? "" : "s"}`;
  if (out.model === "failed") return `${added} · CV's check failed, tailoring goes on`;
  return added;
}

/** Start the step: gaps → coverage → table pass → (maybe) one cv.derive task. */
function startDerive(core: EngineCore, tx: Conn, ctx: RunCtx, step: TaskStep, scope: Scope): StepState {
  const sink = core.deps.derivedFacts;
  const settle = (out: DeriveStepOutput, status: "done" | "skipped" = "done"): StepState => {
    openStep(core, tx, ctx, step.key, scope, status, { output: out, preview: preview(out) });
    return "done";
  };
  const empty = (note: string): DeriveStepOutput => ({ gaps: 0, added: [], rejected: 0, model: "none", taskId: null, note });
  const job = scope.item ? getJob(tx, scope.item.jobId) : undefined;
  if (!job) return settle(empty("no job"), "skipped");
  const gaps = [...new Set((job.gaps ?? []).map((g) => g.trim()).filter(Boolean))];
  // No gaps (most jobs once the master CV has grown): no reading, no LLM.
  if (gaps.length === 0) return settle(empty("no gaps"));
  if (!sink) return settle(empty("derived facts are not wired"), "skipped");
  const source = sink.read();
  if (!source) return settle(empty("the master CV cannot be read"), "skipped");
  const company = getCompany(tx, job.companyId)?.name ?? null;
  const table = implicationTable(source.learned);
  const active = activeFacts(source.cv);
  const own = ownFacts(source.cv);
  const open = gaps.map((g) => analyseGap(g, active, table)).filter((g) => !g.covered && !g.denied);
  if (open.length === 0) return settle({ ...empty("every gap is covered"), gaps: gaps.length });
  // The table pass: code only.
  const { derivations, remaining } = tablePass(open, own, table);
  const refs = { runId: ctx.run.id, jobId: job.id, task: null, company, limit: DERIVE_MAX_FACTS };
  const fromTable = screenAndAdd(core, tx, sink, source, tableDrafts(derivations), refs);
  const out: DeriveStepOutput = { gaps: gaps.length, added: view(fromTable.added), rejected: fromTable.rejected, model: "none", taskId: null };
  // The tailor gate may start in this same advance: it must pin the version that holds these facts.
  if (fromTable.added.length > 0) ctx.masterVersion = core.deps.masterCv.version();
  const left = DERIVE_MAX_FACTS - fromTable.added.length;
  const forModel = [...new Set(remaining.filter((g) => !g.notDerivable).map((g) => g.gap))].slice(0, DERIVE_MAX_GAPS);
  const bot = effectiveBot(tx, core.deps.bots, DERIVE_BOT);
  if (forModel.length === 0 || left <= 0 || !bot.enabled) return settle(out);
  // The model pass: one tool-less task, against the master CV as the table pass left it.
  const now = sink.read() ?? source;
  const input: CvDeriveInput = {
    jobId: String(job.id),
    gaps: forModel,
    requirements: requirementLines(job.jdText ?? "", forModel),
    facts: ownFacts(now.cv).map((f) => ({ id: f.id, type: f.type, text: f.text, tags: f.tags, org: f.org, dates: f.dates })),
    masterCvVersion: now.cv.version,
  };
  const stepRow = ensureStepRow(tx, ctx, step.key, scope);
  const { task } = createWorkflowTask(core, tx, ctx, stepRow, step.task, scope, { item: scope.item, derive: CvDeriveInputSchema.parse(input) });
  setStep(core, tx, stepRow, "running", { output: { ...out, model: "queued", taskId: task.id } satisfies DeriveStepOutput, preview: preview({ ...out, model: "queued", gaps: forModel.length }) });
  return "active";
}

/** The derive step (a task step whose task is cv.derive): never fails the branch. */
export function advanceDeriveStep(core: EngineCore, ctx: RunCtx, step: TaskStep, scope: Scope): StepState {
  const row = getStepByKey(core.db, ctx.run.id, step.key, scope.branchKey);
  if (!row || row.status === "pending") {
    try {
      return core.db.transaction((tx) => startDerive(core, tx, ctx, step, scope));
    } catch (err) {
      if (!(err instanceof EngineError)) throw err;
      // Bad data must not stop the job: it is tailored without derived facts.
      core.log.warn(`derive step of job ${scope.branchKey}: ${errorMessage(err)}`);
      core.db.transaction((tx) => openStep(core, tx, ctx, step.key, scope, "skipped", { output: { gaps: 0, added: [], rejected: 0, model: "none", taskId: null, note: "skipped" } satisfies DeriveStepOutput, preview: "skipped" }));
      return "done";
    }
  }
  if (isTerminalStep(row)) return "done";
  const out = row.output as DeriveStepOutput;
  const task = out.taskId === null ? undefined : getTask(core.db, out.taskId);
  return core.db.transaction((tx) => {
    const status = task?.status;
    if (status === "done" || status === "failed" || status === "interrupted" || !task) {
      // The model's facts were added when its task settled (onDeriveDone updated the output).
      const fresh = (getStep(tx, row.id)?.output as DeriveStepOutput | null) ?? out;
      const failed = status !== "done";
      if (failed) core.log.warn(`cv.derive for job ${scope.branchKey} failed (${task?.error ?? "no task"}); tailoring goes on with ${fresh.added.length} derived fact(s)`);
      const final: DeriveStepOutput = { ...fresh, model: failed ? "failed" : "done", ...(failed ? { error: task?.error ?? "the task is missing" } : {}) };
      setStep(core, tx, row, "done", { output: final, preview: preview(final) });
      return "done";
    }
    if (status === "paused" && row.status !== "paused") setStep(core, tx, row, "paused");
    if (status !== "paused" && row.status !== "running") setStep(core, tx, row, "running");
    return "active";
  });
}

/** A settled cv.derive (in its settle transaction): screen the model's drafts, then the sink adds them. */
export function onDeriveDone(core: EngineCore, tx: Conn, task: Task, output: DeriveOutput): void {
  const sink = core.deps.derivedFacts;
  const row = task.stepId === null ? undefined : getStep(tx, task.stepId);
  const out = row?.output as DeriveStepOutput | null | undefined;
  const jobId = Number((task.input as { jobId?: unknown } | null)?.jobId);
  const source = sink?.read();
  if (!sink || !source || !Number.isInteger(jobId)) return;
  const job = getJob(tx, jobId);
  const company = job ? (getCompany(tx, job.companyId)?.name ?? null) : null;
  const drafts = output.drafts.map((d) => ({ ...d, via: "model" as const }));
  const limit = Math.max(0, DERIVE_MAX_FACTS - (out?.added.length ?? 0));
  const r = screenAndAdd(core, tx, sink, source, drafts, { runId: task.runId, jobId, task, company, limit });
  if (row && out && !isTerminalStep(row)) {
    const next: DeriveStepOutput = { ...out, added: [...out.added, ...view(r.added)], rejected: out.rejected + r.rejected };
    setStep(core, tx, row, row.status, { output: next, preview: preview(next) });
  }
}

/** Facts derived in a run, from its derive steps (the run's summary line, §5.10). */
export function derivedInRun(conn: Conn, ctx: RunCtx): { id: string; text: string }[] {
  const keys = new Set(ctx.def.steps.filter((s) => s.type === "task" && `${s.task.bot}.${s.task.kind}` === DERIVE_TASK_KEY).map((s) => s.key));
  const out: { id: string; text: string }[] = [];
  if (keys.size === 0) return out;
  for (const row of listSteps(conn, ctx.run.id)) {
    if (!keys.has(row.stepKey)) continue;
    for (const f of (row.output as Partial<DeriveStepOutput> | null)?.added ?? []) if (!out.some((x) => x.id === f.id)) out.push(f);
  }
  return out;
}

/** "Added 3 facts to your master CV automatically (Redux, CI/CD, Kubernetes). Review or undo them on the Master CV screen." */
export function derivedSummaryLine(facts: readonly { text: string }[]): string | null {
  if (facts.length === 0) return null;
  const names = facts.slice(0, 4).map((f) => f.text);
  const more = facts.length > 4 ? ` and ${facts.length - 4} more` : "";
  return `Added ${facts.length} fact${facts.length === 1 ? "" : "s"} to your master CV automatically (${names.join(", ")}${more}). Review or undo them on the Master CV screen.`;
}
