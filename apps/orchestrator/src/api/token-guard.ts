// PM S18: an approval token is Ba's one-time permission for one submit; its value must never reach
// the UI (or anything that reads the API). The routes already leave tokens out (the record panel
// shows the approval's time, CV version and sites only); this onSend check is the backstop: a JSON
// response that contains any stored token value is replaced by a 500 and logged.
import type { FastifyInstance } from "fastify";
import { schema } from "../db/index.js";
import type { ApiContext } from "./context.js";
import { apiErrorBody } from "./errors.js";

/** Every stored approval token value (16+ characters), for the response and SSE backstops. */
export function storedTokens(ctx: ApiContext): string[] {
  if (!ctx.db) return [];
  return ctx.db
    .select({ token: schema.approvals.token })
    .from(schema.approvals)
    .all()
    .map((r) => r.token)
    .filter((t) => t.length >= 16);
}

export function registerTokenGuard(app: FastifyInstance, ctx: ApiContext): void {
  app.addHook("onSend", async (req, reply, payload) => {
    if (typeof payload !== "string") return payload;
    const type = String(reply.getHeader("content-type") ?? "");
    if (!type.startsWith("application/json")) return payload;
    const leaked = storedTokens(ctx).some((token) => payload.includes(token));
    if (!leaked) return payload;
    req.log.error({ url: req.url }, "refused to send a response that contains an approval token");
    ctx.log.error(`refused to send ${req.method} ${req.url}: the response contained an approval token`);
    void reply.code(500);
    return JSON.stringify(apiErrorBody("internal", "the response was withheld: it contained an approval token"));
  });
}
