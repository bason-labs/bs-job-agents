// REST + SSE API (spec §4.2, §7, §8, §11; PM S18, S19, S21, S23). Owned by W3a.
// Every route of the shared API_ROUTES that does not need F2's conversation seam; chat, consult,
// room messages and the Lead MCP server come in W3a part 2.
import type { FastifyInstance } from "fastify";
import type { ApiContext } from "./context.js";
import { fileRoutes } from "./routes/files.js";
import { healthRoutes } from "./routes/health.js";
import { reviewRoutes } from "./routes/review.js";
import { runRoutes } from "./routes/runs.js";

export interface RouteOptions {
  /** SSE heartbeat interval in ms (default 15 s). */
  heartbeatMs?: number;
}

export function registerRoutes(app: FastifyInstance, ctx: ApiContext, _opts: RouteOptions = {}): void {
  healthRoutes(app, ctx);
  fileRoutes(app, ctx);
  runRoutes(app, ctx);
  reviewRoutes(app, ctx);
}

export type { ApiConfig, ApiContext, EventHub, OrchestratorState, Recovered } from "./context.js";
export { dbEventHub, engineEventHub } from "./context.js";
