// API research (design 2026-10-19 §5.1, spec REQ-22, AD-3): the access record of one browser board,
// written by a person from the board's network traffic, terms and account risk. It decides how the
// board is read (accessPathOf): public API, then the board's internal API with Ba's own token (the
// "account API"), then the browser. Apply endpoints are data only: nothing ever builds a request
// from them (AD-2).
import { z } from "zod";

export const NONE_FOUND = "none found" as const;
const NoneFound = z.literal(NONE_FOUND);

export const AccessPathSchema = z.enum(["public_api", "account_api", "browser"]);
export type AccessPath = z.infer<typeof AccessPathSchema>;

export const RiskLevelSchema = z.enum(["low", "high"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

const endpointShape = {
  host: z.string().min(1).describe("e.g. itviec.com"),
  pathPattern: z.string().startsWith("/").describe('e.g. "/v1/jobs/:id"; ":name" matches one path segment'),
  query: z.array(z.string().min(1)).optional().describe("Query parameter names the endpoint takes"),
  purpose: z.enum(["search", "detail", "other"]),
  requiresAuth: z.boolean(),
  fixture: z.string().min(1).optional().describe("Scrubbed sample response under board-api/fixtures/<source>/"),
};

/** A read endpoint the client may call (GET only). */
export const GetEndpointSchema = z.object({ method: z.literal("GET"), ...endpointShape });
export type GetEndpoint = z.infer<typeof GetEndpointSchema>;

/** An apply endpoint: documented only, never called (REQ-22.AC-2). Any method: apply is usually a POST. */
export const ApplyEndpointSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  ...endpointShape,
  documentedOnly: z.literal(true),
});
export type ApplyEndpoint = z.infer<typeof ApplyEndpointSchema>;

export const PublicApiSchema = z.object({
  usable: z.boolean(),
  /** Needs a developer key or an OAuth app: not usable in this sub-project (design §5.1). */
  needsDeveloperKey: z.boolean(),
  docsUrl: z.string().min(1).optional(),
  endpoints: z.array(GetEndpointSchema),
  note: z.string().optional(),
});

export const AuthSchema = z.object({
  kind: z.enum(["none", "cookie", "header", "cookie+header"]),
  /** The cookie and header names; the secrets file holds one value per name. */
  names: z.array(z.string().min(1)),
  /** Where Ba copies each value from in Chrome DevTools. */
  howToCopy: z.string(),
});
export type SourceAuth = z.infer<typeof AuthSchema>;

export const SourceAccessRecordSchema = z.object({
  source: z.string().min(1),
  /** When the research was done; an approval lapses when it changes. */
  researchedAt: z.string().min(1),
  publicApi: z.union([NoneFound, PublicApiSchema]),
  internalApiGetEndpoints: z.union([NoneFound, z.array(GetEndpointSchema)]),
  applyEndpoints: z.union([NoneFound, z.array(ApplyEndpointSchema)]),
  auth: AuthSchema,
  termsOfUse: z.object({ url: z.string(), clauses: z.array(z.string()) }),
  accountRisk: z.string(),
  riskLevel: RiskLevelSchema,
  /** Informational: must equal accessPathOf(record, { approved: true }). */
  chosenPath: AccessPathSchema,
  notes: z.union([z.string(), z.array(z.string())]).optional(),
});
export type SourceAccessRecord = z.infer<typeof SourceAccessRecordSchema>;

/** The internal GET endpoints (none for "none found"). */
export function internalGetEndpoints(record: SourceAccessRecord): GetEndpoint[] {
  return record.internalApiGetEndpoints === NONE_FOUND ? [] : record.internalApiGetEndpoints;
}

/** The public API's endpoints when it is usable without a developer key, else none. */
export function usablePublicEndpoints(record: SourceAccessRecord): GetEndpoint[] {
  const api = record.publicApi;
  return api !== NONE_FOUND && api.usable && !api.needsDeveloperKey ? api.endpoints : [];
}

/** The apply endpoints (documented only). */
export function applyEndpointsOf(record: SourceAccessRecord): ApplyEndpoint[] {
  return record.applyEndpoints === NONE_FOUND ? [] : record.applyEndpoints;
}

/** The terms and the risk are written down (NFR-2: no account API without both). */
function riskDocumented(record: SourceAccessRecord): boolean {
  return record.termsOfUse.clauses.some((c) => c.trim() !== "") && record.accountRisk.trim() !== "";
}

/**
 * The one place a board's path is decided (AD-3, design §5.1): a usable public API; else the account
 * API when an internal GET endpoint, the terms and the risk are recorded and the board is low risk or
 * Ba approved it; else the browser.
 */
export function accessPathOf(record: SourceAccessRecord, opts: { approved: boolean }): AccessPath {
  if (usablePublicEndpoints(record).length > 0) return "public_api";
  if (internalGetEndpoints(record).length > 0 && riskDocumented(record) && (record.riskLevel === "low" || opts.approved)) return "account_api";
  return "browser";
}

/** The label on the Search criteria toggle (design §5.6). */
export const AccessLabelKeySchema = z.enum(["public_api", "account_api", "account_api_needs_approval", "account_api_token_missing", "browser"]);
export type AccessLabelKey = z.infer<typeof AccessLabelKeySchema>;

export const ACCESS_LABELS: Record<AccessLabelKey, string> = {
  public_api: "Public API",
  account_api: "Account API",
  account_api_needs_approval: "Account API (needs approval)",
  account_api_token_missing: "Account API (token missing)",
  browser: "Browser",
};

export interface AccessState {
  path: AccessPath;
  /** A high-risk board whose account API waits for Ba's approval (it reads in the browser until then). */
  needsApproval: boolean;
  /** The account API is the path but no credential is configured (the scan falls back to the browser). */
  tokenMissing: boolean;
  labelKey: AccessLabelKey;
}

/**
 * What the screen needs for one board. `tokenPresent` comes from the orchestrator's secret store
 * (shared never reads secrets).
 */
export function accessStateOf(record: SourceAccessRecord, opts: { approved: boolean; tokenPresent: boolean }): AccessState {
  const path = accessPathOf(record, { approved: opts.approved });
  const needsApproval = path === "browser" && !opts.approved && accessPathOf(record, { approved: true }) === "account_api";
  const tokenMissing = path === "account_api" && record.auth.kind !== "none" && !opts.tokenPresent;
  const labelKey: AccessLabelKey = needsApproval ? "account_api_needs_approval" : tokenMissing ? "account_api_token_missing" : path;
  return { path, needsApproval, tokenMissing, labelKey };
}
