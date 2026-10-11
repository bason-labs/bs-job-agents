// Facts from Ba's own words (owner request 2026-10-11). POST /master-cv/facts/draft queues CV's
// cv.fact_draft task and records the request here (data/api-state.json); the engine calls the
// FactDraftSink below in the transaction that settles the task, after its invented-detail guard:
// the accepted facts are checked against the MasterCv schema (fresh unique ids, types, slugs) and
// appended to data/master-cv.yaml as a new version (history kept, like PUT /master-cv), the answered
// fact request is closed, and master_cv.updated is emitted. GET /master-cv/facts/draft/:taskId
// reads the result (the web app polls it); POST /master-cv/facts/undo restores the version before.
//
// Async, not synchronous-with-timeout: a CV task can wait for its engine (a usage limit, Claude's
// two-session cap) for minutes, longer than any sensible HTTP timeout, and the facts must still be
// added when the page was closed meanwhile. The sink runs inside the settle transaction, so the
// task's result and the master CV change land together (a sink error fails the task instead).
import {
  MasterCvSchema,
  draftedToFact,
  withFreeFactIds,
  type FactDraftRetailor,
  type FactDraftView,
  type MasterCv,
} from "@bs-job-agents/shared";
import { and, eq } from "drizzle-orm";
import { appendAppEvent, getRun, getTask, schema, type Db } from "../db/index.js";
import type { FactDraftResult, FactDraftSink, FactDraftSinkContext } from "../engine/index.js";
import { zodMessage } from "./errors.js";
import { keepMasterCvVersionSync, readMasterCv, readMasterCvHistory, readMasterCvVersion, writeMasterCvSync } from "./master-cv.js";
import { readApiState, updateApiState, type ApiState, type StoredFactDraft } from "./state.js";

/** Drafts kept in data/api-state.json (the newest). */
const KEEP_DRAFTS = 50;

/** Store a draft record (and keep only the newest KEEP_DRAFTS). */
export function saveFactDraft(dataDir: string, draft: StoredFactDraft, change: (s: ApiState) => ApiState = (s) => s): void {
  updateApiState(dataDir, (s) => {
    const all = { ...s.factDrafts, [String(draft.taskId)]: draft };
    const keep = Object.values(all)
      .sort((a, b) => b.taskId - a.taskId)
      .slice(0, KEEP_DRAFTS);
    return change({ ...s, factDrafts: Object.fromEntries(keep.map((d) => [String(d.taskId), d])) });
  });
}

export function readFactDraft(dataDir: string, taskId: number): StoredFactDraft | null {
  return readApiState(dataDir).factDrafts[String(taskId)] ?? null;
}

/** A new, pending record for a draft just queued. */
export function pendingFactDraft(input: Pick<StoredFactDraft, "taskId" | "text" | "factRequestId" | "jobId" | "company" | "baseVersion" | "createdAt">): StoredFactDraft {
  return { ...input, status: "pending", facts: [], version: null, previousVersion: null, notes: null, rejected: [], error: null, settledAt: null, undoneAt: null };
}

const close = (s: ApiState, requestId: string | null): ApiState =>
  requestId && !s.dismissedFactRequests.includes(requestId) ? { ...s, dismissedFactRequests: [...s.dismissedFactRequests, requestId] } : s;

export const reopen = (s: ApiState, requestId: string | null): ApiState =>
  requestId ? { ...s, dismissedFactRequests: s.dismissedFactRequests.filter((id) => id !== requestId) } : s;

/** The engine's port: adds the accepted facts to the master CV in the settle transaction. */
export class FactDraftStore implements FactDraftSink {
  private dataDir: string | null;

  constructor(opts: { dataDir?: string } = {}) {
    this.dataDir = opts.dataDir ?? null;
  }

  /** Tests create the store before their temp data folder exists. */
  bind(opts: { dataDir: string }): void {
    this.dataDir = opts.dataDir;
  }

  private dir(): string {
    if (!this.dataDir) throw new Error("the fact draft store has no data folder");
    return this.dataDir;
  }

  done(ctx: FactDraftSinkContext, result: FactDraftResult): void {
    const dataDir = this.dir();
    const now = ctx.now.toISOString();
    const record = readFactDraft(dataDir, ctx.task.id) ?? recordFromTask(ctx);
    const notes = result.output.notes;
    const settle = (patch: Partial<StoredFactDraft>, change?: (s: ApiState) => ApiState) =>
      saveFactDraft(dataDir, { ...record, notes, rejected: result.rejected, settledAt: now, ...patch }, change);
    if (result.accepted.length === 0) {
      settle({ status: "no_facts" });
      return;
    }
    const read = readMasterCv(dataDir);
    if (read.kind !== "ok") {
      settle({ status: "failed", error: read.kind === "missing" ? "there is no master CV any more" : `data/master-cv.yaml cannot be read: ${read.detail}` });
      return;
    }
    const current = read.cv;
    // Ids are made unique against the master CV as it is now (Ba may have saved since he asked).
    const facts = withFreeFactIds(result.accepted.map(draftedToFact), current.facts.map((f) => f.id));
    const parsed = MasterCvSchema.safeParse({ ...current, version: current.version + 1, facts: [...current.facts, ...facts] });
    if (!parsed.success) {
      settle({ status: "failed", error: `CV's facts did not pass the master CV checks: ${zodMessage(parsed.error)}` });
      return;
    }
    const next = parsed.data;
    // The event first (rolled back with the task if a file write below throws), then the record
    // (failed() reverts it), then the files.
    appendAppEvent(
      ctx.conn,
      { type: "master_cv.updated", version: next.version, change: "facts_added", factIds: facts.map((f) => f.id), taskId: String(ctx.task.id) },
      { now: ctx.now },
    );
    settle({ status: "added", facts, version: next.version, previousVersion: current.version, error: null }, (s) => close(s, record.factRequestId));
    // Undo restores the version before: keep it in the history even if it was saved by hand.
    if (!readMasterCvHistory(dataDir, current.version)) keepMasterCvVersionSync(dataDir, current);
    writeMasterCvSync(dataDir, next);
    keepMasterCvVersionSync(dataDir, next);
  }

  failed(ctx: FactDraftSinkContext, error: string): void {
    const dataDir = this.dir();
    const record = readFactDraft(dataDir, ctx.task.id) ?? recordFromTask(ctx);
    // A sink error after the record said "added" rolled the task back: the request opens again.
    const wasAdded = record.status === "added" && readMasterCvVersion(dataDir) !== record.version;
    saveFactDraft(
      dataDir,
      { ...record, status: "failed", error, settledAt: ctx.now.toISOString(), ...(wasAdded ? { facts: [], version: null, previousVersion: null } : {}) },
      (s) => (wasAdded ? reopen(s, record.factRequestId) : s),
    );
  }
}

/** A draft queued without a record (it should not happen): Ba's words from the task input. */
function recordFromTask(ctx: FactDraftSinkContext): StoredFactDraft {
  const input = (ctx.task.input ?? {}) as { text?: unknown; masterCvVersion?: unknown };
  return pendingFactDraft({
    taskId: ctx.task.id,
    text: typeof input.text === "string" ? input.text : "",
    factRequestId: null,
    jobId: null,
    company: null,
    baseVersion: typeof input.masterCvVersion === "number" ? input.masterCvVersion : 1,
    createdAt: ctx.task.createdAt,
  });
}

/** The job's CV (tailor) steps in its newest run, for "Re-tailor CVs for …" (POST /steps/:id/rerun). */
export function retailorFor(db: Db, jobId: string, company: string): FactDraftRetailor {
  const tailors = db
    .select()
    .from(schema.tasks)
    .where(and(eq(schema.tasks.botName, "cv"), eq(schema.tasks.kind, "tailor")))
    .all()
    .filter((t) => t.runId !== null && String((t.input as { jobId?: unknown } | null)?.jobId ?? "") === jobId);
  const runId = tailors.reduce<number | null>((max, t) => (max === null || t.runId! > max ? t.runId : max), null);
  if (runId === null) return { jobId, company, stepIds: [], note: `${company}'s CV was not tailored in a run I can re-run; ask Lead to tailor it again.` };
  const run = getRun(db, runId);
  if (!run) return { jobId, company, stepIds: [], note: `${company}'s run is gone; ask Lead to tailor its CV again.` };
  if (run.status === "cancelled") return { jobId, company, stepIds: [], note: `${company}'s run was cancelled; ask Lead to tailor its CV again.` };
  const stepIds = [...new Set(tailors.filter((t) => t.runId === runId && t.stepId !== null).map((t) => String(t.stepId)))];
  return { jobId, company, stepIds, note: stepIds.length ? null : `${company}'s run has no CV step to re-run; ask Lead to tailor it again.` };
}

/** GET /master-cv/facts/draft/:taskId. Null when there is no such draft. */
export function factDraftView(db: Db, dataDir: string, taskId: number): FactDraftView | null {
  const rec = readFactDraft(dataDir, taskId);
  if (!rec) return null;
  const task = getTask(db, taskId);
  let status: FactDraftView["status"];
  let error = rec.error;
  if (rec.status !== "pending") status = rec.status;
  else if (!task) {
    status = "failed";
    error = "CV's task is gone";
  } else if (task.status === "running") status = "running";
  else if (task.status === "failed" || task.status === "interrupted") {
    status = "failed";
    error = task.error ?? "CV's task failed";
  } else if (task.status === "done") {
    // Settled without the sink (it should not happen): nothing was added.
    status = "failed";
    error = "CV finished, but its facts were not added";
  } else status = "queued";
  const latest = readMasterCvVersion(dataDir);
  const added = rec.status === "added" && rec.undoneAt === null;
  return {
    taskId: String(rec.taskId),
    status,
    text: rec.text,
    factRequestId: rec.factRequestId,
    facts: rec.facts,
    version: rec.version,
    previousVersion: rec.previousVersion,
    notes: rec.notes,
    rejected: rec.rejected,
    error: status === "failed" ? error : null,
    undone: rec.undoneAt !== null,
    undoable: added && latest === rec.version,
    retailor: added && rec.jobId ? retailorFor(db, rec.jobId, rec.company ?? "") : null,
  };
}

/** The addition POST /master-cv/facts/undo may revert: the one that made `version` (still undone = false). */
export function undoableDraft(dataDir: string, version: number): StoredFactDraft | null {
  return Object.values(readApiState(dataDir).factDrafts).find((d) => d.status === "added" && d.version === version && d.undoneAt === null) ?? null;
}

/** The master CV before `draft`: its saved copy, else the current one without the facts it added. */
export function masterBefore(dataDir: string, draft: StoredFactDraft, current: MasterCv): MasterCv {
  const saved = draft.previousVersion === null ? null : readMasterCvHistory(dataDir, draft.previousVersion);
  if (saved) return saved;
  const ids = new Set(draft.facts.map((f) => f.id));
  return { ...current, facts: current.facts.filter((f) => !ids.has(f.id)) };
}
