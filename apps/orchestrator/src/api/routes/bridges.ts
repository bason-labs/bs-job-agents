// GET /bridges (§11 sidebar "Chrome extension status"): asks the engine's browser probe whether each
// engine's Chrome extension answers. Cached briefly, since the sidebar polls; bridge.status events
// keep the UI live in between. Unknown (null) while the engine does not run.
import { API_ROUTES, BridgesResponseSchema, type BridgesResponse } from "@bs-job-agents/shared";
import type { FastifyInstance } from "fastify";
import type { ApiContext } from "../context.js";
import { respond } from "../http.js";

export const BRIDGES_CACHE_MS = 10_000;
const ENGINES = ["claude", "codex"] as const;

export function bridgeRoutes(app: FastifyInstance, ctx: ApiContext): void {
  let cached: { at: number; body: BridgesResponse } | null = null;

  app.get(API_ROUTES.bridges, async () => {
    const now = ctx.now();
    if (cached && now.getTime() - cached.at < BRIDGES_CACHE_MS) return respond(BridgesResponseSchema, cached.body);
    const engine = ctx.engine && ctx.state.state === "running" ? ctx.engine : null;
    const chrome = await Promise.all(
      ENGINES.map(async (name) => {
        if (!engine) return { engine: name, connected: null };
        try {
          return { engine: name, connected: await engine.deps.browser.isConnected(name) };
        } catch {
          return { engine: name, connected: false };
        }
      }),
    );
    const body: BridgesResponse = { chrome, checkedAt: now.toISOString() };
    if (engine) cached = { at: now.getTime(), body };
    return respond(BridgesResponseSchema, body);
  });
}
