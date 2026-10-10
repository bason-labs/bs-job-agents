import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { Health } from "@bs-job-agents/shared";

/** Builds the orchestrator HTTP server without listening (tests use `inject`). */
export function buildServer(opts: FastifyServerOptions = {}): FastifyInstance {
  const app = Fastify(opts);

  app.get("/health", async (): Promise<Health> => ({ ok: true }));

  return app;
}
