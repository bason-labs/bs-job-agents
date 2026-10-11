// Master CV facts from Ba's own words (owner request 2026-10-11, additive). Ba answers CV's fact
// request, or tells something new, in free text; CV drafts the fact(s) (task cv.fact_draft) and the
// orchestrator checks them and adds them to data/master-cv.yaml as a new version Ba can undo.
//   POST /master-cv/facts/draft            { text, factRequestId?, version } → 202 FactDraftStarted
//   GET  /master-cv/facts/draft/:taskId    → FactDraftView (poll until settled; SSE master_cv.updated)
//   POST /master-cv/facts/undo             { version } → the restored MasterCv (a new version)
import { z } from "zod";
import { IdSchema } from "../common/primitives.js";
import { FACT_DRAFT_TEXT_MAX } from "../bots/fact-draft.js";
import { FactSchema } from "../domain/master-cv.js";

export const FactDraftRequestSchema = z
  .object({
    text: z.string().trim().min(1, "write a few words first").max(FACT_DRAFT_TEXT_MAX, `at most ${FACT_DRAFT_TEXT_MAX} characters`),
    /** The fact request Ba answers (FactRequestItem.id); null or absent for the free-text box. */
    factRequestId: z.string().min(1).nullable().optional(),
    /** The master version Ba's page shows (the stale-version rule of PUT /master-cv: 409 master_cv_changed). */
    version: z.number().int().positive(),
  })
  .strict();
export type FactDraftRequest = z.infer<typeof FactDraftRequestSchema>;

/** 202: CV's task is queued; read the result with GET /master-cv/facts/draft/:taskId. */
export const FactDraftStartedSchema = z.object({ taskId: IdSchema });
export type FactDraftStarted = z.infer<typeof FactDraftStartedSchema>;

/**
 * - queued / running: CV has not finished (queued also while its engine waits out a usage limit)
 * - added: the facts are in the master CV as `version`
 * - no_facts: CV found nothing to add (Ba said no, or every drafted fact was rejected); see notes / rejected
 * - failed: the task failed, or the facts could not be added (error)
 */
export const FactDraftStatusSchema = z.enum(["queued", "running", "added", "no_facts", "failed"]);
export type FactDraftStatus = z.infer<typeof FactDraftStatusSchema>;

export const RejectedDraftFactSchema = z.object({
  id: z.string(),
  text: z.string(),
  /** e.g. "the number 40 is not in your words". */
  reasons: z.array(z.string().min(1)).min(1),
});

/** The job whose fact request Ba answered: its CV can be tailored again (POST /steps/:id/rerun). */
export const FactDraftRetailorSchema = z.object({
  jobId: IdSchema,
  company: z.string(),
  /** The job's CV (tailor) steps in its newest run; empty when there is none to re-run. */
  stepIds: z.array(IdSchema),
  /** Why the CV can't be re-tailored from here (the run was cancelled or is gone); null when it can. */
  note: z.string().nullable(),
});
export type FactDraftRetailor = z.infer<typeof FactDraftRetailorSchema>;

export const FactDraftViewSchema = z.object({
  taskId: IdSchema,
  status: FactDraftStatusSchema,
  /** Ba's words, as sent. */
  text: z.string(),
  factRequestId: z.string().nullable(),
  /** The facts added (status added), as they are in the master CV. */
  facts: z.array(FactSchema),
  /** The master version that added them, and the one before (Undo restores it). */
  version: z.number().int().positive().nullable(),
  previousVersion: z.number().int().positive().nullable(),
  /** CV's note for Ba (why nothing was added, what it left out). */
  notes: z.string().nullable(),
  /** Drafted facts the invented-detail guard rejected (a number or name not in Ba's words). */
  rejected: z.array(RejectedDraftFactSchema),
  error: z.string().nullable(),
  /** Ba undid the addition. */
  undone: z.boolean(),
  /** Undo is possible: the addition is still the master CV's latest change. */
  undoable: z.boolean(),
  /** Set when the answered request belonged to a job (re-tailor its CV). */
  retailor: FactDraftRetailorSchema.nullable(),
});
export type FactDraftView = z.infer<typeof FactDraftViewSchema>;

export const FactUndoRequestSchema = z.object({ version: z.number().int().positive() }).strict();
export type FactUndoRequest = z.infer<typeof FactUndoRequestSchema>;
