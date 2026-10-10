// GET /health and GET /status (S19 degraded start): HTTP serves even when the engine could not start,
// so the UI shows why instead of "orchestrator unreachable".
import { API_ROUTES, HealthStatusSchema, OrchestratorStatusSchema, type HealthStatus, type OrchestratorStatus } from "@bs-job-agents/shared";
import type { FastifyInstance } from "fastify";
import type { ApiContext } from "../context.js";
import { respond } from "../http.js";

export function healthRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.get(API_ROUTES.health, async (_req, reply): Promise<HealthStatus> => {
    const s = ctx.state;
    if (s.state === "running") return respond(HealthStatusSchema, { ok: true });
    void reply.code(503);
    return respond(HealthStatusSchema, { ok: false, reason: s.reason, detail: s.detail });
  });

  app.get(API_ROUTES.status, async (): Promise<OrchestratorStatus> => {
    const s = ctx.state;
    return respond(OrchestratorStatusSchema, {
      state: s.state,
      reason: s.state === "degraded" ? s.reason : null,
      detail: s.state === "degraded" ? s.detail : null,
      startedAt: s.startedAt,
      dataDir: ctx.config.dataDir,
      recovered: s.state === "running" ? s.recovered : null,
    });
  });
}
