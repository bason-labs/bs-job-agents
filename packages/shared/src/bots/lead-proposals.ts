// PM3 M3 / S1: what Lead's proposals mean. Shared by the orchestrator (which stores the proposal and
// acts on Ba's click) and the web mock, so both compute the same profile, card text and schedule.
// Card text is always built here from the proposal's data, never from Lead's own wording.
import { SEARCH_SOURCES } from "../common/sources.js";
import type { SearchProfileFieldsBase } from "../domain/search-profile.js";
import type { CriteriaChanges, ScheduleProposal } from "./lead.js";

type ListField = "roles" | "locations" | "includeKeywords" | "excludeKeywords" | "excludeCompanies" | "companyTypes";

const LIST_FIELDS: readonly ListField[] = ["roles", "locations", "includeKeywords", "excludeKeywords", "excludeCompanies", "companyTypes"];

const LIST_LABELS: Record<ListField, string> = {
  roles: "roles",
  locations: "locations",
  includeKeywords: "include keywords",
  excludeKeywords: "exclude keywords",
  excludeCompanies: "excluded companies",
  companyTypes: "preferred company types",
};

// W5: every search source's label comes from shared SEARCH_SOURCES.
const SOURCE_LABELS: Record<string, string> = Object.fromEntries(Object.entries(SEARCH_SOURCES).map(([k, v]) => [k, v.label]));

const fold = (s: string) => s.trim().toLocaleLowerCase("vi");

/** A choice-card key for a stored proposal: `criteria-save:<id>` or `schedule-create:<id>`. */
export const CRITERIA_SAVE_KEY_PREFIX = "criteria-save:";
export const SCHEDULE_CREATE_KEY_PREFIX = "schedule-create:";

/** The choice options of each proposal card (the last one is the primary button). */
export const CRITERIA_SAVE_OPTIONS = [
  { id: "just_this_run", label: "Just this run" },
  { id: "save", label: "Save to my criteria" },
] as const;
export const SCHEDULE_CREATE_OPTIONS = [
  { id: "not_now", label: "Not now" },
  { id: "create", label: "Create schedule" },
] as const;

/** The active profile with the proposal applied (lists edited case-insensitively, no duplicates). */
export function applyCriteriaChanges(base: SearchProfileFieldsBase, changes: CriteriaChanges): SearchProfileFieldsBase {
  const next: SearchProfileFieldsBase = { ...base };
  for (const field of LIST_FIELDS) {
    const edit = changes[field];
    if (!edit) continue;
    const removed = new Set(edit.remove.map(fold));
    const list = base[field].filter((v) => !removed.has(fold(v)));
    for (const v of edit.add.map((a) => a.trim())) if (!list.some((x) => fold(x) === fold(v))) list.push(v);
    next[field] = list;
  }
  if (changes.workModes) next.workModes = [...new Set(changes.workModes)];
  if (changes.seniority) next.seniority = [...new Set(changes.seniority)];
  if (changes.sources) next.sources = [...new Set(changes.sources)];
  if (changes.minSalary) {
    next.minSalary = changes.minSalary.amount;
    if (changes.minSalary.currency) next.currency = changes.minSalary.currency;
  }
  if (changes.maxJobs !== null) next.maxJobs = changes.maxJobs;
  if (changes.fitThreshold !== null) next.fitThreshold = changes.fitThreshold;
  return next;
}

const quoteList = (xs: readonly string[]) => xs.join(", ");

/** One line per real change between `before` and `after`, e.g. "add Đà Nẵng to locations". */
export function describeCriteriaChange(before: SearchProfileFieldsBase, after: SearchProfileFieldsBase): string[] {
  const lines: string[] = [];
  for (const field of LIST_FIELDS) {
    const was = new Set(before[field].map(fold));
    const now = new Set(after[field].map(fold));
    const added = after[field].filter((v) => !was.has(fold(v)));
    const removed = before[field].filter((v) => !now.has(fold(v)));
    if (added.length) lines.push(`add ${quoteList(added)} to ${LIST_LABELS[field]}`);
    if (removed.length) lines.push(`remove ${quoteList(removed)} from ${LIST_LABELS[field]}`);
  }
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));
  if (!same(before.workModes, after.workModes)) lines.push(`work modes: ${quoteList(after.workModes)}`);
  if (!same(before.seniority, after.seniority)) lines.push(`seniority: ${quoteList(after.seniority)}`);
  if (!same(before.sources, after.sources)) lines.push(`sources: ${quoteList(after.sources.map((s) => SOURCE_LABELS[s] ?? s))}`);
  if (before.minSalary !== after.minSalary || (after.minSalary !== null && before.currency !== after.currency)) {
    lines.push(after.minSalary === null ? "no minimum salary" : `minimum salary ${after.minSalary.toLocaleString("en-US")} ${after.currency ?? ""}`.trim());
  }
  if (before.maxJobs !== after.maxJobs) lines.push(`at most ${after.maxJobs} jobs per scan`);
  if (before.fitThreshold !== after.fitThreshold) lines.push(`fit threshold ${after.fitThreshold}`);
  return lines;
}

/** "Add Đà Nẵng to locations; remove PHP from exclude keywords." */
export function criteriaChangeSentence(lines: readonly string[]): string {
  const text = lines.join("; ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

const DOW: Record<NonNullable<ScheduleProposal["day"]>, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The 5-field cron of a proposed schedule (time in the schedule's time zone). */
export function scheduleProposalCron(p: ScheduleProposal): string {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(p.time);
  if (!m) throw new Error(`invalid time ${p.time}; expected HH:MM`);
  const [hh, mm] = [Number(m[1]), Number(m[2])];
  if (p.repeat === "weekly" && !p.day) throw new Error("a weekly schedule needs its day");
  const dow = p.repeat === "weekdays" ? "1-5" : p.repeat === "daily" ? "*" : String(DOW[p.day!]);
  return `${mm} ${hh} * * ${dow}`;
}

/** "Weekdays 09:00", "Daily 18:30", "Weekly on Mon 09:00". */
export function describeScheduleRepeat(p: ScheduleProposal): string {
  if (p.repeat === "weekdays") return `Weekdays ${p.time}`;
  if (p.repeat === "daily") return `Daily ${p.time}`;
  return `Weekly on ${p.day ?? "?"} ${p.time}`;
}
