import { ApiErrorSchema } from "@bs-job-agents/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ApprovalRefusedError,
  ImmutableRecordError,
  InvalidTransitionError,
  NotFoundError,
  SubmissionRefusedError,
  TrustLevelRefusedError,
} from "../db/index.js";
import { EngineError } from "../engine/index.js";
import { ApiHttpError, STATUS_BY_CODE, toApiError } from "./errors.js";

function mapped(err: unknown) {
  const r = toApiError(err);
  expect(ApiErrorSchema.safeParse(r.body).success).toBe(true);
  return { status: r.status, ...r.body.error };
}

describe("toApiError", () => {
  it("maps every EngineError code to its HTTP status (W2a brief)", () => {
    expect(STATUS_BY_CODE).toEqual({
      validation_failed: 400,
      not_found: 404,
      conflict: 409,
      forbidden: 403,
      already_applied: 409,
      engine_paused: 409,
      internal: 500,
    });
    expect(mapped(new EngineError("conflict", "the master CV is missing", { reason: "master_cv_missing" }))).toEqual({
      status: 409,
      code: "conflict",
      message: "the master CV is missing",
      details: { reason: "master_cv_missing" },
    });
    expect(mapped(new EngineError("already_applied", "job 1 already has application 2"))).toMatchObject({ status: 409, code: "already_applied" });
    expect(mapped(new EngineError("forbidden", "Apply is disabled"))).toMatchObject({ status: 403, code: "forbidden" });
    expect(mapped(new EngineError("not_found", "run 9 not found"))).toMatchObject({ status: 404, code: "not_found" });
    expect(mapped(new EngineError("validation_failed", "bad input"))).toMatchObject({ status: 400, code: "validation_failed" });
  });

  it("maps the data layer's errors", () => {
    expect(mapped(new NotFoundError("schedule", 3))).toMatchObject({ status: 404, code: "not_found", message: "schedule 3 not found" });
    expect(mapped(new InvalidTransitionError("application", "submitted", "approved"))).toMatchObject({ status: 409, code: "conflict" });
    expect(mapped(new TrustLevelRefusedError("apply", 2, 1))).toMatchObject({ status: 403, code: "forbidden" });
    expect(mapped(new ApprovalRefusedError("token_live", "still valid"))).toMatchObject({ status: 409, code: "conflict", details: { reason: "token_live" } });
    expect(mapped(new ImmutableRecordError("submissions are immutable"))).toMatchObject({ status: 409, code: "conflict" });
    expect(mapped(new SubmissionRefusedError("sha_mismatch", 4, "x"))).toMatchObject({ status: 409, code: "conflict", details: { reason: "sha_mismatch" } });
  });

  it("maps a Zod error to validation_failed with the issues", () => {
    const parsed = z.object({ name: z.string().min(1, "name is required") }).safeParse({ name: "" });
    const r = mapped(parsed.error);
    expect(r).toMatchObject({ status: 400, code: "validation_failed", message: "name: name is required" });
    expect(Array.isArray(r.details)).toBe(true);
  });

  it("maps a SQLite constraint to a conflict", () => {
    const err = Object.assign(new Error("UNIQUE constraint failed: rooms.name"), { name: "SqliteError", code: "SQLITE_CONSTRAINT_UNIQUE" });
    expect(mapped(err)).toMatchObject({ status: 409, code: "conflict" });
  });

  it("keeps Fastify's 4xx statuses (unsupported media type, body too large, bad JSON)", () => {
    expect(mapped(Object.assign(new Error("Unsupported Media Type: text/plain"), { statusCode: 415, code: "FST_ERR_CTP_INVALID_MEDIA_TYPE" }))).toMatchObject({
      status: 415,
      code: "validation_failed",
    });
    expect(mapped(Object.assign(new Error("Request body is too large"), { statusCode: 413, code: "FST_ERR_CTP_BODY_TOO_LARGE" }))).toMatchObject({ status: 413 });
    expect(mapped(Object.assign(new SyntaxError("Unexpected token"), { statusCode: 400 }))).toMatchObject({ status: 400, code: "validation_failed" });
  });

  it("passes an ApiHttpError through", () => {
    expect(mapped(new ApiHttpError(503, "internal", "degraded", { reason: "degraded" }))).toEqual({
      status: 503,
      code: "internal",
      message: "degraded",
      details: { reason: "degraded" },
    });
  });

  it("hides the message of an unexpected error", () => {
    const r = mapped(new Error("SELECT secret FROM somewhere"));
    expect(r).toMatchObject({ status: 500, code: "internal" });
    expect(r.message).not.toContain("secret");
  });
});
