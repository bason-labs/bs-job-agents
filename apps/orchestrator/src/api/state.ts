// Small UI decisions the API keeps that have no table (W3a): a dismissed promotion suggestion
// (UC-19), a fact request Ba answered "No, I don't" (§6.1) and Lead's proposals waiting for Ba's click
// (PM3 M3/S1). data/api-state.json, written through
// a temp file and a rename; one orchestrator holds the data folder, so there is one writer.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CriteriaChangesSchema, FactSchema, RejectedDraftFactSchema, ScheduleProposalSchema } from "@bs-job-agents/shared";
import { z } from "zod";

export const API_STATE_FILE = "api-state.json";

const proposalMeta = {
  /** The Lead task that proposed it. */
  taskId: z.number().int().positive(),
  createdAt: z.string(),
  /** When Ba chose an option (single use), and which. */
  settledAt: z.string().nullable(),
  outcome: z.string().nullable(),
};

export const StoredProposalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("criteria"), changes: CriteriaChangesSchema, ...proposalMeta }),
  z.object({ kind: z.literal("schedule"), schedule: ScheduleProposalSchema, ...proposalMeta }),
]);
export type StoredProposal = z.infer<typeof StoredProposalSchema>;

/** One fact draft (POST /master-cv/facts/draft): what Ba asked and, once CV settled, what was added. */
export const StoredFactDraftSchema = z.object({
  taskId: z.number().int().positive(),
  text: z.string(),
  factRequestId: z.string().nullable(),
  /** The answered request's job and company (re-tailor its CV), null for the free-text box. */
  jobId: z.string().nullable(),
  company: z.string().nullable(),
  /** The master version Ba's page showed. */
  baseVersion: z.number().int().positive(),
  createdAt: z.string(),
  status: z.enum(["pending", "added", "no_facts", "failed"]),
  facts: z.array(FactSchema),
  version: z.number().int().positive().nullable(),
  previousVersion: z.number().int().positive().nullable(),
  notes: z.string().nullable(),
  rejected: z.array(RejectedDraftFactSchema),
  error: z.string().nullable(),
  settledAt: z.string().nullable(),
  undoneAt: z.string().nullable(),
});
export type StoredFactDraft = z.infer<typeof StoredFactDraftSchema>;

const StateSchema = z.object({
  /** Per bot: the streak count when Ba dismissed the suggestion, and when. */
  promotionDismissals: z.record(z.object({ count: z.number().int().nonnegative(), at: z.string() })).default({}),
  /** Fact request ids (`<cvVersionId>-<index>`) Ba answered "No". */
  dismissedFactRequests: z.array(z.string()).default([]),
  /**
   * PM3 M3 / S1: Lead's proposals waiting for Ba's click, by id (the id in the card key). The click
   * acts on what is stored here, never on anything the model or the browser sends at click time.
   */
  leadProposals: z.record(StoredProposalSchema).default({}),
  /** Owner request 2026-10-11: facts drafted from Ba's words, by cv.fact_draft task id (the newest kept). */
  factDrafts: z.record(StoredFactDraftSchema).default({}),
});
export type ApiState = z.infer<typeof StateSchema>;

export function readApiState(dataDir: string): ApiState {
  const path = join(dataDir, API_STATE_FILE);
  if (!existsSync(path)) return StateSchema.parse({});
  try {
    const parsed = StateSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : StateSchema.parse({});
  } catch {
    return StateSchema.parse({});
  }
}

export function updateApiState(dataDir: string, change: (state: ApiState) => ApiState): ApiState {
  const next = change(readApiState(dataDir));
  const path = join(dataDir, API_STATE_FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  return next;
}
