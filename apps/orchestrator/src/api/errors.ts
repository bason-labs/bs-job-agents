// Errors → the shared ApiError body (§4.2) with an HTTP status. EngineError already carries the
// shared ApiErrorCode (W2a), the data layer's errors map by class, and an unexpected error never
// shows its message (it may name SQL or a path).
import type { ApiError, ApiErrorCodeSchema } from "@bs-job-agents/shared";
import { ZodError, type z } from "zod";
import {
  ApprovalRefusedError,
  ImmutableRecordError,
  InvalidTransitionError,
  NotFoundError,
  SubmissionRefusedError,
  TrustLevelRefusedError,
} from "../db/index.js";
import { EngineError } from "../engine/index.js";

export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

/** An error a route throws on purpose: status, shared code, message for Ba, optional details. */
export class ApiHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details: unknown = null,
  ) {
    super(message);
    this.name = "ApiHttpError";
  }
}

/** The W2a brief's table: EngineError.code → HTTP status. */
export const STATUS_BY_CODE: Readonly<Record<ApiErrorCode, number>> = {
  validation_failed: 400,
  not_found: 404,
  conflict: 409,
  forbidden: 403,
  already_applied: 409,
  engine_paused: 409,
  internal: 500,
};

export function apiErrorBody(code: ApiErrorCode, message: string, details: unknown = null): ApiError {
  return { error: { code, message, details: details ?? null } };
}

export const notFound = (message: string): ApiHttpError => new ApiHttpError(404, "not_found", message);
export const badRequest = (message: string, details: unknown = null): ApiHttpError => new ApiHttpError(400, "validation_failed", message, details);
export const conflict = (message: string, details: unknown = null): ApiHttpError => new ApiHttpError(409, "conflict", message, details);
export const forbidden = (message: string, details: unknown = null): ApiHttpError => new ApiHttpError(403, "forbidden", message, details);

/** "path: message; path: message" for Ba, the issues for the UI's field errors. */
export function zodMessage(err: ZodError): string {
  return err.issues.map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ");
}

interface WithStatus {
  statusCode?: unknown;
  code?: unknown;
  message?: unknown;
}

export function toApiError(err: unknown): { status: number; body: ApiError } {
  const out = (status: number, code: ApiErrorCode, message: string, details: unknown = null) => ({ status, body: apiErrorBody(code, message, details) });
  if (err instanceof ApiHttpError) return out(err.status, err.code, err.message, err.details);
  if (err instanceof EngineError) return out(STATUS_BY_CODE[err.code], err.code, err.message, err.details);
  if (err instanceof ZodError) return out(400, "validation_failed", zodMessage(err), err.issues);
  if (err instanceof NotFoundError) return out(404, "not_found", err.message);
  if (err instanceof InvalidTransitionError) return out(409, "conflict", err.message, { from: err.from, to: err.to });
  if (err instanceof TrustLevelRefusedError) return out(403, "forbidden", err.message);
  if (err instanceof ApprovalRefusedError) return out(409, "conflict", err.message, { reason: err.reason });
  if (err instanceof SubmissionRefusedError) return out(409, "conflict", err.message, { reason: err.reason });
  if (err instanceof ImmutableRecordError) return out(409, "conflict", err.message);
  const e = (err ?? {}) as WithStatus;
  if (typeof e.code === "string" && e.code.startsWith("SQLITE_CONSTRAINT")) {
    return out(409, "conflict", "this conflicts with data that already exists", { reason: e.code.toLowerCase() });
  }
  // Fastify's own errors (body parsing, media type, size) carry a 4xx status and a safe message.
  if (typeof e.statusCode === "number" && e.statusCode >= 400 && e.statusCode < 500) {
    const message = typeof e.message === "string" && e.message !== "" ? e.message : "bad request";
    return out(e.statusCode, e.statusCode === 404 ? "not_found" : "validation_failed", message);
  }
  return out(500, "internal", "something went wrong in the orchestrator; see its log");
}
