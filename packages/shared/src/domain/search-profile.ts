// Search Profile (search criteria), §7.5 and UC-21b.
import { z } from "zod";
import {
  CurrencySchema,
  CvLanguageSchema,
  IdSchema,
  IsoDateTimeSchema,
  LIMITS,
  SearchSourceSchema,
  SenioritySchema,
  WorkModeSchema,
} from "../common/primitives.js";

/**
 * Application form defaults → expected salary rule (§7.5, UC-12):
 * - blank_if_optional (default): optional → blank; required → "Negotiable / Thỏa thuận" if text, else ask Ba
 * - negotiable: write "Negotiable" (EN forms) / "Thỏa thuận" (VI forms)
 * - fixed: use salaryAmount
 * - ask: ask Ba each time, with Skip and Negotiable available
 */
export const SalaryPolicySchema = z.enum(["blank_if_optional", "negotiable", "fixed", "ask"]);
export type SalaryPolicy = z.infer<typeof SalaryPolicySchema>;

export const SALARY_POLICY_LABELS = {
  blank_if_optional: "Leave blank when optional",
  negotiable: "Write “Negotiable / Thỏa thuận”",
  fixed: "Use a fixed amount",
  ask: "Ask me each time",
} as const satisfies Record<SalaryPolicy, string>;

export const NEGOTIABLE_TEXT = { en: "Negotiable", vi: "Thỏa thuận" } as const;

const keywordList = z.array(z.string().trim().min(1));

/** The editable fields of a Search Profile, without validation rules. */
export const SearchProfileFieldsBaseSchema = z.object({
  roles: keywordList.describe("e.g. Frontend Engineer"),
  locations: keywordList.describe("e.g. Ho Chi Minh City, Remote (VN)"),
  workModes: z.array(WorkModeSchema),
  minSalary: z.number().int().nonnegative().nullable(),
  /** Currency of minSalary and of salaryAmount. */
  currency: CurrencySchema.nullable(),
  seniority: z.array(SenioritySchema),
  sources: z.array(SearchSourceSchema),
  includeKeywords: keywordList,
  excludeKeywords: keywordList,
  excludeCompanies: keywordList,
  companyTypes: keywordList.describe("Preferred company types, e.g. product, AI. Empty = no filter."),
  /**
   * CV languages to produce for non-Vietnamese JDs. The §6.3 rule always adds VI for
   * Vietnamese JDs (see cvLanguagesForJd), so the default is ["en"].
   */
  languages: z.array(CvLanguageSchema).min(1),
  maxJobs: z.number().int().min(1).max(50),
  fitThreshold: z.number().int().min(0).max(100),
  salaryPolicy: SalaryPolicySchema,
  salaryAmount: z.number().int().positive().nullable(),
});
export type SearchProfileFieldsBase = z.infer<typeof SearchProfileFieldsBaseSchema>;

type SalaryRuleInput = Partial<Pick<SearchProfileFieldsBase, "salaryPolicy" | "salaryAmount" | "minSalary" | "currency">>;

/** Salary rules shared by the full profile and by partial overrides. */
export function checkSalaryRules(v: SalaryRuleInput, ctx: z.RefinementCtx): void {
  if (v.salaryPolicy === "fixed") {
    if (v.salaryAmount === null || v.salaryAmount === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["salaryAmount"],
        message: "salaryAmount is required when the salary rule is Fixed amount",
      });
    }
    if (v.currency === null || v.currency === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["currency"],
        message: "currency is required when the salary rule is Fixed amount",
      });
    }
  }
  if (v.minSalary !== null && v.minSalary !== undefined && (v.currency === null || v.currency === undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["currency"],
      message: "minimum salary needs a currency (VND/USD)",
    });
  }
}

/** UC-21b (b): at least one role, one location and one source. */
function checkRequiredLists(v: Pick<SearchProfileFieldsBase, "roles" | "locations" | "sources">, ctx: z.RefinementCtx): void {
  for (const key of ["roles", "locations", "sources"] as const) {
    if (v[key].length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `at least one ${key.slice(0, -1)} is required` });
    }
  }
}

/** Editable fields with every UC-21b and §7.5 validation rule. Use for criteria updates. */
export const SearchProfileFieldsSchema = SearchProfileFieldsBaseSchema.superRefine((v, ctx) => {
  checkRequiredLists(v, ctx);
  checkSalaryRules(v, ctx);
});
export type SearchProfileFields = z.infer<typeof SearchProfileFieldsSchema>;

/** Per-run overrides (§7.2 params, UC-21b a): any subset of fields. */
export const SearchProfileOverridesSchema = SearchProfileFieldsBaseSchema.partial().strict().superRefine(checkSalaryRules);
export type SearchProfileOverrides = z.infer<typeof SearchProfileOverridesSchema>;

export const SearchProfileSchema = SearchProfileFieldsBaseSchema.extend({
  id: IdSchema,
  name: z.string().min(1),
  /** Bumped on every save (UC-21b). */
  version: z.number().int().positive(),
  active: z.boolean(),
  updatedAt: IsoDateTimeSchema,
}).superRefine((v, ctx) => {
  checkRequiredLists(v, ctx);
  checkSalaryRules(v, ctx);
});
export type SearchProfile = z.infer<typeof SearchProfileSchema>;

/** §7.5 defaults (roles/locations come from Ba's first chat request). */
export const SEARCH_PROFILE_DEFAULTS = {
  workModes: ["onsite", "hybrid", "remote"],
  minSalary: null,
  currency: null,
  seniority: ["mid", "senior"],
  sources: ["topcv", "itviec", "linkedin"],
  includeKeywords: [],
  excludeKeywords: [],
  excludeCompanies: [],
  companyTypes: [],
  languages: ["en"],
  maxJobs: LIMITS.maxJobsDefault,
  fitThreshold: LIMITS.fitThresholdDefault,
  salaryPolicy: "blank_if_optional",
  salaryAmount: null,
} as const satisfies Omit<SearchProfileFieldsBase, "roles" | "locations">;

/** Merge a run's overrides onto a saved profile (a run keeps the version it started with). */
export function applySearchOverrides(
  profile: SearchProfileFieldsBase,
  overrides: SearchProfileOverrides | null | undefined,
): SearchProfileFieldsBase {
  if (!overrides) return { ...profile };
  const out = { ...profile };
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
