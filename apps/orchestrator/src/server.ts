import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { registerRoutes, type RouteOptions } from "./api/index.js";
import type { ApiContext } from "./api/context.js";
import { registerErrorHandling } from "./api/http.js";
import { registerSecurity } from "./api/security.js";
import { registerTokenGuard } from "./api/token-guard.js";

export interface ServerOptions extends RouteOptions {
  logger?: FastifyServerOptions["logger"];
}

/** JSON bodies are small (criteria, master CV); uploads have their own multipart limits. */
export const JSON_BODY_LIMIT = 1024 * 1024;

/** The port the server listens on, or null before `listen` (inject in tests). */
function listeningPort(app: FastifyInstance): number | null {
  const address = app.server.address();
  return address !== null && typeof address === "object" ? address.port : null;
}

/** Builds the orchestrator HTTP server without listening (tests use `inject`). */
export function buildServer(ctx: ApiContext, opts: ServerOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: JSON_BODY_LIMIT,
    // Long-lived SSE responses must not hold up a shutdown.
    forceCloseConnections: true,
    return503OnClosing: true,
  });
  registerErrorHandling(app);
  registerSecurity(app, { port: () => listeningPort(app) ?? ctx.config.port, webOrigins: ctx.config.webOrigins });
  registerTokenGuard(app, ctx);
  registerRoutes(app, ctx, opts);
  return app;
}
