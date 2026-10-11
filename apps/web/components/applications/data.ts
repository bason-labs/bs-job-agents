// Data access for the Applications screen and its submission record panel (UC-13, UC-13b): an
// adapter over lib/api (the orchestrator in live mode, the mock backend otherwise). Shapes are the
// shared API schemas:
//   GET  /applications                  → ApplicationsResponseSchema (rows with cvFile, lastExportAt, dataDir)
//   GET  /applications/:id              → ApplicationDetailSchema (record panel); 404 → null here
//   POST /applications/:id/status       → body ApplicationStatusChangeRequestSchema
//                                         → ApplicationStatusChangeResponseSchema; 409 when refused
//   POST /applications/:id/apply-again  → 201 ApplyAgainResponseSchema { jobId, runId }; 409 unless failed
//   POST /exports                       → 201 ExportResponseSchema ({ export, downloadUrl })
//   GET  /files/:id[?download=1]        → the viewer's file (WebApi.fileUrl)
// The API's file and download URLs are orchestrator paths; WebApi.fileUrl / apiUrl add the
// browser's same-origin /api base in live mode.
"use client";

import {
  API_ROUTES,
  ApplicationDetailSchema,
  ApplicationStatusChangeResponseSchema,
  ApplicationsResponseSchema,
  ApplyAgainResponseSchema,
  ExportResponseSchema,
  type ApplicationDetail,
  type ApplicationStatusChangeRequest,
  type ApplyAgainResponse,
  type ExportResponse,
} from "@bs-job-agents/shared";
import { useMemo } from "react";
import type { z } from "zod";
import type { WebApi } from "@/lib/api/contract";
import { isApiError } from "@/lib/api/errors";
import { useApi } from "@/lib/api/react";
import { sortApplications, type ApplicationRow } from "./logic";

export type ApplicationsList = Omit<z.infer<typeof ApplicationsResponseSchema>, "applications"> & { applications: ApplicationRow[] };
export type ApplicationStatusChangeResponse = z.infer<typeof ApplicationStatusChangeResponseSchema>;

export interface ApplicationsData {
  list(): Promise<ApplicationsList>;
  /** The frozen submission record; null when the application doesn't exist. */
  get(id: string): Promise<ApplicationDetail | null>;
  /** Ba's manual status change (UC-11 c, UC-13); the server checks the shared status machine. */
  changeStatus(id: string, body: ApplicationStatusChangeRequest): Promise<ApplicationStatusChangeResponse>;
  /** ⬇ Export all (ZIP): the server builds it; `downloadUrl` is ready for the browser. */
  exportAll(): Promise<ExportResponse>;
  /** "Apply again" for a failed application: a new apply-to-link run; its card comes back for review. */
  applyAgain(id: string): Promise<ApplyAgainResponse>;
  /** Where the viewer loads a file from, or downloads it (the viewer's Download button). */
  fileUrl(fileId: string, opts?: { download?: boolean }): string;
}

export type ApplicationsApi = Pick<WebApi, "request" | "fileUrl" | "apiUrl">;

export function createApplicationsData(api: ApplicationsApi): ApplicationsData {
  return {
    async list() {
      const res = await api.request("GET", API_ROUTES.applications, { schema: ApplicationsResponseSchema });
      return { ...res, applications: sortApplications(res.applications) };
    },
    async get(id) {
      try {
        return await api.request("GET", API_ROUTES.application, { params: { id }, schema: ApplicationDetailSchema });
      } catch (err) {
        if (isApiError(err) && err.code === "not_found") return null;
        throw err;
      }
    },
    changeStatus(id, body) {
      return api.request("POST", API_ROUTES.applicationStatus, { params: { id }, body, schema: ApplicationStatusChangeResponseSchema });
    },
    async exportAll() {
      const res = await api.request("POST", API_ROUTES.exports, { body: {}, schema: ExportResponseSchema });
      return { ...res, downloadUrl: api.apiUrl(res.downloadUrl) };
    },
    applyAgain(id) {
      return api.request("POST", API_ROUTES.applicationApplyAgain, { params: { id }, body: {}, schema: ApplyAgainResponseSchema });
    },
    fileUrl(id, opts) {
      return api.fileUrl(id, opts);
    },
  };
}

/** The screen's data source on the app's api (useApi). */
export function useApplicationsData(): ApplicationsData {
  const api = useApi();
  return useMemo(() => createApplicationsData(api), [api]);
}
