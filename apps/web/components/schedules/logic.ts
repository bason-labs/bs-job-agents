// Schedules screen logic (UC-21, spec §11 Schedules modal editor). Pure, so the modal,
// the rows and the tests share one definition of "Repeat" ↔ cron.
import {
  DEFAULT_SCHEDULE_CRON,
  DEFAULT_TIMEZONE,
  WEEKDAYS,
  isValidCron,
  repeatToCron,
  type ScheduleCreateRequest,
  type ScheduleRepeat,
  type ScheduleUpdateRequest,
  type ScheduleView,
} from "@bs-job-agents/shared";
import { formatDayTime } from "./datetime";

export type RepeatFreq = ScheduleRepeat["freq"];
export type Weekday = (typeof WEEKDAYS)[number];

/** Repeat options in the modal (prototype order). */
export const REPEAT_OPTIONS: readonly { value: RepeatFreq; label: string }[] = [
  { value: "weekdays", label: "Weekdays" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "custom", label: "Custom" },
];

/** Day select options, Monday first (prototype). */
export const DAY_OPTIONS: readonly { value: Weekday; label: string }[] = (["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const).map(
  (d) => ({ value: d, label: d }),
);

export interface ScheduleForm {
  name: string;
  freq: RepeatFreq;
  /** HH:MM, a 30-minute slot (TimePicker). */
  time: string;
  day: Weekday;
  /** Only used when freq = custom. */
  cron: string;
  /** null = the active Search Profile. */
  searchProfileId: string | null;
  enabled: boolean;
}

/** Spec §15.2 default: weekdays 09:00 Asia/Ho_Chi_Minh. */
export function newScheduleForm(): ScheduleForm {
  return { name: "", freq: "weekdays", time: "09:00", day: "Mon", cron: DEFAULT_SCHEDULE_CRON, searchProfileId: null, enabled: true };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The modal's Repeat fields for a stored cron; anything else is Custom. */
export function cronToRepeat(cron: string): Pick<ScheduleForm, "freq" | "time" | "day" | "cron"> {
  const fallback = { freq: "custom" as const, time: "09:00", day: "Mon" as Weekday, cron };
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return fallback;
  const [min, hour, dom, month, dow] = parts as [string, string, string, string, string];
  if (!/^\d{1,2}$/.test(min) || !/^\d{1,2}$/.test(hour) || dom !== "*" || month !== "*") return fallback;
  const m = Number(min);
  const h = Number(hour);
  if (h > 23 || (m !== 0 && m !== 30)) return fallback; // the TimePicker has 30-minute slots
  const time = `${pad(h)}:${pad(m)}`;
  if (dow === "1-5") return { freq: "weekdays", time, day: "Mon", cron };
  if (dow === "*") return { freq: "daily", time, day: "Mon", cron };
  if (/^[0-7]$/.test(dow)) return { freq: "weekly", time, day: WEEKDAYS[Number(dow) % 7]!, cron };
  return fallback;
}

export function scheduleToForm(s: Pick<ScheduleView, "name" | "cron" | "searchProfileId" | "enabled">): ScheduleForm {
  return { name: s.name, ...cronToRepeat(s.cron), searchProfileId: s.searchProfileId, enabled: s.enabled };
}

function toRepeat(form: ScheduleForm): ScheduleRepeat {
  switch (form.freq) {
    case "weekly":
      return { freq: "weekly", time: form.time, day: form.day };
    case "custom":
      return { freq: "custom", time: form.time, cron: form.cron.trim() };
    default:
      return { freq: form.freq, time: form.time };
  }
}

export function formToCron(form: ScheduleForm): string {
  return repeatToCron(toRepeat(form));
}

/** "Weekdays 09:00", "Daily 18:30", "Every Wed 07:00", "cron: 15 9 * * 1-5" (prototype schedLabel). */
export function repeatLabel(form: Pick<ScheduleForm, "freq" | "time" | "day" | "cron">): string {
  switch (form.freq) {
    case "weekdays":
      return `Weekdays ${form.time}`;
    case "daily":
      return `Daily ${form.time}`;
    case "weekly":
      return `Every ${form.day} ${form.time}`;
    case "custom":
      return `cron: ${form.cron.trim()}`;
  }
}

export function cronLabel(cron: string): string {
  return repeatLabel(cronToRepeat(cron));
}

/** Row line: "Weekdays 09:00 · criteria Default (v3) · next: Mon 12 Oct, 09:00 · last: …". */
export function scheduleSummary(s: Pick<ScheduleView, "cron" | "enabled" | "nextRunAt" | "lastResult">, profileLabel: string): string {
  const next = s.enabled ? formatDayTime(s.nextRunAt) : "off";
  return `${cronLabel(s.cron)} · criteria ${profileLabel} · next: ${next} · last: ${s.lastResult ?? "—"}`;
}

export type ScheduleFormErrors = Partial<Record<"name" | "cron", string>>;

/** Spec §11: name required; a custom cron must have 5 fields (prototype copy). */
export function validateScheduleForm(form: ScheduleForm): ScheduleFormErrors {
  const errors: ScheduleFormErrors = {};
  if (!form.name.trim()) errors.name = "Give the schedule a name";
  if (form.freq === "custom" && !isValidCron(form.cron)) errors.cron = "Cron needs 5 fields, e.g. 0 9 * * 1-5";
  return errors;
}

export function formToCreateRequest(form: ScheduleForm): ScheduleCreateRequest {
  return {
    name: form.name.trim(),
    cron: formToCron(form),
    timezone: DEFAULT_TIMEZONE,
    workflowName: "job-scan",
    searchProfileId: form.searchProfileId,
    params: {},
    enabled: form.enabled,
  };
}

export function formToUpdateRequest(form: ScheduleForm): ScheduleUpdateRequest {
  return { name: form.name.trim(), cron: formToCron(form), searchProfileId: form.searchProfileId, enabled: form.enabled };
}
