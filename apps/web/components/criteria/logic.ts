// Search criteria form logic (UC-21b, spec §7.5). Pure: the screen and the tests share it.
import {
  CurrencySchema,
  SALARY_POLICY_LABELS,
  SEARCH_SOURCES,
  SOURCE_GROUPS,
  SalaryPolicySchema,
  SearchProfileFieldsSchema,
  SearchSourceSchema,
  SenioritySchema,
  WorkModeSchema,
  anyRemoteSource,
  sourcesInGroup,
  type CriteriaUpdateRequest,
  type SearchProfile,
  type SearchProfileFieldsBase,
} from "@bs-job-agents/shared";
import { formatDate } from "@/components/schedules/datetime";

/** The editable fields; the currency always has a value in the form. */
export type CriteriaForm = Omit<SearchProfileFieldsBase, "currency"> & { currency: NonNullable<SearchProfileFieldsBase["currency"]> };

export type ChipField = "roles" | "locations" | "includeKeywords" | "excludeKeywords" | "excludeCompanies" | "companyTypes";

/** Chip cards, in the prototype's order and copy. */
export const CHIP_FIELDS: readonly { key: ChipField; label: string }[] = [
  { key: "roles", label: "Roles" },
  { key: "locations", label: "Locations" },
  { key: "includeKeywords", label: "Must include keywords" },
  { key: "excludeKeywords", label: "Exclude keywords" },
  { key: "excludeCompanies", label: "Excluded companies" },
  { key: "companyTypes", label: "Preferred company types" },
];

const WORK_MODE_LABELS = { onsite: "Onsite", hybrid: "Hybrid", remote: "Remote" } as const;
const SENIORITY_LABELS = { intern: "Intern", junior: "Junior", mid: "Mid", senior: "Senior", lead: "Lead" } as const;

/** Every source toggle, in SearchSourceSchema order (the order a saved list keeps). */
export const SOURCE_OPTIONS = SearchSourceSchema.options.map((value) => ({ value, label: SEARCH_SOURCES[value].label }));

/** W5: the toggles grouped as the screen shows them: Vietnam boards, Remote boards, Global. New sources are off by default. */
export const SOURCE_GROUP_OPTIONS = SOURCE_GROUPS.map(({ group, label }) => ({
  group,
  label,
  options: sourcesInGroup(group).map((value) => ({ value, label: SEARCH_SOURCES[value].label })),
}));

/** W5: the time-zone overlap field shows when any remote board is on. */
export const showsTimezoneOverlap = (form: Pick<CriteriaForm, "sources">): boolean => anyRemoteSource(form.sources);
export const WORK_MODE_OPTIONS = WorkModeSchema.options.map((value) => ({ value, label: WORK_MODE_LABELS[value] }));
export const SENIORITY_OPTIONS = SenioritySchema.options.map((value) => ({ value, label: SENIORITY_LABELS[value] }));
export const CURRENCY_OPTIONS = CurrencySchema.options.map((value) => ({ value, label: value }));
export const SALARY_POLICY_OPTIONS = SalaryPolicySchema.options.map((value) => ({ value, label: SALARY_POLICY_LABELS[value] }));

/** The form before the first save (GET /criteria answered 404): the shared defaults, no roles or locations yet. */
export const BLANK_FORM: CriteriaForm = {
  roles: [],
  locations: [],
  workModes: ["onsite", "hybrid", "remote"],
  minSalary: null,
  currency: "VND",
  seniority: [],
  sources: ["topcv", "itviec", "linkedin"],
  includeKeywords: [],
  excludeKeywords: [],
  excludeCompanies: [],
  companyTypes: [],
  languages: ["en"],
  maxJobs: 5,
  fitThreshold: 60,
  salaryPolicy: "blank_if_optional",
  salaryAmount: null,
};

/** The form for a saved profile; null (none saved yet) gives BLANK_FORM. */
export function profileToForm(p: SearchProfile | null): CriteriaForm {
  if (!p) return structuredClone(BLANK_FORM);
  const { id: _id, name: _name, version: _version, active: _active, updatedAt: _updatedAt, ...fields } = p;
  return structuredClone({ ...fields, currency: fields.currency ?? "VND" });
}

export function formToRequest(form: CriteriaForm): CriteriaUpdateRequest {
  // W5: the time-zone overlap is always sent (null clears it), so a profile saved before it
  // compares equal to the same form.
  const timezoneOverlap = form.timezoneOverlap?.trim() ? form.timezoneOverlap.trim() : null;
  return { ...structuredClone(form), salaryAmount: form.salaryAmount ? form.salaryAmount : null, timezoneOverlap };
}

/** Adds a trimmed chip unless it is empty or already there (case-insensitive). */
export function addChip(list: readonly string[], value: string): string[] {
  const v = value.trim();
  if (!v || list.some((x) => x.toLowerCase() === v.toLowerCase())) return [...list];
  return [...list, v];
}

export function removeChip(list: readonly string[], index: number): string[] {
  return list.filter((_, i) => i !== index);
}

/** Toggles `value` in `list`, keeping `order`. */
export function toggleValue<T extends string>(list: readonly T[], value: T, order: readonly T[]): T[] {
  const on = new Set(list);
  if (on.has(value)) on.delete(value);
  else on.add(value);
  return order.filter((v) => on.has(v));
}

export type CriteriaErrors = Partial<Record<keyof CriteriaForm, string>>;

const MESSAGES: Partial<Record<keyof CriteriaForm, string>> = {
  roles: "Add at least one role",
  locations: "Add at least one location",
  sources: "Pick at least one source",
  salaryAmount: "Enter the amount Apply should write",
  currency: "Pick a currency (VND or USD)",
  minSalary: "Minimum salary must be a whole number",
  timezoneOverlap: "Use a region (Asia, APAC, Europe…) or a UTC offset with a window, e.g. UTC+7 ±3h",
};

/** UC-21b (b) and §7.5 rules, through the shared schema; one message per field. */
export function validateCriteria(form: CriteriaForm): CriteriaErrors {
  const result = SearchProfileFieldsSchema.safeParse(formToRequest(form));
  if (result.success) return {};
  const errors: CriteriaErrors = {};
  for (const issue of result.error.issues) {
    const key = issue.path[0] as keyof CriteriaForm | undefined;
    if (key && !errors[key]) errors[key] = MESSAGES[key] ?? issue.message;
  }
  return errors;
}

export function isDirty(form: CriteriaForm, saved: SearchProfile | null): boolean {
  return JSON.stringify(formToRequest(form)) !== JSON.stringify(formToRequest(profileToForm(saved)));
}

/** "Active profile v3 · updated 2026-10-10" (prototype; "just now" right after saving). */
export function profileHeader(p: Pick<SearchProfile, "version" | "updatedAt"> | null, justSaved: boolean): string {
  if (!p) return "No search criteria yet · saving creates v1";
  return `Active profile v${p.version} · updated ${justSaved ? "just now" : formatDate(p.updatedAt)}`;
}
