import { describe, expect, it } from "vitest";
import { FixtureApiError, apiErrorInfo, errorReason, errorText } from "./apiError";

describe("apiErrorInfo: reads the shared ApiError body however the client wraps it", () => {
  it("reads a plain body", () => {
    const body = { error: { code: "conflict", message: "the 6 s undo window has passed", details: { reason: "undo_window_passed" } } };
    expect(apiErrorInfo(body)).toEqual({ message: "the 6 s undo window has passed", code: "conflict", reason: "undo_window_passed", status: null });
  });

  it("reads an Error that carries the body, or its fields, and the HTTP status", () => {
    const wrapped = Object.assign(new Error("HTTP 409"), { status: 409, body: { error: { code: "conflict", message: "changed", details: { reason: "master_cv_changed" } } } });
    expect(apiErrorInfo(wrapped)).toEqual({ message: "changed", code: "conflict", reason: "master_cv_changed", status: 409 });
    const flat = Object.assign(new Error("Apply stays at L1"), { status: 403, code: "forbidden", details: null });
    expect(apiErrorInfo(flat)).toEqual({ message: "Apply stays at L1", code: "forbidden", reason: null, status: 403 });
  });

  it("falls back to the error's text", () => {
    expect(errorText(new Error("network down"))).toBe("network down");
    expect(errorText("boom")).toBe("boom");
    expect(errorReason(new Error("x"))).toBeNull();
  });

  it("FixtureApiError looks like the API's error to the screens", () => {
    const e = new FixtureApiError(409, "conflict", "the master CV changed", { reason: "master_cv_changed", currentVersion: 9 });
    expect(apiErrorInfo(e)).toEqual({ message: "the master CV changed", code: "conflict", reason: "master_cv_changed", status: 409 });
    expect(e).toBeInstanceOf(Error);
  });
});
