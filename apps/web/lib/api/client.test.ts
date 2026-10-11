import { API_ROUTES, ApplicationsResponseSchema, CSRF_HEADER } from "@bs-job-agents/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserClient } from "./client";

afterEach(() => vi.unstubAllGlobals());

describe("browserClient (for W3c's data modules)", () => {
  it("calls any API_ROUTES entry through /api with the shared schema and the CSRF header on mutations", async () => {
    const calls: [string, RequestInit][] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return new Response(JSON.stringify(url.endsWith("/applications") ? { applications: [], lastExportAt: null } : { ok: true }), {
        headers: { "content-type": "application/json" },
      });
    });
    const http = browserClient();
    await expect(http.request("GET", API_ROUTES.applications, { schema: ApplicationsResponseSchema })).resolves.toEqual({ applications: [], lastExportAt: null });
    await http.request("POST", API_ROUTES.applicationStatus, { params: { id: "7" }, body: { status: "offer", note: null } });
    expect(calls.map(([u, i]) => [u, i.method])).toEqual([
      ["/api/applications", "GET"],
      ["/api/applications/7/status", "POST"],
    ]);
    expect(new Headers(calls[1]![1].headers).get(CSRF_HEADER)).toBe("1");
  });
});
