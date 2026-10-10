// GET /events: the SSE stream of committed shared AppEvents (§4.2, §11 live updates).
// - Every frame's `id:` is the events-table row id. A reconnect sends Last-Event-ID (or ?after=)
//   and gets every shared event after it, in order, then the live stream; audit-only rows never
//   stream. Replay and live delivery never overlap (an event is sent only if its id is newer).
// - A first connection (no Last-Event-ID) gets no history: the UI loads state over REST, and an
//   id-only frame sets where a reconnect resumes (it sets EventSource.lastEventId and dispatches
//   nothing).
// - Every event is checked with AppEventSchema before it is written; a heartbeat comment keeps
//   proxies from timing out; Cache-Control no-transform keeps a proxy from compressing the stream.
import { API_ROUTES, AppEventSchema, encodeSseEvent, type AppEvent } from "@bs-job-agents/shared";
import type { FastifyInstance } from "fastify";
import type { ApiContext } from "../context.js";
import { ApiHttpError } from "../errors.js";

export const DEFAULT_HEARTBEAT_MS = 15_000;
export const SSE_RETRY_MS = 3000;

function lastEventIdOf(header: string | string[] | undefined, query: string | undefined): number | null {
  const raw = (Array.isArray(header) ? header[0] : header) ?? query;
  if (raw === undefined) return null;
  const v = raw.trim();
  return /^\d{1,15}$/.test(v) ? Number(v) : null;
}

export function eventRoutes(app: FastifyInstance, ctx: ApiContext, opts: { heartbeatMs?: number } = {}): void {
  const open = new Set<() => void>();
  app.addHook("preClose", async () => {
    for (const end of [...open]) end();
  });

  app.get<{ Querystring: { after?: string } }>(API_ROUTES.events, { exposeHeadRoute: false }, (req, reply) => {
    const hub = ctx.events;
    if (!hub) {
      throw new ApiHttpError(503, "internal", `the orchestrator runs in degraded mode: ${ctx.state.state === "degraded" ? ctx.state.detail : "no event log"}`, {
        reason: "degraded",
        cause: ctx.state.state === "degraded" ? ctx.state.reason : null,
      });
    }
    const resumeFrom = lastEventIdOf(req.headers["last-event-id"], req.query.after);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
    });
    res.write(`retry: ${SSE_RETRY_MS}\n\n`);

    let lastSent = resumeFrom ?? hub.lastId();
    const send = (event: AppEvent) => {
      const id = Number(event.id);
      if (!Number.isFinite(id) || id <= lastSent || res.writableEnded) return;
      const parsed = AppEventSchema.safeParse(event);
      if (!parsed.success) {
        ctx.log.warn(`SSE: event ${event.id} (${event.type}) does not validate; not sent`);
        return;
      }
      lastSent = id;
      res.write(encodeSseEvent(parsed.data));
    };
    if (resumeFrom === null) res.write(`id: ${lastSent}\n\n`);
    else for (const event of hub.replay(resumeFrom)) send(event);
    // Replay and subscribe run in one tick, so nothing committed in between is missed; the id
    // check drops what the replay already sent when the bus delivers it.
    const unsubscribe = hub.subscribe(send);
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(": ping\n\n");
    }, opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
    heartbeat.unref();
    const end = () => {
      clearInterval(heartbeat);
      unsubscribe();
      open.delete(end);
      if (!res.writableEnded) res.end();
    };
    open.add(end);
    req.raw.on("close", end);
  });
}
