// Reading the orchestrator's errors in the W3c screens. The API answers with the shared ApiError
// body ({ error: { code, message, details } }; validation_failed 400, not_found 404, conflict /
// already_applied 409, forbidden 403, 503 when degraded). lib/api's client may throw that body,
// or an Error carrying it or its fields, so this reads all of those shapes.
import type { ApiError } from "@bs-job-agents/shared";

export interface ApiErrorInfo {
  message: string;
  /** Shared ApiErrorCode, when the error came from the API. */
  code: string | null;
  /** `details.reason`, e.g. undo_window_passed, master_cv_changed, master_cv_invalid. */
  reason: string | null;
  status: number | null;
}

type Loose = {
  message?: unknown;
  code?: unknown;
  status?: unknown;
  details?: unknown;
  error?: { code?: unknown; message?: unknown; details?: unknown };
  body?: { error?: { code?: unknown; message?: unknown; details?: unknown } };
};

const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
const reasonOf = (details: unknown) => (details && typeof details === "object" ? str((details as { reason?: unknown }).reason) : null);

export function apiErrorInfo(e: unknown): ApiErrorInfo {
  if (!e || typeof e !== "object") return { message: String(e), code: null, reason: null, status: null };
  const x = e as Loose;
  const body = x.error ?? x.body?.error;
  const status = typeof x.status === "number" ? x.status : null;
  if (body) return { message: str(body.message) ?? str(x.message) ?? "Something went wrong", code: str(body.code), reason: reasonOf(body.details), status };
  return { message: str(x.message) ?? String(e), code: str(x.code), reason: reasonOf(x.details), status };
}

export const errorText = (e: unknown): string => apiErrorInfo(e).message;
export const errorReason = (e: unknown): string | null => apiErrorInfo(e).reason;

/** The error body's `details` object (e.g. { reason, currentVersion }), if any. */
export function errorDetails(e: unknown): Record<string, unknown> | null {
  if (!e || typeof e !== "object") return null;
  const x = e as Loose;
  const details = x.error?.details ?? x.body?.error?.details ?? x.details;
  return details && typeof details === "object" ? (details as Record<string, unknown>) : null;
}

/** What the fixture data sources throw, shaped like the API's error (status + ApiError body). */
export class FixtureApiError extends Error {
  readonly body: ApiError;
  constructor(
    readonly status: number,
    code: ApiError["error"]["code"],
    message: string,
    details: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = "FixtureApiError";
    this.body = { error: { code, message, details } };
  }
}
