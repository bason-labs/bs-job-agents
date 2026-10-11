import { describe, expect, it, vi } from "vitest";
import { BROWSER_API_BASE, apiModeSetting, mockSpeed, orchestratorRewrites, orchestratorUrl, probeOrchestrator, resolveApiMode } from "./config";

describe("orchestratorUrl (server side)", () => {
  it("defaults to the spec's 127.0.0.1:4100", () => {
    expect(orchestratorUrl({})).toBe("http://127.0.0.1:4100");
  });
  it("follows ORCH_PORT, and ORCH_URL wins", () => {
    expect(orchestratorUrl({ ORCH_PORT: "5000" })).toBe("http://127.0.0.1:5000");
    expect(orchestratorUrl({ ORCH_PORT: "5000", ORCH_URL: "http://localhost:4200/" })).toBe("http://localhost:4200");
  });
  it("ignores a broken ORCH_PORT", () => {
    expect(orchestratorUrl({ ORCH_PORT: "abc" })).toBe("http://127.0.0.1:4100");
  });
  it("browser calls go to /api on the web app's origin, rewritten to the orchestrator", () => {
    expect(BROWSER_API_BASE).toBe("/api");
    expect(orchestratorRewrites({ ORCH_PORT: "4200" })).toEqual([
      { source: "/api/:path*", destination: "http://127.0.0.1:4200/:path*", has: [{ type: "host", value: "(?:localhost|127\\.0\\.0\\.1)" }] },
    ]);
  });

  it("the rewrite only serves requests addressed to this Mac (DNS rebinding)", () => {
    // Next matches `has: host` as ^value$ against the Host header's name (no port).
    const host = new RegExp(`^${orchestratorRewrites({})[0]!.has[0]!.value}$`);
    expect(["localhost", "127.0.0.1"].every((h) => host.test(h))).toBe(true);
    expect(["evil.com", "localhost.evil.com", "127.0.0.1.evil.com", "192.168.1.5"].some((h) => host.test(h))).toBe(false);
  });
});

describe("API mode", () => {
  it("reads BSJA_API_MODE (live | mock | auto, default auto)", () => {
    expect(apiModeSetting({})).toBe("auto");
    expect(apiModeSetting({ BSJA_API_MODE: "mock" })).toBe("mock");
    expect(apiModeSetting({ BSJA_API_MODE: "LIVE" })).toBe("live");
    expect(apiModeSetting({ BSJA_API_MODE: "nonsense" })).toBe("auto");
  });

  it("auto: production is always live (never sample data)", async () => {
    const probe = vi.fn(async () => false);
    expect(await resolveApiMode({ NODE_ENV: "production" }, probe)).toBe("live");
    expect(probe).not.toHaveBeenCalled();
  });

  it("auto in development: live when the orchestrator answers, mock otherwise", async () => {
    expect(await resolveApiMode({ NODE_ENV: "development" }, async () => true)).toBe("live");
    expect(await resolveApiMode({ NODE_ENV: "development" }, async () => false)).toBe("mock");
  });

  it("an explicit mode wins over the probe", async () => {
    expect(await resolveApiMode({ NODE_ENV: "development", BSJA_API_MODE: "live" }, async () => false)).toBe("live");
    expect(await resolveApiMode({ NODE_ENV: "production", BSJA_API_MODE: "mock" }, async () => true)).toBe("mock");
  });

  it("the mock's speed comes from BSJA_MOCK_SPEED (default 1)", () => {
    expect(mockSpeed({})).toBe(1);
    expect(mockSpeed({ BSJA_MOCK_SPEED: "4" })).toBe(4);
    expect(mockSpeed({ BSJA_MOCK_SPEED: "-1" })).toBe(1);
  });
});

describe("probeOrchestrator", () => {
  it("any HTTP answer counts as running (a degraded /health is still the orchestrator)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: false }), { status: 503 })) as unknown as typeof fetch;
    expect(await probeOrchestrator("http://127.0.0.1:4100", fetchImpl)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:4100/health", expect.objectContaining({ cache: "no-store" }));
  });
  it("a refused connection is not running", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    expect(await probeOrchestrator("http://127.0.0.1:4100", fetchImpl)).toBe(false);
  });
});
