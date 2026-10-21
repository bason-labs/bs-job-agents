// CV guidance (§7, §5.9): the rule set with its sources, Ba's Turn off / Turn on per rule (a state
// change: the S18 Origin and CSRF checks apply, SEC-19), and the activity log. The refresh itself is
// the engine's; these routes never write the rule set.
import { API_ROUTES, ActivityResponseSchema, GuidanceViewSchema } from "@bs-job-agents/shared";
import type { FastifyInstance } from "fastify";
import { currentGuidanceRuleSet, setGuidanceRuleOff } from "../../db/repos/guidance.js";
import { requireDb, type ApiContext } from "../context.js";
import { notFound } from "../errors.js";
import { respond } from "../http.js";
import { activityEntries, guidanceView } from "../views/guidance.js";

type RuleParams = { Params: { id: string } };

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

  app.get(API_ROUTES.activity, async () => respond(ActivityResponseSchema, { entries: activityEntries(requireDb(ctx)) }));
}
