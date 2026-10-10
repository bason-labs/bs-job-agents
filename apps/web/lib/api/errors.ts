// Errors from the orchestrator API (shared ApiError body, §4.2) plus the two cases the browser
// adds: the orchestrator is not reachable, or it answered with a body the contract rejects.
import { ApiErrorSchema, type ApiError } from "@bs-job-agents/shared";

export type ApiErrorCode = ApiError["error"]["code"];
export type ClientErrorCode = ApiErrorCode | "unreachable" | "bad_response";

const CODE_BY_STATUS: Record<number, ApiErrorCode> = {
  400: "validation_failed",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
};

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: ClientErrorCode;
  readonly details: unknown;

  constructor(init: { status: number; code: ClientErrorCode; message: string; details?: unknown }) {
    super(init.message);
    this.name = "ApiRequestError";
    this.status = init.status;
    this.code = init.code;
    this.details = init.details ?? null;
  }

  /** `details.reason` when the server gave one (e.g. `token_expired`, `master_cv_missing`). */
  get reason(): string | null {
    const d = this.details;
    return d && typeof d === "object" && "reason" in d && typeof d.reason === "string" ? d.reason : null;
  }

  static unreachable(cause?: unknown): ApiRequestError {
    const err = new ApiRequestError({
      status: 0,
      code: "unreachable",
      message: "Can't reach the orchestrator. Is it running? Start it with `pnpm dev:orchestrator`.",
    });
    if (cause !== undefined) (err as { cause?: unknown }).cause = cause;
    return err;
  }
}

export function isApiError(err: unknown): err is ApiRequestError {
  return err instanceof ApiRequestError;
}

/** Builds the error for a non-2xx response, from its ApiError body when it has one. */
export async function apiErrorFromResponse(res: Response): Promise<ApiRequestError> {
  let body: unknown = null;
  try {
    const text = await res.text();
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  const parsed = ApiErrorSchema.safeParse(body);
  if (parsed.success) {
    const { code, message, details } = parsed.data.error;
    return new ApiRequestError({ status: res.status, code, message, details });
  }
  return new ApiRequestError({
    status: res.status,
    code: CODE_BY_STATUS[res.status] ?? "internal",
    message: `The orchestrator answered ${res.status}${res.statusText ? ` ${res.statusText}` : ""}.`,
  });
}

/** Text for a toast or an inline error. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return "Something went wrong.";
}
