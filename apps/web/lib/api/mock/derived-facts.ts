// The mock orchestrator's derived facts (CV auto-extend), mirroring
// apps/orchestrator/src/api/derived-facts.ts and routes/master-cv.ts: `mockDeriveFacts` adds
// screened derived facts as one new master version (a scan's derive step does this in the real
// orchestrator); GET /master-cv/derived lists the additions not undone and the latest rejections;
// POST /master-cv/derived/undo restores the version before (or removes exactly the added facts when
// Ba saved since); POST /master-cv/derived/:factId/keep re-anchors a flagged fact or makes it his own.
import {
  DerivedKeepRequestSchema,
  DerivedUndoRequestSchema,
  MasterCvSchema,
  buildDerivedFacts,
  factSourceHash,
  implicationTable,
  screenDerivedFacts,
  type DeriveCandidate,
  type DerivedFactsView,
  type DerivedUndoResult,
  type Fact,
  type MasterCv,
  type RejectedDerivedDraft,
} from "@bs-job-agents/shared";
import { ApiRequestError } from "../errors";
import type { MockBackend } from "./backend";

/** One automatic addition as the mock keeps it (with the version before, for an exact Undo). */
export interface MockDerivedAdd {
  version: number;
  previousVersion: number;
  at: string;
  jobId: string | null;
  company: string | null;
  taskId: string | null;
  facts: { id: string; text: string }[];
  before: MasterCv;
  undone: boolean;
}

export interface MockDerivedState {
  adds: MockDerivedAdd[];
  /** The latest run's rejected drafts ("Not added"). */
  rejected: RejectedDerivedDraft[];
}

const fail = (status: number, code: ApiRequestError["code"], message: string, details: unknown = null) => new ApiRequestError({ status, code, message, details });

export function derivedState(core: Pick<MockBackend, "state">): MockDerivedState {
  core.state.derived ??= { adds: [], rejected: [] };
  return core.state.derived;
}

function currentCv(core: MockBackend, what: string): MasterCv {
  const m = core.state.masterCv;
  if (m.kind !== "ok") throw fail(409, "conflict", `the master CV cannot be read, so ${what}`, { reason: m.kind === "missing" ? "master_cv_missing" : "master_cv_invalid" });
  return m.cv;
}

function write(core: MockBackend, cv: MasterCv): void {
  core.state.masterCv = { kind: "ok", cv };
  core.state.masterCvVersions.push({ version: cv.version, savedAt: core.nowIso(), factCount: cv.facts.length });
}

/** A scan's derive step, in the mock: screen the drafts and add what passes as one new version. */
export function mockDeriveFacts(core: MockBackend, drafts: DeriveCandidate[], opts: { jobId?: string; company?: string; taskId?: string | null } = {}): { added: Fact[]; rejected: RejectedDerivedDraft[] } {
  const cv = currentCv(core, "nothing can be derived");
  const { accepted, rejected } = screenDerivedFacts(drafts, { cv, table: implicationTable(), forbiddenNames: opts.company ? [opts.company] : [] });
  const state = derivedState(core);
  state.rejected = rejected;
  if (accepted.length === 0) return { added: [], rejected };
  const added = buildDerivedFacts(accepted, cv, { jobId: opts.jobId ?? null, taskId: opts.taskId ?? null, now: new Date(core.nowIso()) });
  const next = MasterCvSchema.parse({ ...cv, version: cv.version + 1, facts: [...cv.facts, ...added] });
  write(core, next);
  state.adds.push({ version: next.version, previousVersion: cv.version, at: core.nowIso(), jobId: opts.jobId ?? null, company: opts.company ?? null, taskId: opts.taskId ?? null, facts: added.map((f) => ({ id: f.id, text: f.text })), before: cv, undone: false });
  core.emit({ type: "master_cv.updated", version: next.version, change: "facts_derived", factIds: added.map((f) => f.id), taskId: opts.taskId ?? null });
  return { added, rejected };
}

/** GET /master-cv/derived. */
export function readDerived(core: MockBackend): DerivedFactsView {
  const m = core.state.masterCv;
  const version = m.kind === "ok" ? m.cv.version : null;
  const state = derivedState(core);
  return {
    adds: state.adds
      .filter((a) => !a.undone)
      .sort((a, b) => b.version - a.version)
      .map(({ before: _b, undone: _u, ...a }) => ({ ...a, latest: a.version === version })),
    rejected: state.rejected,
  };
}

/** POST /master-cv/derived/undo. */
export function undoDerived(core: MockBackend, body: unknown): DerivedUndoResult {
  const parsed = DerivedUndoRequestSchema.safeParse(body);
  if (!parsed.success) throw fail(400, "validation_failed", "version is required");
  const cv = currentCv(core, "nothing can be undone");
  const add = derivedState(core).adds.find((a) => a.version === parsed.data.version && !a.undone);
  if (!add) throw fail(409, "conflict", `version ${parsed.data.version} did not add facts automatically, or it was already undone`, { reason: "not_undoable" });
  const ids = new Set(add.facts.map((f) => f.id));
  let next: MasterCv;
  let removed = add.facts;
  let restoredTo: number | null = null;
  if (cv.version === add.version) {
    next = { ...structuredClone(add.before), version: cv.version + 1 };
    restoredTo = add.previousVersion;
  } else {
    const gone = cv.facts.filter((f) => ids.has(f.id) && f.derived);
    removed = gone.map((f) => ({ id: f.id, text: f.text }));
    next = { ...cv, version: cv.version + 1, facts: cv.facts.filter((f) => !gone.includes(f)) };
  }
  write(core, next);
  add.undone = true;
  core.emit({ type: "master_cv.updated", version: next.version, change: "derived_undo", factIds: removed.map((f) => f.id), taskId: add.taskId });
  return { cv: next, restoredTo, removed };
}

/** POST /master-cv/derived/:factId/keep. */
export function keepDerived(core: MockBackend, factId: string, body: unknown): MasterCv {
  const parsed = DerivedKeepRequestSchema.safeParse(body);
  if (!parsed.success) throw fail(400, "validation_failed", "version is required");
  const cv = currentCv(core, "nothing can be kept");
  if (cv.version !== parsed.data.version) {
    throw fail(409, "conflict", `the master CV changed since you opened it (now version ${cv.version}); reload it first`, { reason: "master_cv_changed", currentVersion: cv.version });
  }
  const fact = cv.facts.find((f) => f.id === factId);
  if (!fact) throw fail(404, "not_found", `there is no fact ${factId}`);
  if (!fact.derived) throw fail(409, "conflict", `${factId} is your own fact, not one added automatically`, { reason: "not_derived" });
  const sources = fact.derived.restsOn.map((r) => cv.facts.find((f) => f.id === r.factId));
  let kept: Fact;
  if (sources.every((s) => s && !s.derived)) kept = { ...fact, derived: { ...fact.derived, restsOn: fact.derived.restsOn.map((r, i) => ({ ...r, sourceHash: factSourceHash(sources[i]!) })) } };
  else {
    const { derived: _d, ...own } = fact;
    kept = own;
  }
  const next = { ...cv, version: cv.version + 1, facts: cv.facts.map((f) => (f.id === factId ? kept : f)) };
  write(core, next);
  core.emit({ type: "master_cv.updated", version: next.version, change: "derived_keep", factIds: [factId], taskId: null });
  return next;
}
