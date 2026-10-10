// Engine errors carry an API error code (shared ApiErrorCodeSchema), so W3a maps them to
// HTTP responses and MCP tool errors without guessing.
import type { z } from "zod";
import type { ApiErrorCodeSchema } from "@bs-job-agents/shared";

export type EngineErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export class EngineError extends Error {
  constructor(
    readonly code: EngineErrorCode,
    message: string,
    readonly details: unknown = null,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

export const notFound = (what: string, id: string | number): EngineError => new EngineError("not_found", `${what} ${id} not found`);

export const invalidState = (message: string, details: unknown = null): EngineError => new EngineError("conflict", message, details);

export const forbidden = (message: string, details: unknown = null): EngineError => new EngineError("forbidden", message, details);

export const invalidInput = (message: string, details: unknown = null): EngineError =>
  new EngineError("validation_failed", message, details);

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
