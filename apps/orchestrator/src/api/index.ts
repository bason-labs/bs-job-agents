// REST + SSE API (spec §4.2, §7, §8, §11; PM S18, S19, S21, S23). Owned by W3a.
// Every route of the shared API_ROUTES that does not need F2's conversation seam; chat, consult,
// room messages and the Lead MCP server come in W3a part 2.
import type { FastifyInstance } from "fastify";
import type { ApiContext } from "./context.js";
import { applicationRoutes } from "./routes/applications.js";
import { botRoutes } from "./routes/bots.js";
import { criteriaRoutes } from "./routes/criteria.js";
import { engineRoutes } from "./routes/engines.js";
import { eventRoutes } from "./routes/events.js";
import { exportRoutes } from "./routes/exports.js";
import { fileRoutes } from "./routes/files.js";
import { healthRoutes } from "./routes/health.js";
import { masterCvRoutes } from "./routes/master-cv.js";
import { reviewRoutes } from "./routes/review.js";
import { roomRoutes } from "./routes/rooms.js";
import { runRoutes } from "./routes/runs.js";
import { scheduleRoutes } from "./routes/schedules.js";
import { uploadRoutes } from "./routes/uploads.js";

export interface RouteOptions {
  /** SSE heartbeat interval in ms (default 15 s). */
  heartbeatMs?: number;
}

export function registerRoutes(app: FastifyInstance, ctx: ApiContext, opts: RouteOptions = {}): void {
  healthRoutes(app, ctx);
  eventRoutes(app, ctx, opts);
  fileRoutes(app, ctx);
  runRoutes(app, ctx);
  reviewRoutes(app, ctx);
  criteriaRoutes(app, ctx);
  scheduleRoutes(app, ctx);
  applicationRoutes(app, ctx);
  exportRoutes(app, ctx);
  uploadRoutes(app, ctx);
  botRoutes(app, ctx);
  engineRoutes(app, ctx);
  masterCvRoutes(app, ctx);
  roomRoutes(app, ctx);
}

export type { ApiConfig, ApiContext, EventHub, OrchestratorState, Recovered } from "./context.js";
export { dbEventHub, engineEventHub } from "./context.js";
