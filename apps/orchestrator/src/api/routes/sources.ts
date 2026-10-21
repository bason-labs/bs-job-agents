// API research (design 2026-10-19 §5.1, §5.6): how each source is read, for the Search criteria
// screen ("Public API", "Account API", "Account API (needs approval)", "Account API (token
// missing)", "Browser"), and Ba's approval of a high-risk board's account API, bound to the
// research he read. The path comes from engine/access.ts, the same function the queue uses. Only
// whether a credential is set leaves here, never a value.
import {
  API_ROUTES,
  SearchSourceSchema,
  SourceAccessResponseSchema,
  SourceAccessViewSchema,
  SourceApprovalRequestSchema,
  accessPathOf,
  isBoardSource,
  sourceAccessRecord,
  type SearchSource,
  type SourceAccessView,
} from "@bs-job-agents/shared";
import type { FastifyInstance } from "fastify";
import { approveSource, getSourceApproval, revokeSource, type Conn } from "../../db/index.js";
import { sourceAccess } from "../../engine/access.js";
import type { BoardScanPort } from "../../engine/ports.js";
import { requireDb, type ApiContext } from "../context.js";
import { conflict, notFound } from "../errors.js";
import { parseWith, respond } from "../http.js";

function viewOf(conn: Conn, boards: BoardScanPort | undefined, source: SearchSource): SourceAccessView {
  const access = sourceAccess(conn, boards, source);
  const record = access.record ?? (isBoardSource(source) ? sourceAccessRecord(source) : null);
  const approval = record ? getSourceApproval(conn, source) : undefined;
  return {
    source,
    path: access.path,
    labelKey: access.labelKey,
    needsApproval: access.needsApproval,
    tokenMissing: access.tokenMissing,
    noLogin: record?.auth.kind === "none",
    approvedAt: approval && approval.researchedAt === record?.researchedAt ? approval.approvedAt : null,
    researchedAt: record?.researchedAt ?? null,
    riskLevel: record?.riskLevel ?? null,
    termsOfUse: record?.termsOfUse ?? null,
    accountRisk: record?.accountRisk ?? null,
  };
}

export function sourceRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const boards = () => ctx.engine?.deps.boards;
  const board = (raw: string) => {
    if (!isBoardSource(raw)) throw notFound(`${raw} is not a board with an access record`);
    return raw;
  };

  app.get(API_ROUTES.sourceAccess, async () => {
    const db = requireDb(ctx);
    return respond(SourceAccessResponseSchema, { sources: SearchSourceSchema.options.map((s) => viewOf(db, boards(), s)) });
  });

  app.post<{ Params: { source: string } }>(API_ROUTES.sourceApproval, async (req) => {
    const db = requireDb(ctx);
    const source = board(req.params.source);
    const { researchedAt } = parseWith(SourceApprovalRequestSchema, req.body);
    const record = boards()?.record(source) ?? sourceAccessRecord(source);
    if (researchedAt !== record.researchedAt) throw conflict(`the ${source} research changed (${record.researchedAt}); read it again before approving`);
    if (record.riskLevel !== "high" || accessPathOf(record, { approved: true }) !== "account_api") throw conflict(`${source} has no API read that needs approval`);
    // Approving a board nothing can read through its API would change nothing: it stays in the browser.
    if (!boards()?.canScan(source)) throw conflict(`${source} has no API reader yet, so it is read in the browser; there is nothing to approve`);
    approveSource(db, { source, researchedAt }, { now: ctx.now() });
    return respond(SourceAccessViewSchema, viewOf(db, boards(), source));
  });

  app.delete<{ Params: { source: string } }>(API_ROUTES.sourceApproval, async (req) => {
    const db = requireDb(ctx);
    const source = board(req.params.source);
    revokeSource(db, source);
    return respond(SourceAccessViewSchema, viewOf(db, boards(), source));
  });
}
