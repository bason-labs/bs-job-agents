// PM3 M3 / S1 in the mock orchestrator, like the orchestrator's api/chat/lead-proposals.ts: Lead
// proposes a criteria change or a schedule, the backend stores it and posts a card it words
// itself (criteria-save:<id> / schedule-create:<id>), and Ba's click acts on the stored proposal
// once. "Save to my criteria" saves without Lead; "Just this run" goes back to Lead.
import {
  CRITERIA_SAVE_KEY_PREFIX,
  CRITERIA_SAVE_OPTIONS,
  DEFAULT_TIMEZONE,
  SCHEDULE_CREATE_KEY_PREFIX,
  SCHEDULE_CREATE_OPTIONS,
  SearchProfileFieldsSchema,
  applyCriteriaChanges,
  criteriaChangeSentence,
  describeCriteriaChange,
  describeScheduleRepeat,
  scheduleProposalCron,
  type CriteriaChanges,
  type Message,
  type MessageCard,
  type ScheduleProposal,
  type ScheduleView,
  type SearchProfileFields,
} from "@bs-job-agents/shared";
import { ApiRequestError } from "../errors";
import type { MockBackend } from "./backend";
import { activeProfile, saveCriteria } from "./criteria";
import { mockNextRunAt } from "./routes";
import { LEAD_ROOM_ID } from "./seed";

export type MockLeadProposal = ({ kind: "criteria"; changes: CriteriaChanges } | { kind: "schedule"; schedule: ScheduleProposal }) & { settled: boolean };

const LEAD = { type: "bot", bot: "lead" } as const;
const KEY_RE = /^(criteria-save|schedule-create):([A-Za-z0-9_-]{12,64})$/;

const fail = (status: number, code: ApiRequestError["code"], message: string) => new ApiRequestError({ status, code, message });

export const NO_CRITERIA_CHANGE: CriteriaChanges = {
  roles: null,
  locations: null,
  includeKeywords: null,
  excludeKeywords: null,
  excludeCompanies: null,
  companyTypes: null,
  workModes: null,
  seniority: null,
  sources: null,
  minSalary: null,
  maxJobs: null,
  fitThreshold: null,
};

function store(core: MockBackend, proposal: MockLeadProposal): string {
  const id = `p${core.nextId()}${Math.random().toString(36).slice(2, 12)}`.padEnd(12, "0");
  (core.state.leadProposals ??= {})[id] = proposal;
  return id;
}

function profileFields(core: MockBackend): SearchProfileFields | null {
  const active = activeProfile(core);
  if (!active) return null;
  const { id: _id, name: _name, version: _version, active: _active, updatedAt: _updatedAt, ...fields } = active;
  return fields;
}

function checkCriteria(core: MockBackend, changes: CriteriaChanges): { fields: SearchProfileFields; lines: string[] } | string {
  const base = profileFields(core);
  if (!base) return "there are no search criteria yet";
  const next = applyCriteriaChanges(base, changes);
  const lines = describeCriteriaChange(base, next);
  if (lines.length === 0) return "it changes nothing";
  const parsed = SearchProfileFieldsSchema.safeParse(next);
  return parsed.success ? { fields: parsed.data, lines } : parsed.error.issues.map((i) => i.message).join("; ");
}

/** Lead proposed a criteria change: a card, or a note why it can't be saved. */
export async function proposeCriteria(core: MockBackend, changes: CriteriaChanges): Promise<void> {
  const checked = checkCriteria(core, changes);
  if (typeof checked === "string") {
    if (checked !== "it changes nothing") await core.post(LEAD_ROOM_ID, { type: "system" }, `Lead suggested a change to your search criteria that can't be saved: ${checked}.`);
    return;
  }
  const id = store(core, { kind: "criteria", changes, settled: false });
  await core.post(LEAD_ROOM_ID, LEAD, `Save to your search criteria (now v${core.state.criteriaVersion})? ${criteriaChangeSentence(checked.lines)}`, {
    cards: [{ type: "choice", key: `${CRITERIA_SAVE_KEY_PREFIX}${id}`, options: CRITERIA_SAVE_OPTIONS.map((o) => ({ ...o })), chosen: null }],
  });
}

/** "Mon 13 Oct, 09:00" in Vietnam time. */
function runTime(iso: string): string {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: DEFAULT_TIMEZONE }).format(d).replace(/,/g, "");
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: DEFAULT_TIMEZONE }).format(d);
  return `${day}, ${time}`;
}

/** Lead proposed a schedule: a card with the summary and next run. */
export async function proposeSchedule(core: MockBackend, schedule: ScheduleProposal): Promise<void> {
  if (schedule.searchProfileId !== null && !core.state.profiles.some((p) => p.id === schedule.searchProfileId)) {
    await core.post(LEAD_ROOM_ID, { type: "system" }, `Lead suggested a schedule that can't be created: searchProfileId: search profile ${schedule.searchProfileId} not found.`);
    return;
  }
  const id = store(core, { kind: "schedule", schedule, settled: false });
  const next = mockNextRunAt(scheduleProposalCron(schedule), new Date(core.nowMs()));
  const criteria = schedule.searchProfileId === null ? "your active search criteria" : `search profile ${schedule.searchProfileId}`;
  await core.post(LEAD_ROOM_ID, LEAD, `Create the schedule “${schedule.name}”? Runs: ${describeScheduleRepeat(schedule)}${next ? ` · next run ${runTime(next)}` : ""} · job scan with ${criteria}.`, {
    cards: [{ type: "choice", key: `${SCHEDULE_CREATE_KEY_PREFIX}${id}`, options: SCHEDULE_CREATE_OPTIONS.map((o) => ({ ...o })), chosen: null }],
  });
}

/**
 * Ba clicked a proposal card's option. Returns Ba's answer message, or null for "Just this run"
 * (the caller settles the card and sends the label to Lead as usual). Not a proposal key → undefined.
 */
export async function chooseProposal(core: MockBackend, message: Message, card: Extract<MessageCard, { type: "choice" }>, optionId: string): Promise<Message | null | undefined> {
  const m = KEY_RE.exec(card.key);
  if (!m) return undefined;
  const proposal = core.state.leadProposals?.[m[2]!];
  if (!proposal || proposal.kind !== (m[1] === "criteria-save" ? "criteria" : "schedule")) throw fail(404, "not_found", "this proposal is not known (it may have expired)");
  if (proposal.settled) throw fail(409, "conflict", "this choice was already made");
  if (proposal.kind === "criteria" && optionId === "just_this_run") {
    proposal.settled = true;
    return null;
  }
  let note: string;
  if (proposal.kind === "criteria") {
    const checked = checkCriteria(core, proposal.changes);
    if (typeof checked === "string") throw fail(409, "conflict", `the proposed change can't be saved now: ${checked}`);
    const saved = saveCriteria(core, checked.fields);
    note = `Saved to your search criteria (now v${saved.version}).`;
  } else if (optionId === "create") {
    const s = proposal.schedule;
    const cron = scheduleProposalCron(s);
    const row: ScheduleView = {
      id: core.nextId(),
      name: s.name,
      cron,
      timezone: DEFAULT_TIMEZONE,
      workflowName: "job-scan",
      searchProfileId: s.searchProfileId,
      params: {},
      enabled: true,
      lastRunId: null,
      nextRunAt: mockNextRunAt(cron, new Date(core.nowMs())),
      deletedAt: null,
      lastResult: null,
    };
    core.state.schedules.push(row);
    note = `Created the schedule “${row.name}” (${describeScheduleRepeat(s)}).${row.nextRunAt ? ` Next run: ${runTime(row.nextRunAt)}.` : ""}`;
  } else {
    note = "OK, no schedule was created.";
  }
  proposal.settled = true;
  card.chosen = optionId;
  const label = card.options.find((o) => o.id === optionId)!.label;
  const answer = await core.post(message.roomId, { type: "ba" }, label);
  await core.post(message.roomId, LEAD, note);
  return answer;
}
