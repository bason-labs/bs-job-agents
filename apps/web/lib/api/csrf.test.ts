import { describe, expect, it } from "vitest";
import { CSRF_COOKIE, CSRF_HEADER, csrfHeaders, readCookie } from "./csrf";

describe("csrfHeaders (S18; W3a defines the scheme, this is the one place to adjust)", () => {
  it("adds nothing to safe methods", () => {
    expect(csrfHeaders("GET", () => `${CSRF_COOKIE}=abc`)).toEqual({});
    expect(csrfHeaders("head", () => "")).toEqual({});
  });

  it("marks every state-changing request and echoes the CSRF cookie when there is one", () => {
    expect(csrfHeaders("POST", () => `theme=dark; ${CSRF_COOKIE}=tok%20en; other=1`)).toEqual({
      "x-requested-with": "bs-job-agents",
      [CSRF_HEADER]: "tok en",
    });
    expect(csrfHeaders("DELETE", () => "theme=dark")).toEqual({ "x-requested-with": "bs-job-agents" });
  });

  it("works without a document (server-side calls)", () => {
    expect(csrfHeaders("PATCH")).toEqual({ "x-requested-with": "bs-job-agents" });
  });

  it("reads one cookie by name", () => {
    expect(readCookie("a=1; b=two", "b")).toBe("two");
    expect(readCookie("a=1", "b")).toBeNull();
    expect(readCookie("", "b")).toBeNull();
  });
});
