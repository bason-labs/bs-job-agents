import { request, type IncomingMessage } from "node:http";
import { AppEventSchema, decodeSseData, type AppEvent } from "@bs-job-agents/shared";
import { afterEach, describe, expect, it } from "vitest";
import { appendAppEvent, appendEvent, latestApprovalForApplication, listEvents } from "../../db/index.js";
import { createApiHarness, type ApiHarness, type ApiHarnessOptions } from "../testing.js";

let h: ApiHarness | null = null;
const streams: Stream[] = [];
afterEach(async () => {
  for (const s of streams.splice(0)) s.close();
  await h?.close();
  h = null;
});

const scan = { workflow: "job-scan", params: { searchProfileId: null, overrides: null } } as const;

interface Frame {
  id: string | null;
  event: string | null;
  data: string | null;
  comment: string | null;
  retry: string | null;
}

interface Stream {
  status: number;
  headers: IncomingMessage["headers"];
  frames: Frame[];
  ended: boolean;
  events(): AppEvent[];
  waitFor(pred: (s: Stream) => boolean, ms?: number): Promise<void>;
  close(): void;
}

function parseFrame(block: string): Frame {
  const f: Frame = { id: null, event: null, data: null, comment: null, retry: null };
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) f.comment = line.slice(1).trim();
    else if (line.startsWith("id: ")) f.id = line.slice(4);
    else if (line.startsWith("event: ")) f.event = line.slice(7);
    else if (line.startsWith("data: ")) f.data = line.slice(6);
    else if (line.startsWith("retry: ")) f.retry = line.slice(7);
  }
  return f;
}

/** The harness on a real port. Its inject calls must then name that port in Host (S18). */
async function listen(opts: ApiHarnessOptions = {}): Promise<{ x: ApiHarness; port: number; host: Record<string, string> }> {
  h = await createApiHarness(opts);
  await h.app.listen({ host: "127.0.0.1", port: 0 });
  const address = h.app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { x: h, port, host: { host: `127.0.0.1:${port}` } };
}

function open(port: number, path: string, headers: Record<string, string> = {}): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}`, accept: "text/event-stream", ...headers } }, (res) => {
      let buffer = "";
      const s: Stream = {
        status: res.statusCode ?? 0,
        headers: res.headers,
        frames: [],
        ended: false,
        events: () => s.frames.filter((f) => f.data !== null).map((f) => decodeSseData(f.data!)),
        waitFor: async (pred, ms = 3000) => {
          const until = Date.now() + ms;
          while (!pred(s)) {
            if (Date.now() > until) throw new Error(`timed out; frames: ${JSON.stringify(s.frames.slice(-5))}`);
            await new Promise((r) => setTimeout(r, 10));
          }
        },
        close: () => req.destroy(),
      };
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        let i: number;
        while ((i = buffer.indexOf("\n\n")) >= 0) {
          s.frames.push(parseFrame(buffer.slice(0, i)));
          buffer = buffer.slice(i + 2);
        }
      });
      res.on("end", () => (s.ended = true));
      res.on("close", () => (s.ended = true));
      streams.push(s);
      resolve(s);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("GET /events never streams an approval token (S18 backstop, Phase 3 QA)", () => {
  it("drops a frame that would carry a stored token value, replayed or live, and keeps streaming", async () => {
    const { x, port, host } = await listen();
    await x.post("/runs", scan, host);
    await x.t.idle();
    const card = (await x.get("/review", host)).json().cards[0];
    const approved = (await x.post(`/review/${card.job.id}/approve`, { cvVersionId: card.cvOptions[0].cvVersion.id, introText: null }, host)).json();
    await x.t.idle();
    const token = latestApprovalForApplication(x.t.db, Number(approved.applicationId))!.token;
    const mark = listEvents(x.t.db).at(-1)!.id;
    const leak = { type: "safety.denied", botName: "apply", taskId: null, action: "x", reason: "off_allowlist", detail: `token ${token}` } as const;
    appendAppEvent(x.t.db, leak);
    appendAppEvent(x.t.db, { ...leak, detail: "a clean one" });
    const s = await open(port, "/events", { "last-event-id": String(mark) });
    await s.waitFor((st) => st.events().some((e) => e.type === "safety.denied" && e.detail === "a clean one"));
    // Live too.
    appendAppEvent(x.t.db, leak);
    x.t.engine.bus.flush();
    await x.patch("/bots/qa", { enabled: false }, host);
    await s.waitFor((st) => st.events().some((e) => e.type === "bot.updated"));
    expect(s.frames.some((f) => (f.data ?? "").includes(token))).toBe(false);
    expect(s.events().filter((e) => e.type === "safety.denied").map((e) => (e as { detail: string }).detail)).toEqual(["a clean one"]);
  });
});

describe("GET /events (SSE, §11 live updates)", () => {
  it("streams new events as id/event/data frames; a fresh connection starts from the latest id", async () => {
    const { x, port, host } = await listen();
    await x.patch("/bots/qa", { enabled: false }, host);
    const before = listEvents(x.t.db).at(-1)!.id;
    const s = await open(port, "/events");
    expect(s.status).toBe(200);
    expect(s.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    expect(s.headers["cache-control"]).toBe("no-cache, no-transform");
    await s.waitFor((st) => st.frames.length >= 2);
    expect(s.frames[0]).toMatchObject({ retry: "3000" });
    // No replay without Last-Event-ID; the id-only frame sets where a reconnect resumes.
    expect(s.frames[1]).toMatchObject({ id: String(before), data: null });
    expect((await x.patch("/bots/research", { engine: "claude" }, host)).statusCode).toBe(200);
    await s.waitFor((st) => st.events().some((e) => e.type === "bot.updated"));
    const frames = s.frames.filter((f) => f.event === "bot.updated");
    expect(frames).toHaveLength(1);
    const event = AppEventSchema.parse(JSON.parse(frames[0]!.data!));
    expect(frames[0]!.id).toBe(event.id);
    expect(event).toMatchObject({ type: "bot.updated", botName: "research" });
    expect(Number(event.id)).toBeGreaterThan(before);
  });

  it("replays everything after Last-Event-ID in order, never audit-only rows, then continues live without duplicates", async () => {
    const { x, port, host } = await listen();
    expect((await x.post("/runs", scan, host)).statusCode).toBe(201);
    await x.t.idle();
    // An audit-only row (the real runner's spawned pid) is in the log but never streams.
    appendEvent(x.t.db, { type: "runner.spawned", payload: { pid: 4242 } });
    const all = x.t.allEvents();
    expect(all.length).toBeGreaterThan(10);
    const s = await open(port, "/events", { "last-event-id": "0" });
    await s.waitFor((st) => st.events().length >= all.length);
    const ids = s.events().map((e) => Number(e.id));
    expect(ids).toEqual(all.map((e) => Number(e.id)));
    expect(s.events().some((e) => (e.type as string) === "runner.spawned")).toBe(false);
    await x.patch("/bots/qa", { enabled: false }, host);
    await s.waitFor((st) => st.events().some((e) => e.type === "bot.updated"));
    const after = s.events().map((e) => Number(e.id));
    expect(new Set(after).size).toBe(after.length);
    expect(after).toEqual([...after].sort((a, b) => a - b));
  });

  it("replays from ?after= too, and skips a stored row that is not a valid event", async () => {
    const { x, port, host } = await listen();
    const mark = listEvents(x.t.db).at(-1)?.id ?? 0;
    appendEvent(x.t.db, { type: "review.ready", payload: { jobId: "1" } });
    expect((await x.patch("/bots/qa", { enabled: false }, host)).statusCode).toBe(200);
    const s = await open(port, `/events?after=${mark}`);
    await s.waitFor((st) => st.events().some((e) => e.type === "bot.updated"));
    expect(s.events().map((e) => e.type)).toEqual(["bot.updated"]);
  });

  it("sends heartbeats", async () => {
    const { port } = await listen({ server: { heartbeatMs: 30 } });
    const s = await open(port, "/events");
    await s.waitFor((st) => st.frames.some((f) => f.comment === "ping"));
  });

  it("has no HEAD route (it would hold a subscription open with no body)", async () => {
    h = await createApiHarness();
    expect((await h.app.inject({ method: "HEAD", url: "/events", headers: { host: "127.0.0.1:4100" } })).statusCode).toBe(404);
  });

  it("the S18 checks apply: a foreign Host or origin is refused", async () => {
    const { port } = await listen();
    expect((await open(port, "/events", { host: `evil.example:${port}` })).status).toBe(403);
    expect((await open(port, "/events", { origin: "http://evil.example" })).status).toBe(403);
  });

  it("degraded without a database: 503", async () => {
    const { port } = await listen({
      state: { state: "degraded", reason: "schema_guard", detail: "x", startedAt: "2026-10-10T08:00:00.000Z" },
      context: { db: null, engine: null, events: null },
    });
    expect((await open(port, "/events")).status).toBe(503);
  });

  it("closing the server ends open streams", async () => {
    const { x, port } = await listen();
    const s = await open(port, "/events");
    await s.waitFor((st) => st.frames.length >= 2);
    await x.app.close();
    await s.waitFor((st) => st.ended);
  });
});
