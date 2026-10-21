// Data access for the Master CV screen (UC-20, §6.1): an adapter over lib/api (the orchestrator in
// live mode, the mock backend otherwise). Shapes are the shared schemas:
//   GET  /master-cv                         → MasterCvSchema, mapped to a read state: 404 → missing,
//                                             409 { reason: "master_cv_invalid" } → invalid (the message is the detail)
//   PUT  /master-cv                         → body MasterCvUpdateRequestSchema (with the version it was loaded at); the
//                                             server bumps the version, or answers 409 { reason: "master_cv_changed",
//                                             currentVersion } when the file changed since (another tab, a hand edit)
//   GET  /master-cv/versions                → MasterCvVersionsResponseSchema (newest first)
//   GET  /master-cv/fact-requests           → FactRequestsResponseSchema (facts CV asked for, still open)
//   POST /master-cv/fact-requests/:id/dismiss → { ok: true }; 404 when it is no longer open
// Owner request 2026-10-11 (facts from Ba's own words):
//   POST /master-cv/facts/draft             → body FactDraftRequestSchema { text, factRequestId?, version }; 202
//                                             FactDraftStartedSchema { taskId }; 409 master_cv_changed like PUT
//   GET  /master-cv/facts/draft/:taskId     → FactDraftViewSchema, polled until it settles (added / no_facts / failed)
//   POST /master-cv/facts/undo              → body FactUndoRequestSchema { version }; the restored MasterCv (a new version)
//   POST /steps/:id/rerun                   → WebApi.rerunStep: re-tailor the CVs of the jobs Ba answered for
// CV auto-extend (facts derived from Ba's own facts):
//   GET  /master-cv/derived                 → DerivedFactsViewSchema: additions not undone, the latest "Not added"
//   POST /master-cv/derived/undo            → body { version }; DerivedUndoResultSchema
//   POST /master-cv/derived/:factId/keep    → body { version }; the MasterCv (409 master_cv_changed when stale)
"use client";

import {
  API_ROUTES,
  DerivedFactsViewSchema,
  DerivedUndoResultSchema,
  FactDraftStartedSchema,
  FactDraftViewSchema,
  FactRequestsResponseSchema,
  MasterCvSchema,
  MasterCvVersionsResponseSchema,
  OkResponseSchema,
  type DerivedFactsView,
  type DerivedUndoResult,
  type FactDraftView,
  type FactRequestItem,
  type MasterCv,
} from "@bs-job-agents/shared";
import { useMemo } from "react";
import type { WebApi } from "@/lib/api/contract";
import { isApiError } from "@/lib/api/errors";
import { useApi } from "@/lib/api/react";

export type { DerivedFactsView, DerivedUndoResult, FactDraftView, FactRequestItem };

/** CV is still drafting. */
export const isDraftPending = (v: Pick<FactDraftView, "status">): boolean => v.status === "queued" || v.status === "running";

export type MasterCvRead = { state: "ok"; cv: MasterCv } | { state: "missing" } | { state: "invalid"; detail: string };

export interface MasterCvVersion {
  version: number;
  savedAt: string;
  factCount: number;
}

export interface MasterCvData {
  get(): Promise<MasterCvRead>;
  /** Saves the facts; the result carries the bumped version (UC-20). Rejects a stale version (409 master_cv_changed). */
  save(cv: MasterCv): Promise<MasterCv>;
  /** Newest first. */
  versions(): Promise<MasterCvVersion[]>;
  factRequests(): Promise<FactRequestItem[]>;
  /** Closes a fact request: "No, I don't" (CV continues without the fact, it never invents one), or answered by a saved fact. */
  dismissFactRequest(id: string): Promise<void>;
  /** Ba's own words → CV drafts the fact(s); `version` is the master version on the page (409 master_cv_changed when stale). */
  draftFacts(input: { text: string; factRequestId: string | null; version: number }): Promise<{ taskId: string }>;
  /** The draft's state now. */
  factDraft(taskId: string): Promise<FactDraftView>;
  /** Polls the draft until CV settles it (added, no_facts or failed); stops quietly when `signal` aborts. */
  awaitFactDraft(taskId: string, opts?: { signal?: AbortSignal }): Promise<FactDraftView>;
  /** Removes the facts that `version` added: restores the version before (as a new version). */
  undoFacts(version: number): Promise<MasterCv>;
  /** Re-runs CV steps (POST /steps/:id/rerun); per step, null when it started or the server's reason. */
  rerunSteps(stepIds: string[]): Promise<Record<string, string | null>>;
  /** Facts added automatically (not undone) and the latest run's rejected drafts. */
  derived(): Promise<DerivedFactsView>;
  /** Undo one automatic addition (the master version it made). */
  undoDerived(version: number): Promise<DerivedUndoResult>;
  /** Keep a flagged derived fact; `version` is the master version on the page. */
  keepDerived(factId: string, version: number): Promise<MasterCv>;
}

export interface MasterCvDataOptions {
  /** How often awaitFactDraft polls (default 1 s). */
  pollMs?: number;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });

export function createMasterCvData(api: Pick<WebApi, "request" | "rerunStep">, opts: MasterCvDataOptions = {}): MasterCvData {
  const pollMs = opts.pollMs ?? 1000;
  const factDraft = (taskId: string) => api.request("GET", API_ROUTES.masterCvFactDraft, { params: { taskId }, schema: FactDraftViewSchema });
  return {
    draftFacts(input) {
      return api.request("POST", API_ROUTES.masterCvFactDrafts, { body: input, schema: FactDraftStartedSchema });
    },
    factDraft,
    async awaitFactDraft(taskId, { signal } = {}) {
      for (;;) {
        const view = await factDraft(taskId);
        if (!isDraftPending(view) || signal?.aborted) return view;
        await sleep(pollMs, signal);
      }
    },
    undoFacts(version) {
      return api.request("POST", API_ROUTES.masterCvFactsUndo, { body: { version }, schema: MasterCvSchema });
    },
    async rerunSteps(stepIds) {
      const out: Record<string, string | null> = {};
      for (const id of stepIds) {
        try {
          await api.rerunStep(id);
          out[id] = null;
        } catch (err) {
          out[id] = err instanceof Error ? err.message : String(err);
        }
      }
      return out;
    },
    derived() {
      return api.request("GET", API_ROUTES.masterCvDerived, { schema: DerivedFactsViewSchema });
    },
    undoDerived(version) {
      return api.request("POST", API_ROUTES.masterCvDerivedUndo, { body: { version }, schema: DerivedUndoResultSchema });
    },
    keepDerived(factId, version) {
      return api.request("POST", API_ROUTES.masterCvDerivedKeep, { params: { factId }, body: { version }, schema: MasterCvSchema });
    },
    async get() {
      try {
        return { state: "ok", cv: await api.request("GET", API_ROUTES.masterCv, { schema: MasterCvSchema }) };
      } catch (err) {
        if (isApiError(err) && err.code === "not_found") return { state: "missing" };
        if (isApiError(err) && err.reason === "master_cv_invalid") return { state: "invalid", detail: err.message };
        throw err;
      }
    },
    save(cv) {
      return api.request("PUT", API_ROUTES.masterCv, { body: cv, schema: MasterCvSchema });
    },
    async versions() {
      const { versions } = await api.request("GET", API_ROUTES.masterCvVersions, { schema: MasterCvVersionsResponseSchema });
      return [...versions].sort((a, b) => b.version - a.version);
    },
    async factRequests() {
      return (await api.request("GET", API_ROUTES.masterCvFactRequests, { schema: FactRequestsResponseSchema })).requests;
    },
    async dismissFactRequest(id) {
      await api.request("POST", API_ROUTES.masterCvFactRequestDismiss, { params: { id }, body: {}, schema: OkResponseSchema });
    },
  };
}

/** The page's adapter (lib/api: the orchestrator in live mode, the mock otherwise). */
export function useMasterCvData(): MasterCvData {
  const api = useApi();
  return useMemo(() => createMasterCvData(api), [api]);
}

export interface MasterCvPageRead {
  read: MasterCvRead;
  versions: MasterCvVersion[];
  requests: FactRequestItem[];
  derived: DerivedFactsView;
}

const NO_DERIVED: DerivedFactsView = { adds: [], rejected: [] };

export async function readMasterCvPage(data: MasterCvData): Promise<MasterCvPageRead> {
  // The derived view is extra: an older orchestrator without it still shows the page.
  const [read, versions, requests, derived] = await Promise.all([data.get(), data.versions(), data.factRequests(), data.derived().catch(() => NO_DERIVED)]);
  return { read, versions, requests, derived };
}
