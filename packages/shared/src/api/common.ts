// Shared API shapes and routes (§4.2 REST + SSE, §11 file viewer rule).
import { z } from "zod";

export const ApiErrorCodeSchema = z.enum([
  "validation_failed",
  "not_found",
  "conflict",
  "forbidden",
  "already_applied",
  "engine_paused",
  "internal",
]);

export const ApiErrorSchema = z.object({
  error: z.object({
    code: ApiErrorCodeSchema,
    message: z.string(),
    details: z.unknown().nullable(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const OkResponseSchema = z.object({ ok: z.literal(true) });

/** Orchestrator REST routes (127.0.0.1:4318 by default, `ORCH_PORT`; the spec diagram says 4100). `:id` segments are path params. */
export const API_ROUTES = {
  health: "/health",
  events: "/events",
  files: "/files/:id",
  chatSend: "/chat/messages",
  rooms: "/rooms",
  roomMessages: "/rooms/:id/messages",
  answerQuestion: "/questions/:taskId/answer",
  runs: "/runs",
  run: "/runs/:id",
  runControl: "/runs/:id/control",
  stepRerun: "/steps/:id/rerun",
  taskResume: "/tasks/:id/resume",
  reviewQueue: "/review",
  reviewApprove: "/review/:jobId/approve",
  reviewRequestChanges: "/review/:jobId/request-changes",
  reviewSkip: "/review/:jobId/skip",
  reviewConfirmInjection: "/review/:jobId/confirm-injection",
  criteria: "/criteria",
  criteriaVersions: "/criteria/versions",
  schedules: "/schedules",
  schedule: "/schedules/:id",
  scheduleRestore: "/schedules/:id/restore",
  scheduleRunNow: "/schedules/:id/run",
  applications: "/applications",
  application: "/applications/:id",
  applicationStatus: "/applications/:id/status",
  exports: "/exports",
  uploads: "/uploads",
  bots: "/bots",
  bot: "/bots/:name",
  engines: "/engines",
  masterCv: "/master-cv",
  savedAnswers: "/saved-answers",
} as const;

/** File served for the in-app viewer; Download inside the viewer adds `?download=1`. */
export function fileUrl(id: string, opts: { download?: boolean } = {}): string {
  return `/files/${encodeURIComponent(id)}${opts.download ? "?download=1" : ""}`;
}

/** A file the viewer can open (CV PDF, screenshot, JD snapshot, export). */
export const FileKindSchema = z.enum(["cv_pdf", "screenshot", "jd_snapshot", "jd_screenshot", "upload", "export"]);
export const FileRefSchema = z.object({
  id: z.string().min(1),
  kind: FileKindSchema,
  filename: z.string().min(1),
  mime: z.string().min(1),
});
export type FileRef = z.infer<typeof FileRefSchema>;
