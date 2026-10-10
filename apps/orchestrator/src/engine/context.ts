// A run as the engine sees it: its workflow definition, validated params, the Search Profile
// version it started with (plus the run's overrides) and the master CV version.
import {
  SEARCH_PROFILE_DEFAULTS,
  WORKFLOW_PARAMS_SCHEMAS,
  applySearchOverrides,
  type CvLanguage,
  type SearchProfileFieldsBase,
  type SearchProfileOverrides,
  type WorkflowDefinition,
  type WorkflowStep,
} from "@bs-job-agents/shared";
import { getRun, getSearchProfile, getStepByKey, type Conn, type Run, type SearchProfile, type Step } from "../db/index.js";
import type { EngineCore } from "./core.js";
import type { TemplateScope } from "./templates.js";
import type { JobRef } from "./state.js";

export interface RunCtx {
  run: Run;
  def: WorkflowDefinition;
  params: Record<string, unknown>;
  /** The pinned profile version with the run's overrides, or null (e.g. apply-to-link without a profile). */
  profile: SearchProfileFieldsBase | null;
  masterVersion: number | null;
}

/** Where a step runs: run level (branchKey "") or a per-job branch (job id; `42:vi` for a per-language gate). */
export interface Scope {
  branchKey: string;
  item?: JobRef;
  language?: CvLanguage;
}

export const RUN_SCOPE: Scope = { branchKey: "" };

export function profileFields(row: SearchProfile): SearchProfileFieldsBase {
  return {
    roles: row.roles,
    locations: row.locations,
    workModes: row.workModes,
    minSalary: row.minSalary === null ? null : Math.round(row.minSalary),
    currency: row.currency,
    seniority: row.seniority,
    sources: row.sources,
    includeKeywords: row.includeKeywords,
    excludeKeywords: row.excludeKeywords,
    excludeCompanies: row.excludeCompanies,
    companyTypes: row.companyTypes,
    languages: row.languages,
    maxJobs: row.maxJobs,
    fitThreshold: row.fitThreshold,
    salaryPolicy: row.salaryPolicy,
    salaryAmount: row.salaryAmount === null ? null : Math.round(row.salaryAmount),
  };
}

/** Run params validated against the workflow's params schema; unknown workflows keep their raw params. */
export function validRunParams(workflowName: string, params: unknown): Record<string, unknown> {
  const schema = (WORKFLOW_PARAMS_SCHEMAS as Record<string, { safeParse(v: unknown): { success: boolean; data?: unknown } }>)[workflowName];
  if (!schema) return (params ?? {}) as Record<string, unknown>;
  const parsed = schema.safeParse(params ?? {});
  return (parsed.success ? parsed.data : params ?? {}) as Record<string, unknown>;
}

export function loadRunCtx(core: EngineCore, runId: number, conn: Conn = core.db): RunCtx | null {
  const run = getRun(conn, runId);
  if (!run) return null;
  const def = core.deps.workflows.get(run.workflowName, run.workflowVersion);
  if (!def) return null;
  const params = validRunParams(run.workflowName, run.params);
  const row = run.searchProfileId !== null ? getSearchProfile(conn, run.searchProfileId) : undefined;
  const overrides = (params.overrides ?? null) as SearchProfileOverrides | null;
  const profile = row ? applySearchOverrides(profileFields(row), overrides) : null;
  return { run, def, params, profile, masterVersion: core.deps.masterCv.version() };
}

/** The form defaults Apply uses (§7.5): the run's profile, or the §7.5 defaults. */
export function formDefaultsOf(ctx: RunCtx | null): Pick<SearchProfileFieldsBase, "salaryPolicy" | "salaryAmount" | "currency"> {
  const p = ctx?.profile;
  return {
    salaryPolicy: p?.salaryPolicy ?? SEARCH_PROFILE_DEFAULTS.salaryPolicy,
    salaryAmount: p?.salaryAmount ?? null,
    currency: p?.currency ?? null,
  };
}

/** The step row for `key` in this scope (a branch, then run level). */
export function findStepRow(conn: Conn, runId: number, key: string, scope: Scope): Step | undefined {
  return getStepByKey(conn, runId, key, scope.branchKey) ?? (scope.branchKey ? getStepByKey(conn, runId, key, String(scope.item?.jobId ?? "")) : undefined) ?? getStepByKey(conn, runId, key, "");
}

export function templateScope(conn: Conn, ctx: RunCtx, scope: Scope): TemplateScope {
  const overrides = (ctx.params.overrides ?? {}) as Record<string, unknown>;
  return {
    params: { ...(ctx.profile ?? {}), ...ctx.params, ...overrides },
    profile: (ctx.profile as Record<string, unknown> | null) ?? null,
    item: scope.item,
    branch: scope.branchKey || undefined,
    steps: (key) => findStepRow(conn, ctx.run.id, key, scope)?.output ?? undefined,
  };
}

export function stepDef(ctx: RunCtx, key: string): WorkflowStep | undefined {
  return ctx.def.steps.find((s) => s.key === key);
}
