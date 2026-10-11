// The same-origin /api proxy to the orchestrator (PM S18) is decided per request, so `next start`
// follows ORCH_URL / ORCH_PORT at run time (W4b open issue 2: a next.config rewrite froze the
// orchestrator's address into the build).
import { NextRequest } from "next/server";
import { getRewrittenUrl, isRewrite, unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import nextConfig from "../next.config";
import { config, proxy } from "../proxy";

const req = (url: string, host: string, method = "GET") => new NextRequest(url, { method, headers: { host } });

afterEach(() => vi.unstubAllEnvs());

describe("proxy: /api/* → the orchestrator, decided at request time", () => {
  it("runs only for /api paths", () => {
    expect(unstable_doesMiddlewareMatch({ config, url: "/api/review" })).toBe(true);
    expect(unstable_doesMiddlewareMatch({ config, url: "/api/files/12" })).toBe(true);
    expect(unstable_doesMiddlewareMatch({ config, url: "/chat" })).toBe(false);
    expect(unstable_doesMiddlewareMatch({ config, url: "/review" })).toBe(false);
  });

  it("forwards to 127.0.0.1:4100 by default, keeping the path and query", () => {
    vi.stubEnv("ORCH_URL", "");
    vi.stubEnv("ORCH_PORT", "");
    const res = proxy(req("http://localhost:3000/api/applications?status=submitted&q=a%20b", "localhost:3000"));
    expect(isRewrite(res)).toBe(true);
    expect(getRewrittenUrl(res)).toBe("http://127.0.0.1:4100/applications?status=submitted&q=a%20b");
  });

  it("reads ORCH_PORT and ORCH_URL on every request, not at build time", () => {
    vi.stubEnv("ORCH_URL", "");
    vi.stubEnv("ORCH_PORT", "4177");
    expect(getRewrittenUrl(proxy(req("http://localhost:3000/api/events", "localhost:3000")))).toBe("http://127.0.0.1:4177/events");
    vi.stubEnv("ORCH_URL", "http://127.0.0.1:4555/");
    expect(getRewrittenUrl(proxy(req("http://127.0.0.1:3000/api/review/7/approve", "127.0.0.1:3000", "POST")))).toBe(
      "http://127.0.0.1:4555/review/7/approve",
    );
  });

  it("keeps a malformed escape as sent, so the orchestrator answers it (404), not the proxy", () => {
    vi.stubEnv("ORCH_URL", "");
    vi.stubEnv("ORCH_PORT", "");
    expect(getRewrittenUrl(proxy(req("http://localhost:3000/api/mcp/%E0%A4%A", "localhost:3000")))).toBe("http://127.0.0.1:4100/mcp/%E0%A4%A");
  });

  it("serves only requests addressed to this Mac (DNS rebinding): any other Host gets a 404 and is never forwarded", () => {
    for (const host of ["evil.com", "localhost.evil.com", "127.0.0.1.evil.com:3000", "192.168.1.5:3000", ""]) {
      const res = proxy(req("http://localhost:3000/api/review", host));
      expect(isRewrite(res), host).toBe(false);
      expect(res.status, host).toBe(404);
    }
  });

  it("next.config no longer freezes a rewrite into the build", async () => {
    const rewrites = await nextConfig.rewrites?.();
    expect(rewrites ?? []).toEqual([]);
  });
});
