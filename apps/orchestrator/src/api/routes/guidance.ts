// CV guidance (§7, §5.9) and skill self-repair (§5.6, §5.7): the rule set with its sources, Ba's Turn off / Turn on per rule (a state
// change: the S18 Origin and CSRF checks apply, SEC-19), and the activity log. The refresh itself is
// the engine's; these routes never write the rule set.
import { API_ROUTES, ActivityResponseSchema, GuidanceViewSchema, type ActivityEntry } from "@bs-job-agents/shared";
import type { FastifyInstance } from "fastify";
import { currentGuidanceRuleSet, setGuidanceRuleOff } from "../../db/repos/guidance.js";
import { SkillRepairActionError } from "../../engine/index.js";
import { skillRepairActivity } from "../../engine/skill-repair.js";
import { requireDb, requireEngine, type ApiContext } from "../context.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { respond } from "../http.js";
import { activityEntries, guidanceView } from "../views/guidance.js";

type RuleParams = { Params: { id: string } };
type SourceParams = { Params: { source: string } };

/** Guidance changes, skill repairs and API-path changes in one list, newest first. */
function allActivity(ctx: ApiContext): ActivityEntry[] {
  const db = requireDb(ctx);
  const skills = ctx.engine ? ctx.engine.skillRepairActivity() : skillRepairActivity(db, null);
  const order = (e: ActivityEntry) => (/^\d+$/.test(e.id) ? Number(e.id) : Number.MAX_SAFE_INTEGER);
  return [...activityEntries(db), ...skills].sort((a, b) => b.at.localeCompare(a.at) || order(b) - order(a));
}

/** Skill self-repair: the engine's refusals as HTTP errors. */
function skillAction<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof SkillRepairActionError) throw err.code === "not_found" ? notFound(err.message) : conflict(err.message);
    throw err;
  }
}

export function guidanceRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.get(API_ROUTES.guidance, async () => respond(GuidanceViewSchema, guidanceView(requireDb(ctx))));

  /** §5.9: Ba's one control. A refresh never turns a rule back on. */
  const setOff = (id: string, off: boolean) => {
    const db = requireDb(ctx);
    if (!currentGuidanceRuleSet(db)?.ruleSet.rules.some((r) => r.id === id)) throw notFound(`there is no CV guidance rule ${id}`);
    setGuidanceRuleOff(db, id, off);
    return guidanceView(db);
  };
  app.post<RuleParams>(API_ROUTES.guidanceRuleOff, async (req) => respond(GuidanceViewSchema, setOff(req.params.id, true)));
  app.post<RuleParams>(API_ROUTES.guidanceRuleOn, async (req) => respond(GuidanceViewSchema, setOff(req.params.id, false)));

  app.get(API_ROUTES.activity, async () => respond(ActivityResponseSchema, { entries: allActivity(ctx) }));

  /** Skill self-repair §5.7: put back the skill an adopted repair replaced (state change: Origin and CSRF, SEC-19). */
  app.post<RuleParams>(API_ROUTES.skillRepairRestore, async (req) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw badRequest(`${req.params.id} is not a repair id`);
    const engine = requireEngine(ctx);
    skillAction(() => engine.restoreSkill(id));
    return respond(ActivityResponseSchema, { entries: allActivity(ctx) });
  });

  /** Skill self-repair §5.6: Ba's "Try repair again" on a paused source (SEC-19). */
  app.post<SourceParams>(API_ROUTES.skillRepairRetry, async (req) => {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(req.params.source)) throw badRequest(`${req.params.source} is not a source`);
    const engine = requireEngine(ctx);
    skillAction(() => engine.retrySkillRepair(req.params.source));
    return respond(ActivityResponseSchema, { entries: allActivity(ctx) });
  });
}
