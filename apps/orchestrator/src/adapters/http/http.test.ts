// AD-2 (NFR-1): one per-host gate (≥ 1500 ms between two requests to a host) and one error
// classification for every non-browser path, feeds and board APIs alike.
import { describe, expect, it } from "vitest";
import { HostGate, HttpRequestError, classifyStatus, sendRequest, type HttpFetch } from "./index.js";

function fakeClock() {
  let now = 1_000_000;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += Math.max(0, ms);
    },
  };
}

const ok = (body = "{}") => ({ ok: true, status: 200, text: async () => body });

describe("HostGate", () => {
  it("three requests to one host are at least 1500 ms apart on the fake clock; other hosts do not wait", async () => {
    const clock = fakeClock();
    const gate = new HostGate(clock);
    const at: Record<string, number[]> = {};
    const hit = (host: string) => gate.run(host, async () => void (at[host] ??= []).push(clock.now()));
    await Promise.all([hit("itviec.com"), hit("itviec.com"), hit("api.example.com"), hit("itviec.com")]);
    const it = at["itviec.com"]!;
    expect(it).toHaveLength(3);
    expect(it[1]! - it[0]!).toBeGreaterThanOrEqual(1_500);
    expect(it[2]! - it[1]!).toBeGreaterThanOrEqual(1_500);
    expect(at["api.example.com"]).toHaveLength(1);
  });

  it("a failed request still keeps the gap for the next one", async () => {
    const clock = fakeClock();
    const gate = new HostGate(clock);
    const at: number[] = [];
    await expect(gate.run("h", async () => { at.push(clock.now()); throw new Error("boom"); })).rejects.toThrow("boom");
    await gate.run("h", async () => void at.push(clock.now()));
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(1_500);
  });
});

describe("classifyStatus / sendRequest", () => {
  it("429 and 5xx are transient, 401 and 403 are AuthRejected, other errors fail", () => {
    expect([429, 500, 503, 599].map(classifyStatus)).toEqual(["transient", "transient", "transient", "transient"]);
    expect([401, 403].map(classifyStatus)).toEqual(["auth_rejected", "auth_rejected"]);
    expect([400, 404].map(classifyStatus)).toEqual(["failed", "failed"]);
    expect(classifyStatus(200)).toBeNull();
  });

  const send = (fetch: HttpFetch, timeoutMs = 1_000) => sendRequest({ fetch, gate: new HostGate(fakeClock()), url: "https://h.example/x?q=1", headers: {}, timeoutMs });

  it("answers the body on 2xx", async () => {
    await expect(send(async () => ok("hello"))).resolves.toBe("hello");
  });

  it("throws a classified HttpRequestError", async () => {
    const err503 = await send(async () => ({ ok: false, status: 503, text: async () => "" })).catch((e: unknown) => e);
    expect(err503).toBeInstanceOf(HttpRequestError);
    expect(err503).toMatchObject({ kind: "transient", status: 503 });
    await expect(send(async () => ({ ok: false, status: 401, text: async () => "" }))).rejects.toMatchObject({ kind: "auth_rejected", status: 401 });
    await expect(send(async () => { throw new Error("fetch failed"); })).rejects.toMatchObject({ kind: "transient", status: null, detail: "fetch failed" });
    const never: HttpFetch = (_u, init) => new Promise((_r, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    await expect(send(never, 20)).rejects.toMatchObject({ kind: "transient", status: null, detail: "no answer within 0 s" });
  });

  it("a cancel by the caller is not classified: it is rethrown as is", async () => {
    const cancel = new AbortController();
    let started!: () => void;
    const inFlight = new Promise<void>((r) => (started = r));
    const never: HttpFetch = (_u, init) =>
      new Promise((_r, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("cancelled by Ba")));
        started();
      });
    const pending = sendRequest({ fetch: never, gate: new HostGate(fakeClock()), url: "https://h.example/", headers: {}, timeoutMs: 60_000, signal: cancel.signal });
    await inFlight;
    cancel.abort();
    await expect(pending).rejects.toThrow("cancelled by Ba");
  });
});
