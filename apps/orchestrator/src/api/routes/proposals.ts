// Rule 3 (PM S22): Lead's workflow proposals for Ba. Approve saves the workflow as a new version in
// the `workflows` table and starts nothing; dismiss only marks it. The list is newest first.
import {
  API_ROUTES,
  WorkflowProposalApproveResponseSchema,
  WorkflowProposalSchema,
  WorkflowProposalsResponseSchema,
} from "@bs-job-agents/shared";
import type { FastifyInstance } from "fastify";
import { proposalsOf, requireDb, type ApiContext } from "../context.js";
import { notFound } from "../errors.js";
import { respond } from "../http.js";

type IdParams = { Params: { id: string } };

/** Proposal ids are UUIDs; anything else is a 404, never a lookup. */
function proposalId(raw: string): string {
  if (!/^[0-9a-f-]{36}$/.test(raw)) throw notFound(`workflow proposal ${raw} not found`);
  return raw;
}

export function proposalRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.get(API_ROUTES.workflowProposals, async () => {
    const proposals = [...proposalsOf(ctx).list()].reverse();
    return respond(WorkflowProposalsResponseSchema, { proposals });
  });

  app.post<IdParams>(API_ROUTES.workflowProposalApprove, async (req) => {
    const db = requireDb(ctx);
    const result = proposalsOf(ctx).approve(proposalId(req.params.id), db);
    return respond(WorkflowProposalApproveResponseSchema, result);
  });

  app.post<IdParams>(API_ROUTES.workflowProposalDismiss, async (req) => {
    return respond(WorkflowProposalSchema, proposalsOf(ctx).dismiss(proposalId(req.params.id)));
  });
}
