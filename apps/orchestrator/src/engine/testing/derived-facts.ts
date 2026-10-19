// An in-memory DerivedFactSink for engine tests: the master CV lives in the MemoryFileStore (so a
// task's copy is built from it, as in production), every add is re-screened and appended as a new
// version, and the adds are recorded. The API's DerivedFactStore is tested on its own.
import {
  EMPTY_LEARNED,
  MasterCvSchema,
  buildDerivedFacts,
  implicationTable,
  learnedAllowFrom,
  screenDerivedFacts,
  type LearnedImplications,
  type MasterCv,
  type MasterCvInput,
} from "@bs-job-agents/shared";
import { parse, stringify } from "yaml";
import type { DeriveAddOptions, DeriveSource, DerivedAddResult, DerivedFactSink, DerivedFactSinkContext } from "../derive.js";
import type { FakeMasterCv, MemoryFileStore } from "./fakes.js";

export class MemoryDerivedFacts implements DerivedFactSink {
  learned: LearnedImplications = { allow: [], deny: [] };
  readonly adds: { ctx: Omit<DerivedFactSinkContext, "conn">; ids: string[]; version: number }[] = [];
  reads = 0;

  constructor(
    private readonly files: MemoryFileStore,
    private readonly masterCv: FakeMasterCv,
  ) {}

  /** Replace the master CV (a version bump, as a save by Ba). */
  set(cv: MasterCvInput): MasterCv {
    const parsed = MasterCvSchema.parse(cv);
    this.files.write(this.masterCv.path, stringify(parsed, { lineWidth: 0 }));
    this.masterCv.current = parsed.version;
    return parsed;
  }

  current(): MasterCv | null {
    const text = this.files.read(this.masterCv.path);
    const parsed = text === undefined ? null : MasterCvSchema.safeParse(parse(text));
    return parsed?.success ? parsed.data : null;
  }

  read(): DeriveSource | null {
    this.reads++;
    const cv = this.current();
    return cv ? { cv, learned: this.learned ?? EMPTY_LEARNED } : null;
  }

  add(ctx: DerivedFactSinkContext, drafts: Parameters<DerivedFactSink["add"]>[1], opts: DeriveAddOptions): DerivedAddResult {
    const cv = this.current();
    if (!cv) return { added: [], dropped: [], version: null };
    const table = implicationTable(this.learned);
    const { accepted, rejected } = screenDerivedFacts(drafts, { cv, table, forbiddenNames: opts.company ? [opts.company] : [], limit: opts.limit, gaps: opts.gaps });
    if (accepted.length === 0) return { added: [], dropped: rejected, version: null };
    const added = buildDerivedFacts(accepted, cv, { jobId: String(ctx.jobId), taskId: ctx.task ? String(ctx.task.id) : null, now: ctx.now });
    const next = this.set({ ...cv, version: cv.version + 1, facts: [...cv.facts, ...added] });
    this.learned = { ...this.learned, allow: [...this.learned.allow, ...learnedAllowFrom(accepted, table, ctx.now)] };
    const { conn: _conn, ...rest } = ctx;
    this.adds.push({ ctx: rest, ids: added.map((f) => f.id), version: next.version });
    return { added, dropped: rejected, version: next.version };
  }
}
