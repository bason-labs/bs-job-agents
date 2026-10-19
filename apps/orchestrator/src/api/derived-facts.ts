// Facts derived from Ba's own facts (CV auto-extend §5.7–5.8). The engine's derive step calls the
// DerivedFactSink below inside its transaction (a step advance, or the settle of a cv.derive task):
// it re-reads data/master-cv.yaml, re-runs the deterministic screen against it (Ba may have saved
// since: SEC-17) and appends what still passes as one new version, keeping the version before in
// the history, as FactDraftStore does. Each addition is recorded in data/api-state.json
// (`derivedAdds`), and model-judged implications that passed are learned in
// data/skill-implications.json. Undo, Keep and the deny list on delete are here too; the routes
// are in routes/master-cv.ts. Only this file, master-cv.ts, fact-drafts.ts and routes/master-cv.ts
// write the master CV (AD-1).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  EMPTY_LEARNED,
  LearnedImplicationsSchema,
  MasterCvSchema,
  buildDerivedFacts,
  denyEntriesFor,
  factSourceHash,
  implicationTable,
  learnedAllowFrom,
  screenDerivedFacts,
  type DerivedAddView,
  type DerivedFactsView,
  type Fact,
  type LearnedImplications,
  type MasterCv,
  type RejectedDerivedDraft,
} from "@bs-job-agents/shared";
import { appendAppEvent, getJob, getCompany, listEvents, type Db } from "../db/index.js";
import { DERIVE_REJECTED_EVENT, type DeriveAddOptions, type DeriveSource, type DerivedAddResult, type DerivedFactSink, type DerivedFactSinkContext } from "../engine/index.js";
import { zodMessage } from "./errors.js";
import { keepMasterCvVersionSync, masterCvPath, readMasterCv, readMasterCvHistory, writeMasterCvSync } from "./master-cv.js";

/** SHA-256 of data/master-cv.yaml as it is on disk, or null when it is missing. */
export function masterFileSha256(dataDir: string): string | null {
  const path = masterCvPath(dataDir);
  return existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;
}
import { readApiState, updateApiState, type ApiState, type StoredDerivedAdd } from "./state.js";

/** data/skill-implications.json: learned allow and deny entries (Ba's runtime data, gitignored with data/). */
export const SKILL_IMPLICATIONS_FILE = "skill-implications.json";
/** Additions kept in data/api-state.json (the newest). */
const KEEP_ADDS = 100;

export function readLearned(dataDir: string): LearnedImplications {
  const path = join(dataDir, SKILL_IMPLICATIONS_FILE);
  if (!existsSync(path)) return EMPTY_LEARNED;
  try {
    const parsed = LearnedImplicationsSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : EMPTY_LEARNED;
  } catch {
    return EMPTY_LEARNED;
  }
}

export function updateLearned(dataDir: string, change: (l: LearnedImplications) => LearnedImplications): LearnedImplications {
  const next = change(readLearned(dataDir));
  const path = join(dataDir, SKILL_IMPLICATIONS_FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  return next;
}

/** A master version made by an automatic addition, its Undo or a Keep (review cards ignore it). */
export function withDerivedRevision(s: ApiState, version: number): ApiState {
  return { ...s, derivedRevisions: [...s.derivedRevisions.filter((v) => v !== version), version].slice(-500) };
}

export function recordDerivedRevision(dataDir: string, version: number): void {
  updateApiState(dataDir, (s) => withDerivedRevision(s, version));
}

/** Deny the skills of derived facts Ba undid or deleted (§5.3): they are never derived again. */
export function denyDerived(dataDir: string, facts: readonly Fact[], now: Date): void {
  const entries = denyEntriesFor(facts, now);
  if (entries.length === 0) return;
  updateLearned(dataDir, (l) => ({ ...l, deny: [...l.deny, ...entries.filter((e) => !l.deny.some((d) => d.skill === e.skill))] }));
}

function saveAdd(s: ApiState, add: StoredDerivedAdd): ApiState {
  const all = { ...s.derivedAdds, [String(add.version)]: add };
  const keep = Object.values(all)
    .sort((a, b) => b.version - a.version)
    .slice(0, KEEP_ADDS);
  return { ...s, derivedAdds: Object.fromEntries(keep.map((a) => [String(a.version), a])) };
}

/** The engine's port: appends screened derived facts to the master CV, in the engine's transaction. */
export class DerivedFactStore implements DerivedFactSink {
  private dataDir: string | null;

  constructor(opts: { dataDir?: string } = {}) {
    this.dataDir = opts.dataDir ?? null;
  }

  /** Tests create the store before their temp data folder exists. */
  bind(opts: { dataDir: string }): void {
    this.dataDir = opts.dataDir;
  }

  private dir(): string {
    if (!this.dataDir) throw new Error("the derived fact store has no data folder");
    return this.dataDir;
  }

  read(): DeriveSource | null {
    const read = readMasterCv(this.dir());
    return read.kind === "ok" ? { cv: read.cv, learned: readLearned(this.dir()) } : null;
  }

  add(ctx: DerivedFactSinkContext, drafts: Parameters<DerivedFactSink["add"]>[1], opts: DeriveAddOptions): DerivedAddResult {
    const dataDir = this.dir();
    // SEC-17: the master CV as it is now (Ba, or another branch, may have saved since the draft).
    const source = this.read();
    if (!source) return { added: [], dropped: drafts.map((d) => dropped(d, "the master CV cannot be read")), version: null };
    const current = source.cv;
    const table = implicationTable(source.learned);
    const { accepted, rejected } = screenDerivedFacts(drafts, { cv: current, table, forbiddenNames: opts.company ? [opts.company] : [], limit: opts.limit, gaps: opts.gaps });
    if (accepted.length === 0) return { added: [], dropped: rejected, version: null };
    const facts = buildDerivedFacts(accepted, current, { jobId: String(ctx.jobId), taskId: ctx.task ? String(ctx.task.id) : null, now: ctx.now });
    const parsed = MasterCvSchema.safeParse({ ...current, version: current.version + 1, facts: [...current.facts, ...facts] });
    if (!parsed.success) {
      const why = `did not pass the master CV checks: ${zodMessage(parsed.error)}`;
      return { added: [], dropped: [...rejected, ...accepted.map((d) => dropped(d, why))], version: null };
    }
    const next = parsed.data;
    const job = getJob(ctx.conn, ctx.jobId);
    // The event first (rolled back with the transaction if a file write below throws), then the
    // record and the learned entries, then the files.
    appendAppEvent(
      ctx.conn,
      { type: "master_cv.updated", version: next.version, change: "facts_derived", factIds: facts.map((f) => f.id), taskId: ctx.task ? String(ctx.task.id) : null },
      { now: ctx.now },
    );
    updateApiState(dataDir, (s) =>
      saveAdd(withDerivedRevision(s, next.version), {
        version: next.version,
        previousVersion: current.version,
        at: ctx.now.toISOString(),
        runId: ctx.runId,
        jobId: String(ctx.jobId),
        company: job ? (getCompany(ctx.conn, job.companyId)?.name ?? null) : null,
        taskId: ctx.task ? ctx.task.id : null,
        facts: facts.map((f) => ({ id: f.id, text: f.text })),
        undoneAt: null,
        fileSha256: null,
      }),
    );
    const learned = learnedAllowFrom(accepted, table, ctx.now);
    if (learned.length > 0) updateLearned(dataDir, (l) => ({ ...l, allow: [...l.allow, ...learned] }));
    // Undo restores the version before: keep it in the history even if it was saved by hand.
    if (!readMasterCvHistory(dataDir, current.version)) keepMasterCvVersionSync(dataDir, current);
    writeMasterCvSync(dataDir, next);
    keepMasterCvVersionSync(dataDir, next);
    const sha = masterFileSha256(dataDir);
    updateApiState(dataDir, (s) => {
      const add = s.derivedAdds[String(next.version)];
      return add ? { ...s, derivedAdds: { ...s.derivedAdds, [String(next.version)]: { ...add, fileSha256: sha } } } : s;
    });
    return { added: facts, dropped: rejected, version: next.version };
  }
}

const dropped = (d: Parameters<DerivedFactSink["add"]>[1][number], reason: string): RejectedDerivedDraft => ({
  requirement: d.requirement,
  text: d.text,
  restsOn: d.restsOn.map((r) => r.factId),
  reasons: [reason],
  via: d.via,
});

// ---------------------------------------------------------------- the routes' logic

/** GET /master-cv/derived: additions not undone (newest first) and the latest run's rejected drafts. */
export function derivedFactsView(db: Db, dataDir: string, currentVersion: number | null): DerivedFactsView {
  const adds = Object.values(readApiState(dataDir).derivedAdds)
    .filter((a) => a.undoneAt === null)
    .sort((a, b) => b.version - a.version);
  const views: DerivedAddView[] = adds.map((a) => ({
    version: a.version,
    previousVersion: a.previousVersion,
    at: a.at,
    jobId: a.jobId,
    company: a.company,
    taskId: a.taskId === null ? null : String(a.taskId),
    facts: a.facts,
    latest: currentVersion === a.version,
  }));
  // "Not added": the rejections of the latest run that derived or rejected anything.
  const rows = listEvents(db, { types: [DERIVE_REJECTED_EVENT] });
  const runs = [...rows.map((r) => r.runId), ...adds.map((a) => a.runId)].filter((r): r is number => r !== null);
  const latestRun = runs.length > 0 ? Math.max(...runs) : null;
  const rejected = rows
    .filter((r) => r.runId === latestRun)
    .flatMap((r) => ((r.payload as { rejected?: RejectedDerivedDraft[] } | null)?.rejected ?? []));
  return { adds: views, rejected };
}

export type UndoOutcome =
  | { kind: "not_undoable" }
  | { kind: "ok"; cv: MasterCv; restoredTo: number | null; removed: { id: string; text: string }[]; add: StoredDerivedAdd };

/**
 * POST /master-cv/derived/undo (§5.8): the addition that made `version`. Still the latest revision,
 * and the file is byte for byte what it wrote: the content of the revision before, exactly
 * (REQ-18.AC-2). Otherwise (another save, or a hand edit of the YAML that kept the version): a new
 * revision without exactly the facts it added, so no later change is lost. Versions only go up.
 */
export function undoDerivedAdd(dataDir: string, current: MasterCv, version: number): UndoOutcome {
  const add = readApiState(dataDir).derivedAdds[String(version)];
  if (!add || add.undoneAt !== null) return { kind: "not_undoable" };
  const ids = new Set(add.facts.map((f) => f.id));
  const untouched = add.fileSha256 === null || add.fileSha256 === masterFileSha256(dataDir);
  if (current.version === add.version && untouched) {
    const before = readMasterCvHistory(dataDir, add.previousVersion);
    const content = before ?? { ...current, facts: current.facts.filter((f) => !ids.has(f.id)) };
    return { kind: "ok", cv: { ...content, version: current.version + 1 }, restoredTo: add.previousVersion, removed: add.facts, add };
  }
  // Only facts still derived: one Ba kept (made his own) is his now.
  const gone = current.facts.filter((f) => ids.has(f.id) && f.derived);
  const goneIds = new Set(gone.map((f) => f.id));
  return {
    kind: "ok",
    cv: { ...current, version: current.version + 1, facts: current.facts.filter((f) => !goneIds.has(f.id)) },
    restoredTo: null,
    removed: gone.map((f) => ({ id: f.id, text: f.text })),
    add,
  };
}

export type KeepOutcome = { kind: "not_found" } | { kind: "not_derived" } | { kind: "ok"; cv: MasterCv; fact: Fact };

/**
 * POST /master-cv/derived/:factId/keep (§5.8): Ba vouches for a flagged fact. Its sources all still
 * exist (as his own facts): the hashes are re-anchored and it is active again. A source is gone:
 * the derived block goes and the fact becomes Ba's own.
 */
export function keepDerivedFact(current: MasterCv, factId: string): KeepOutcome {
  const fact = current.facts.find((f) => f.id === factId);
  if (!fact) return { kind: "not_found" };
  if (!fact.derived) return { kind: "not_derived" };
  const sources = fact.derived.restsOn.map((r) => current.facts.find((f) => f.id === r.factId));
  let kept: Fact;
  if (sources.every((s) => s && !s.derived)) {
    kept = { ...fact, derived: { ...fact.derived, restsOn: fact.derived.restsOn.map((r, i) => ({ ...r, sourceHash: factSourceHash(sources[i]!) })) } };
  } else {
    const { derived: _derived, ...own } = fact;
    kept = own;
  }
  return { kind: "ok", fact: kept, cv: { ...current, version: current.version + 1, facts: current.facts.map((f) => (f.id === factId ? kept : f)) } };
}

/** Derived facts a save removed (Ba deleted them): their skills are denied (§5.8). */
export function derivedFactsRemoved(before: MasterCv | null, after: Pick<MasterCv, "facts">): Fact[] {
  if (!before) return [];
  const kept = new Set(after.facts.map((f) => f.id));
  return before.facts.filter((f) => f.derived && !kept.has(f.id));
}

/** Mark an addition undone (data/api-state.json). */
export function markUndone(dataDir: string, version: number, now: Date): void {
  updateApiState(dataDir, (s) => {
    const add = s.derivedAdds[String(version)];
    return add ? { ...s, derivedAdds: { ...s.derivedAdds, [String(version)]: { ...add, undoneAt: now.toISOString() } } } : s;
  });
}
