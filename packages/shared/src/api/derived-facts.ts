// Facts the orchestrator derived from Ba's own facts (CV auto-extend §5.7–5.8, §7, additive).
//   GET  /master-cv/derived                 → DerivedFactsView: automatic additions not undone, newest first,
//                                             and the drafts the screen rejected in the latest run ("Not added")
//   POST /master-cv/derived/undo            { version } → DerivedUndoResult (the restored or trimmed MasterCv)
//   POST /master-cv/derived/:factId/keep    { version } → the MasterCv (re-anchored, or the fact made Ba's own)
// Deleting a derived fact is a PUT /master-cv without it; the orchestrator then denies its skill.
import { z } from "zod";
import { IdSchema } from "../common/primitives.js";
import { RejectedDerivedDraftSchema } from "../bots/derive.js";
import { MasterCvSchema } from "../domain/master-cv.js";

/** One automatic addition: one master version. */
export const DerivedAddViewSchema = z.object({
  /** The master version that added the facts, and the one before. */
  version: z.number().int().positive(),
  previousVersion: z.number().int().positive(),
  at: z.string(),
  jobId: IdSchema.nullable(),
  company: z.string().nullable(),
  /** The cv.derive task, or null for a table derivation. */
  taskId: IdSchema.nullable(),
  facts: z.array(z.object({ id: z.string(), text: z.string() })),
  /** Still the master CV's latest change: Undo restores the version before exactly. */
  latest: z.boolean(),
});
export type DerivedAddView = z.infer<typeof DerivedAddViewSchema>;

export const DerivedFactsViewSchema = z.object({
  adds: z.array(DerivedAddViewSchema),
  /** Drafts the screen rejected in the latest run that derived anything, with their reasons. */
  rejected: z.array(RejectedDerivedDraftSchema),
});
export type DerivedFactsView = z.infer<typeof DerivedFactsViewSchema>;

export const DerivedUndoRequestSchema = z.object({ version: z.number().int().positive() }).strict();
export type DerivedUndoRequest = z.infer<typeof DerivedUndoRequestSchema>;

export const DerivedUndoResultSchema = z.object({
  cv: MasterCvSchema,
  /** Set when the addition was the latest change: the content is that version again. */
  restoredTo: z.number().int().positive().nullable(),
  /** The facts removed (when other changes came after the addition, only these went). */
  removed: z.array(z.object({ id: z.string(), text: z.string() })),
});
export type DerivedUndoResult = z.infer<typeof DerivedUndoResultSchema>;

/** Keep a flagged fact: the master version Ba's page shows (the stale-version rule of PUT /master-cv). */
export const DerivedKeepRequestSchema = z.object({ version: z.number().int().positive() }).strict();
export type DerivedKeepRequest = z.infer<typeof DerivedKeepRequestSchema>;
