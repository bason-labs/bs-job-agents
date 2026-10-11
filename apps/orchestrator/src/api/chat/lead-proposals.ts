// PM3 M3 (UC-21b a) and S1 (UC-21 "by telling Lead"): Lead proposes, Ba's click is the consent.
// Lead has no tool that saves criteria or creates a schedule (rule 5: six tools). Its structured
// output may carry `propose_criteria_change` / `propose_schedule`; the sink checks each proposal
// with the same rules as PUT /criteria and POST /schedules, stores it in data/api-state.json and
// posts a choice card whose text the orchestrator computes from the stored data:
//   criteria-save:<id>     Just this run | Save to my criteria
//   schedule-create:<id>   Not now | Create schedule
// POST /chat/choices then acts on the stored proposal only (single use): it never trusts Lead's
// wording, a key or a payload sent at click time. A proposal that fails the rules gets a short
// system note instead of a card.
import { randomBytes } from "node:crypto";
import {
  CRITERIA_SAVE_KEY_PREFIX,
  CRITERIA_SAVE_OPTIONS,
  DEFAULT_TIMEZONE,
  SCHEDULE_CREATE_KEY_PREFIX,
  SCHEDULE_CREATE_OPTIONS,
  SEARCH_PROFILE_DEFAULTS,
  SearchProfileFieldsSchema,
  applyCriteriaChanges,
  criteriaChangeSentence,
  describeCriteriaChange,
  describeScheduleRepeat,
  scheduleProposalCron,
  type CriteriaChanges,
  type LeadAction,
  type ScheduleProposal,
  type SearchProfileFields,
  type SearchProfileFieldsBase,
} from "@bs-job-agents/shared";
import { createSchedule, createSearchProfile, getActiveSearchProfile, getSchedule, mappers, updateSearchProfile, type Conn, type Room, type Schedule, type SearchProfile } from "../../db/index.js";
import type { WorkflowSource } from "../../engine/index.js";
import { ApiHttpError, conflict, notFound } from "../errors.js";
import { validateScheduleFields, type ScheduleFields } from "../routes/schedules.js";
import { readApiState, updateApiState, type StoredProposal } from "../state.js";
import { postMessage } from "./messages.js";

/** Settled proposals older than this are dropped when a new one is stored. */
const KEEP_SETTLED_MS = 30 * 24 * 3600_000;
const KEEP_MAX = 500;

const KEY_RE = /^(criteria-save|schedule-create):([A-Za-z0-9_-]{12,64})$/;

export interface ProposalKey {
  kind: StoredProposal["kind"];
  id: string;
}

/** `criteria-save:<id>` / `schedule-create:<id>` → the stored proposal's kind and id; else null. */
export function parseProposalKey(key: string): ProposalKey | null {
  const m = KEY_RE.exec(key);
  if (!m) return null;
  return { kind: m[1] === "criteria-save" ? "criteria" : "schedule", id: m[2]! };
}

function profileFields(row: SearchProfile): SearchProfileFieldsBase {
  const { id: _id, name: _name, version: _version, active: _active, updatedAt: _updatedAt, ...fields } = mappers.toSearchProfile(row);
  return fields;
}

/** The fields a criteria proposal applies to: the active profile, or §7.5's defaults before the first save. */
function currentFields(conn: Conn): { fields: SearchProfileFieldsBase; version: number | null } {
  const active = getActiveSearchProfile(conn);
  if (active) return { fields: profileFields(active), version: active.version };
  return {
    fields: {
      ...SEARCH_PROFILE_DEFAULTS,
      workModes: [...SEARCH_PROFILE_DEFAULTS.workModes],
      seniority: [...SEARCH_PROFILE_DEFAULTS.seniority],
      sources: [...SEARCH_PROFILE_DEFAULTS.sources],
      includeKeywords: [],
      excludeKeywords: [],
      excludeCompanies: [],
      companyTypes: [],
      languages: [...SEARCH_PROFILE_DEFAULTS.languages],
      roles: [],
      locations: [],
    },
    version: null,
  };
}

type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

/** The new profile fields, checked like PUT /criteria (UC-21b b); `lines` describe the change. */
export function checkCriteriaChange(conn: Conn, changes: CriteriaChanges): Checked<{ fields: SearchProfileFields; lines: string[]; version: number | null }> {
  const { fields, version } = currentFields(conn);
  const next = applyCriteriaChanges(fields, changes);
  const lines = describeCriteriaChange(fields, next);
  if (lines.length === 0) return { ok: false, reason: "it changes nothing" };
  const parsed = SearchProfileFieldsSchema.safeParse(next);
  if (!parsed.success) return { ok: false, reason: parsed.error.issues.map((i) => i.message).join("; ") };
  return { ok: true, value: { fields: parsed.data, lines, version } };
}

const fieldsOfSchedule = (p: ScheduleProposal): ScheduleFields => ({
  cron: scheduleProposalCron(p),
  timezone: DEFAULT_TIMEZONE,
  workflowName: "job-scan",
  searchProfileId: p.searchProfileId === null ? null : /^[1-9]\d{0,15}$/.test(p.searchProfileId) ? Number(p.searchProfileId) : -1,
  params: {},
  enabled: true,
});

/** The schedule's fields and next run, checked like POST /schedules (UC-21, §7.4). */
export function checkScheduleProposal(conn: Conn, workflows: WorkflowSource | null, p: ScheduleProposal, now: Date): Checked<{ fields: ScheduleFields; nextRunAt: string | null }> {
  try {
    const fields = fieldsOfSchedule(p);
    if (fields.searchProfileId === -1) return { ok: false, reason: `searchProfileId: ${p.searchProfileId} is not a valid id` };
    return { ok: true, value: { fields, nextRunAt: validateScheduleFields(conn, workflows, fields, now) } };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** "Mon 13 Oct, 09:00" in the schedule's time zone. */
export function formatRunTime(iso: string, timeZone: string = DEFAULT_TIMEZONE): string {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone }).format(d).replace(/,/g, "");
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone }).format(d);
  return `${day}, ${time}`;
}

function store(dataDir: string, proposal: StoredProposal, now: Date): string {
  const id = randomBytes(12).toString("base64url");
  updateApiState(dataDir, (s) => {
    const kept = Object.entries(s.leadProposals)
      .filter(([, p]) => p.settledAt === null || now.getTime() - Date.parse(p.settledAt) < KEEP_SETTLED_MS)
      .slice(-(KEEP_MAX - 1));
    return { ...s, leadProposals: { ...Object.fromEntries(kept), [id]: proposal } };
  });
  return id;
}

export interface ProposalContext {
  conn: Conn;
  room: Room;
  taskId: number;
  dataDir: string;
  workflows: WorkflowSource | null;
  now: Date;
}

/** One proposal from Lead's output: a card for Ba, or a note why there is none. Inside the sink's transaction. */
export function postLeadProposal(ctx: ProposalContext, action: Extract<LeadAction, { type: "propose_criteria_change" | "propose_schedule" }>): void {
  const meta = { taskId: ctx.taskId, createdAt: ctx.now.toISOString(), settledAt: null, outcome: null };
  if (action.type === "propose_criteria_change") {
    const checked = checkCriteriaChange(ctx.conn, action.changes);
    if (!checked.ok) {
      if (checked.reason !== "it changes nothing") {
        postMessage(ctx.conn, { room: ctx.room, author: "system", text: `Lead suggested a change to your search criteria that can't be saved: ${checked.reason}.` }, ctx.now);
      }
      return;
    }
    const id = store(ctx.dataDir, { kind: "criteria", changes: action.changes, ...meta }, ctx.now);
    const version = checked.value.version === null ? "" : ` (now v${checked.value.version})`;
    postMessage(
      ctx.conn,
      {
        room: ctx.room,
        author: "lead",
        text: `Save to your search criteria${version}? ${criteriaChangeSentence(checked.value.lines)}`,
        cards: [{ type: "choice", key: `${CRITERIA_SAVE_KEY_PREFIX}${id}`, options: CRITERIA_SAVE_OPTIONS.map((o) => ({ ...o })), chosen: null }],
      },
      ctx.now,
    );
    return;
  }
  const p = action.schedule;
  const checked = checkScheduleProposal(ctx.conn, ctx.workflows, p, ctx.now);
  if (!checked.ok) {
    postMessage(ctx.conn, { room: ctx.room, author: "system", text: `Lead suggested a schedule that can't be created: ${checked.reason}.` }, ctx.now);
    return;
  }
  const id = store(ctx.dataDir, { kind: "schedule", schedule: p, ...meta }, ctx.now);
  const next = checked.value.nextRunAt ? ` · next run ${formatRunTime(checked.value.nextRunAt)}` : "";
  const criteria = p.searchProfileId === null ? "your active search criteria" : `search profile ${p.searchProfileId}`;
  postMessage(
    ctx.conn,
    {
      room: ctx.room,
      author: "lead",
      text: `Create the schedule “${p.name}”? Runs: ${describeScheduleRepeat(p)}${next} · job scan with ${criteria}.`,
      cards: [{ type: "choice", key: `${SCHEDULE_CREATE_KEY_PREFIX}${id}`, options: SCHEDULE_CREATE_OPTIONS.map((o) => ({ ...o })), chosen: null }],
    },
    ctx.now,
  );
}

/** The stored, unsettled proposal behind a card key (404 unknown, 409 already used). */
export function pendingProposal(dataDir: string, key: ProposalKey): StoredProposal {
  const p = readApiState(dataDir).leadProposals[key.id];
  if (!p || p.kind !== key.kind) throw notFound("this proposal is not known (it may have expired)");
  if (p.settledAt !== null) throw conflict("this choice was already made");
  return p;
}

export function settleProposal(dataDir: string, id: string, outcome: string, now: Date): void {
  updateApiState(dataDir, (s) => {
    const p = s.leadProposals[id];
    return p ? { ...s, leadProposals: { ...s.leadProposals, [id]: { ...p, settledAt: now.toISOString(), outcome } } } : s;
  });
}

/** Ba clicked "Save to my criteria": a new active profile version from the stored change. */
export function saveProposedCriteria(conn: Conn, p: Extract<StoredProposal, { kind: "criteria" }>, now: Date): SearchProfile {
  const checked = checkCriteriaChange(conn, p.changes);
  if (!checked.ok) throw conflict(`the proposed change can't be saved now: ${checked.reason}`);
  return getActiveSearchProfile(conn) ? updateSearchProfile(conn, checked.value.fields, { now }) : createSearchProfile(conn, checked.value.fields, { now });
}

/** Ba clicked "Create schedule": the schedule from the stored proposal (§7.4). */
export function createProposedSchedule(conn: Conn, workflows: WorkflowSource | null, p: Extract<StoredProposal, { kind: "schedule" }>, now: Date): Schedule {
  const checked = checkScheduleProposal(conn, workflows, p.schedule, now);
  if (!checked.ok) throw new ApiHttpError(409, "conflict", `the proposed schedule can't be created now: ${checked.reason}`);
  const row = createSchedule(conn, { name: p.schedule.name, ...checked.value.fields, nextRunAt: checked.value.nextRunAt }, { now });
  return getSchedule(conn, row.id) ?? row;
}
