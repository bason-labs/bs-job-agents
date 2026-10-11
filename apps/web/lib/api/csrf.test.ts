import { CSRF_HEADER, CSRF_HEADER_VALUE } from "@bs-job-agents/shared";
import { describe, expect, it } from "vitest";
import { csrfHeaders } from "./csrf";

describe("csrfHeaders (PM S18; the shared CSRF_HEADER the orchestrator checks)", () => {
  it("adds nothing to safe methods", () => {
    expect(csrfHeaders("GET")).toEqual({});
    expect(csrfHeaders("head")).toEqual({});
  });

  it("marks every state-changing request with x-bsja-csrf: 1", () => {
    for (const method of ["POST", "put", "PATCH", "DELETE"]) {
      expect(csrfHeaders(method)).toEqual({ [CSRF_HEADER]: CSRF_HEADER_VALUE });
    }
    expect(CSRF_HEADER).toBe("x-bsja-csrf");
    expect(CSRF_HEADER_VALUE).toBe("1");
  });
});
