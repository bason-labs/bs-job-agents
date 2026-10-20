// How each source is read, in the mock orchestrator (design 2026-10-19 §5.1, §5.6), like the
// orchestrator's routes/sources.ts: the shared access records and accessStateOf, Ba's approvals
// bound to the record's researchedAt, and which boards have a token in the secrets file. A board
// without an API reader (not in API_READER_BOARDS: Wellfound, Upwork) reads in the browser and has
// nothing to approve, as in production; a test can add or remove a reader.
import {
  API_READER_BOARDS,
  SearchSourceSchema,
  accessPathOf,
  accessStateOf,
  isBoardSource,
  isFeedSource,
  sourceAccessRecord,
  type BoardSource,
  type SearchSource,
  type SourceAccessView,
} from "@bs-job-agents/shared";
import { ApiRequestError } from "../errors";
import type { MockBackend } from "./backend";

export interface MockSourceAccess {
  /** Ba's approvals of high-risk boards, with the research he read. */
  approvals: Partial<Record<BoardSource, { approvedAt: string; researchedAt: string }>>;
  /** Boards whose credentials are in the secrets file (only whether, never a value). */
  tokens: BoardSource[];
  /** Boards with an API reader (default API_READER_BOARDS, the orchestrator's mappers). */
  readers?: BoardSource[];
}

const readers = (a: MockSourceAccess): readonly BoardSource[] => a.readers ?? API_READER_BOARDS;

const fail = (status: number, code: ApiRequestError["code"], message: string) => new ApiRequestError({ status, code, message, details: null });

function access(core: MockBackend): MockSourceAccess {
  core.state.sourceAccess ??= { approvals: {}, tokens: [] };
  return core.state.sourceAccess;
}

export function sourceAccessView(core: MockBackend, source: SearchSource): SourceAccessView {
  if (isFeedSource(source) || !isBoardSource(source)) {
    const path = isFeedSource(source) ? "public_api" : "browser";
    return { source, path, labelKey: path, needsApproval: false, tokenMissing: false, noLogin: false, approvedAt: null, researchedAt: null, riskLevel: null, termsOfUse: null, accountRisk: null };
  }
  const record = sourceAccessRecord(source);
  const a = access(core);
  if (!readers(a).includes(source)) {
    return { source, path: "browser", labelKey: "browser", needsApproval: false, tokenMissing: false, noLogin: record.auth.kind === "none", approvedAt: null, researchedAt: record.researchedAt, riskLevel: record.riskLevel, termsOfUse: record.termsOfUse, accountRisk: record.accountRisk };
  }
  const approval = a.approvals[source];
  const approved = approval !== undefined && approval.researchedAt === record.researchedAt;
  const state = accessStateOf(record, { approved, tokenPresent: a.tokens.includes(source) });
  return {
    source,
    ...state,
    noLogin: record.auth.kind === "none",
    approvedAt: approved ? approval.approvedAt : null,
    researchedAt: record.researchedAt,
    riskLevel: record.riskLevel,
    termsOfUse: record.termsOfUse,
    accountRisk: record.accountRisk,
  };
}

export const allSourceAccess = (core: MockBackend) => ({ sources: SearchSourceSchema.options.map((s) => sourceAccessView(core, s)) });

function board(raw: string): BoardSource {
  if (!isBoardSource(raw)) throw fail(404, "not_found", `${raw} is not a board with an access record`);
  return raw;
}

export function approveSource(core: MockBackend, raw: string, researchedAt: string): SourceAccessView {
  const source = board(raw);
  const record = sourceAccessRecord(source);
  if (researchedAt !== record.researchedAt) throw fail(409, "conflict", `the ${source} research changed (${record.researchedAt}); read it again before approving`);
  if (record.riskLevel !== "high" || accessPathOf(record, { approved: true }) !== "account_api") throw fail(409, "conflict", `${source} has no account API that needs approval`);
  if (!readers(access(core)).includes(source)) throw fail(409, "conflict", `${source} has no API reader yet, so it is read in the browser; there is nothing to approve`);
  access(core).approvals[source] = { approvedAt: core.nowIso(), researchedAt };
  return sourceAccessView(core, source);
}

export function revokeSource(core: MockBackend, raw: string): SourceAccessView {
  const source = board(raw);
  delete access(core).approvals[source];
  return sourceAccessView(core, source);
}
