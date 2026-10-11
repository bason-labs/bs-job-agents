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
"use client";

import {
  API_ROUTES,
  FactRequestsResponseSchema,
  MasterCvSchema,
  MasterCvVersionsResponseSchema,
  OkResponseSchema,
  type FactRequestItem,
  type MasterCv,
} from "@bs-job-agents/shared";
import { useMemo } from "react";
import type { WebApi } from "@/lib/api/contract";
import { isApiError } from "@/lib/api/errors";
import { useApi } from "@/lib/api/react";

export type { FactRequestItem };

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
}

export function createMasterCvData(api: Pick<WebApi, "request">): MasterCvData {
  return {
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

export function useMasterCvData(): MasterCvData {
  const api = useApi();
  return useMemo(() => createMasterCvData(api), [api]);
}

export interface MasterCvPageRead {
  read: MasterCvRead;
  versions: MasterCvVersion[];
  requests: FactRequestItem[];
}

export async function readMasterCvPage(data: MasterCvData): Promise<MasterCvPageRead> {
  const [read, versions, requests] = await Promise.all([data.get(), data.versions(), data.factRequests()]);
  return { read, versions, requests };
}
