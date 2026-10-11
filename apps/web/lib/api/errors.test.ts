import { describe, expect, it } from "vitest";
import { ApiRequestError, apiErrorFromResponse, errorMessage, isApiError } from "./errors";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("apiErrorFromResponse", () => {
  it("reads the shared ApiError body (code, message, details)", async () => {
    const err = await apiErrorFromResponse(
      json(409, { error: { code: "conflict", message: "Approve again after the token expired", details: { reason: "token_expired" } } }),
    );
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err.status).toBe(409);
    expect(err.code).toBe("conflict");
    expect(err.message).toBe("Approve again after the token expired");
    expect(err.details).toEqual({ reason: "token_expired" });
    expect(err.reason).toBe("token_expired");
  });

  it("falls back to the HTTP status when the body is not an ApiError", async () => {
    const err = await apiErrorFromResponse(new Response("<html>Bad gateway</html>", { status: 502 }));
    expect(err.code).toBe("internal");
    expect(err.status).toBe(502);
    expect(err.message).toMatch(/502/);
    const notFound = await apiErrorFromResponse(new Response("", { status: 404 }));
    expect(notFound.code).toBe("not_found");
    const forbidden = await apiErrorFromResponse(new Response("nope", { status: 403 }));
    expect(forbidden.code).toBe("forbidden");
  });
});

describe("error helpers", () => {
  it("names an unreachable orchestrator in plain words", () => {
    const err = ApiRequestError.unreachable(new TypeError("fetch failed"));
    expect(err.code).toBe("unreachable");
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/orchestrator/i);
  });

  it("errorMessage turns anything into text for a toast", () => {
    expect(errorMessage(new ApiRequestError({ status: 400, code: "validation_failed", message: "type an answer" }))).toBe("type an answer");
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("odd")).toBe("Something went wrong.");
    expect(isApiError(new Error("x"))).toBe(false);
    expect(isApiError(ApiRequestError.unreachable())).toBe(true);
  });
});
