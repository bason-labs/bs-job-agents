import { describe, expect, it, vi } from "vitest";
import { isLocalHost, proxyToOrchestrator } from "./proxy";

const opts = (fetchImpl: typeof fetch) => ({ baseUrl: "http://127.0.0.1:4100", fetch: fetchImpl });

describe("isLocalHost (DNS rebinding guard)", () => {
  it("accepts localhost names with or without a port", () => {
    for (const h of ["localhost:3000", "127.0.0.1:3000", "localhost", "[::1]:3000", "LOCALHOST:3100"]) expect(isLocalHost(h), h).toBe(true);
  });
  it("refuses every other host", () => {
    for (const h of ["evil.com:3000", "127.0.0.1.evil.com", "localhost.evil.com:3000", "192.168.1.2:3000", "", null]) expect(isLocalHost(h), String(h)).toBe(false);
  });
});

describe("proxyToOrchestrator", () => {
  it("forwards path, query, method, body and the CSRF/Origin headers", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }));
    const req = new Request("http://localhost:3000/api/orch/review/job%201/approve?x=1", {
      method: "POST",
      headers: {
        host: "localhost:3000",
        origin: "http://localhost:3000",
        "content-type": "application/json",
        "x-requested-with": "bs-job-agents",
        "x-csrf-token": "t0k",
        cookie: "bsja_csrf=t0k",
        "x-unrelated": "dropped",
      },
      body: JSON.stringify({ cvVersionId: "2" }),
    });
    const res = await proxyToOrchestrator(req, ["review", "job 1", "approve"], opts(fetchImpl as unknown as typeof fetch));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:4100/review/job%201/approve?x=1");
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("origin")).toBe("http://localhost:3000");
    expect(headers.get("x-csrf-token")).toBe("t0k");
    expect(headers.get("x-requested-with")).toBe("bs-job-agents");
    expect(headers.get("cookie")).toBe("bsja_csrf=t0k");
    expect(headers.get("x-unrelated")).toBeNull();
    expect(headers.get("host")).toBeNull();
    expect(await new Response(init.body).text()).toBe(JSON.stringify({ cvVersionId: "2" }));
  });

  it("refuses a request addressed to a foreign host before calling the orchestrator", async () => {
    const fetchImpl = vi.fn();
    const req = new Request("http://evil.com:3000/api/orch/files/1", { headers: { host: "evil.com:3000" } });
    const res = await proxyToOrchestrator(req, ["files", "1"], opts(fetchImpl as unknown as typeof fetch));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("forbidden");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("streams SSE through (Last-Event-ID forwarded; no buffering)", async () => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("id: 1\nevent: run.updated\ndata: {}\n\n"));
        c.close();
      },
    });
    const fetchImpl = vi.fn(async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }));
    const req = new Request("http://localhost:3000/api/orch/events", { headers: { host: "localhost:3000", "last-event-id": "41" } });
    const res = await proxyToOrchestrator(req, ["events"], opts(fetchImpl as unknown as typeof fetch));
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(await res.text()).toContain("event: run.updated");
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(new Headers(init.headers).get("last-event-id")).toBe("41");
  });

  it("passes file downloads through with their filename and every Set-Cookie", async () => {
    const headers = new Headers({ "content-type": "application/pdf", "content-disposition": 'attachment; filename="cv.pdf"' });
    headers.append("set-cookie", "a=1; Path=/");
    headers.append("set-cookie", "bsja_csrf=x; Path=/");
    const fetchImpl = vi.fn(async () => new Response("%PDF", { headers }));
    const req = new Request("http://127.0.0.1:3000/api/orch/files/f1?download=1", { headers: { host: "127.0.0.1:3000" } });
    const res = await proxyToOrchestrator(req, ["files", "f1"], opts(fetchImpl as unknown as typeof fetch));
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="cv.pdf"');
    expect(res.headers.getSetCookie()).toEqual(["a=1; Path=/", "bsja_csrf=x; Path=/"]);
  });

  it("answers the shared ApiError shape when the orchestrator is down", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const req = new Request("http://localhost:3000/api/orch/review", { headers: { host: "localhost:3000" } });
    const res = await proxyToOrchestrator(req, ["review"], opts(fetchImpl as unknown as typeof fetch));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe("internal");
    expect(body.error.message).toMatch(/orchestrator/i);
  });
});
