// Data access for the Applications screen and its submission record panel (UC-13, UC-13b).
//
// Screens import `applicationsData` from here and nothing else, so wiring the real API is a
// one-line change: replace the fixture implementation below with an adapter over lib/api
// (W3b's typed client). Shapes are the shared API schemas.
//   GET  /applications             → ApplicationsResponseSchema (rows, lastExportAt, dataDir)
//   GET  /applications/:id         → ApplicationDetailSchema (record panel); 404 → null here
//   POST /applications/:id/status  → body ApplicationStatusChangeRequestSchema
//                                    → ApplicationStatusChangeResponseSchema; 409 when refused
//   POST /exports                  → 201 ExportResponseSchema ({ export, downloadUrl })
//   GET  /files/:id[?download=1]   → the viewer's file (shared fileUrl)
// The API's file and download URLs are orchestrator paths: the lib/api adapter prefixes its
// same-origin proxy base (/api) in fileUrl() and in exportAll()'s downloadUrl.
// Additive API needs (handoff): ApplicationListItem.cvFile (the PDF sent, for imported rows),
// POST /applications/:id/apply-again (failed applications, one-application-per-job override).
import {
  canChangeApplicationStatus,
  fileUrl,
  type ApplicationDetail,
  type ApplicationStatusChangeRequest,
  type ApplicationStatusChangeResponseSchema,
  type ApplicationsResponseSchema,
  type ExportResponse,
  type FileRef,
} from "@bs-job-agents/shared";
import type { z } from "zod";
import { FixtureApiError } from "@/components/schedules/apiError";
import { isoDay } from "@/components/schedules/datetime";
import { APPLICATION_DETAILS, toRow } from "./fixtures";
import { sortApplications, type ApplicationRow } from "./logic";

export type ApplicationsList = Omit<z.infer<typeof ApplicationsResponseSchema>, "applications"> & { applications: ApplicationRow[] };
export type ApplicationStatusChangeResponse = z.infer<typeof ApplicationStatusChangeResponseSchema>;

export interface ApplicationsData {
  list(): Promise<ApplicationsList>;
  /** The frozen submission record; null when the application doesn't exist. */
  get(id: string): Promise<ApplicationDetail | null>;
  /** Ba's manual status change (UC-11 c, UC-13); the server checks the shared status machine. */
  changeStatus(id: string, body: ApplicationStatusChangeRequest): Promise<ApplicationStatusChangeResponse>;
  /** ⬇ Export all (ZIP): the server builds it; the screen downloads `downloadUrl`. */
  exportAll(): Promise<ExportResponse>;
  /** "Apply again" for a failed application: the job returns to the review queue. */
  applyAgain(id: string): Promise<{ jobId: string }>;
  /** Where the viewer loads a file from, or downloads it (the viewer's Download button). */
  fileUrl(fileId: string, opts?: { download?: boolean }): string;
}

/** A valid, empty ZIP: the fixture export downloads a real (if empty) archive. */
const EMPTY_ZIP = "data:application/zip;base64,UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==";

/** Sample files under public/dev, by type, so the viewer shows something in fixture mode. */
const SAMPLE_FILES: Record<string, string> = {
  "application/pdf": "/dev/sample-cv.pdf",
  "image/png": "/dev/sample-screenshot.png",
  "text/plain": "/dev/sample-jd.txt",
};

/** In-memory stand-in seeded from the fixtures (no orchestrator needed). */
export function createFixtureApplicationsData(
  opts: { seed?: ApplicationDetail[]; now?: () => Date; lastExportAt?: string | null } = {},
): ApplicationsData {
  const now = opts.now ?? (() => new Date());
  const details = new Map(structuredClone(opts.seed ?? APPLICATION_DETAILS).map((d) => [d.application.id, d]));
  const files = new Map<string, FileRef>([...details.values()].flatMap((d) => d.files.map((f) => [f.id, f] as const)));
  let lastExportAt = opts.lastExportAt ?? null;
  let exports = 0;

  const find = (id: string) => {
    const d = details.get(id);
    if (!d) throw new FixtureApiError(404, "not_found", `application ${id} not found`);
    return d;
  };

  return {
    async list() {
      return { applications: sortApplications([...details.values()].map((d) => structuredClone(toRow(d)))), lastExportAt };
    },
    async get(id) {
      const d = details.get(id);
      return d ? structuredClone(d) : null;
    },
    async changeStatus(id, body) {
      const d = find(id);
      const app = d.application;
      if (!canChangeApplicationStatus(app.status, body.status, { dryRun: app.dryRun })) {
        throw new FixtureApiError(409, "conflict", `can't change ${app.status} to ${body.status}`);
      }
      app.status = body.status;
      app.statusHistory = [...app.statusHistory, { status: body.status, at: now().toISOString(), note: body.note }];
      if (body.status === "submitted" && !app.submittedAt) app.submittedAt = now().toISOString();
      return { application: structuredClone(app) };
    },
    async exportAll() {
      const at = now();
      lastExportAt = at.toISOString();
      const count = [...details.values()].filter((d) => !d.application.dryRun).length;
      return {
        export: { id: `exp_${++exports}`, createdAt: lastExportAt, path: `data/exports/job-agents-export_${isoDay(at)}.zip`, applicationCount: count },
        downloadUrl: EMPTY_ZIP,
      };
    },
    async applyAgain(id) {
      const d = find(id);
      if (d.application.status !== "failed") throw new FixtureApiError(409, "conflict", "only a failed application can be applied to again");
      return { jobId: d.application.jobId };
    },
    fileUrl(id, opts = {}) {
      const f = files.get(id);
      return f && SAMPLE_FILES[f.mime] ? SAMPLE_FILES[f.mime]! : fileUrl(id, opts);
    },
  };
}

export const applicationsData: ApplicationsData = createFixtureApplicationsData();
