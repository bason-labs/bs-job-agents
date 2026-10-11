// GET /engines (UC-16, §11 sidebar): per engine, whether it is paused for a usage limit and until
// when, the latest usage reading, the sessions it runs and its cap.
import { API_ROUTES, EngineSchema, EngineUsageSchema, EnginesResponseSchema, OkResponseSchema, type Engine, type EngineStatus, type EngineUsage } from "@bs-job-agents/shared";
import { desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { ENGINES, countTasks, getEngineState, schema, type Db } from "../../db/index.js";
import { DEFAULT_ENGINE_CONFIG } from "../../engine/index.js";
import { requireDb, requireEngine, type ApiContext } from "../context.js";
import { notFound } from "../errors.js";
import { respond } from "../http.js";

/** The newest engine.usage reading per engine (Claude reports utilization; Codex reports none). */
function latestUsage(db: Db): Map<Engine, EngineUsage> {
  const out = new Map<Engine, EngineUsage>();
  const rows = db.select().from(schema.events).where(eq(schema.events.type, "engine.usage")).orderBy(desc(schema.events.id)).limit(200).all();
  for (const row of rows) {
    const p = row.payload as { engine?: unknown; usage?: unknown };
    const engine = p.engine === "claude" || p.engine === "codex" ? p.engine : null;
    const usage = EngineUsageSchema.safeParse(p.usage);
    if (engine && usage.success && !out.has(engine)) out.set(engine, usage.data);
  }
  return out;
}

export function engineRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.get(API_ROUTES.engines, async () => {
    const db = requireDb(ctx);
    const now = ctx.now().toISOString();
    const usage = latestUsage(db);
    const caps = ctx.engine?.config.engineCaps ?? DEFAULT_ENGINE_CONFIG.engineCaps;
    const engines: EngineStatus[] = ENGINES.map((engine) => {
      const state = getEngineState(db, engine);
      // A pause that expired is over; the engine resumes on its own (UC-16 step 5).
      const paused = state.pausedUntil !== null && state.pausedUntil > now;
      return {
        engine,
        pausedUntil: paused ? state.pausedUntil : null,
        reason: paused ? state.reason : null,
        usage: usage.get(engine) ?? null,
        activeSessions: countTasks(db, { status: "running", engine }),
        maxSessions: caps[engine],
      };
    });
    return respond(EnginesResponseSchema, { engines });
  });

  // Live run 1: "Resume now" (e.g. Ba switched Claude accounts). Not paused → 409 (engine conflict).
  app.post<{ Params: { engine: string } }>(API_ROUTES.engineResume, async (req) => {
    const engine = EngineSchema.safeParse(req.params.engine);
    if (!engine.success) throw notFound(`engine ${req.params.engine} not found`);
    requireEngine(ctx).resumeEngineNow(engine.data);
    return respond(OkResponseSchema, { ok: true });
  });
}
