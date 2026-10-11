// Data access for the Schedules screen (UC-21, spec §11 Schedules).
//
// Screens import `schedulesData` from here and nothing else, so wiring the real API is a
// one-line change: replace the fixture implementation below with an adapter over
// lib/api (W3b's typed client). Shapes are the shared API schemas.
//   GET    /schedules             → SchedulesResponseSchema
//   POST   /schedules             → body ScheduleCreateRequestSchema → ScheduleView
//   PATCH  /schedules/:id         → body ScheduleUpdateRequestSchema → ScheduleView
//   DELETE /schedules/:id         → ScheduleDeleteResponseSchema (soft delete, 6 s Undo)
//   POST   /schedules/:id/restore → ScheduleView; 409 { reason: "undo_window_passed" } after 6 s
//   POST   /schedules/:id/run     → ScheduleRunNowResponseSchema (may answer "overlap")
//   GET    /criteria              → the active profile, for the "Search criteria" options
import {
  LIMITS,
  ScheduleCreateRequestSchema,
  ScheduleUpdateRequestSchema,
  type ScheduleCreateRequest,
  type ScheduleDeleteResponseSchema,
  type ScheduleRunNowResponseSchema,
  type ScheduleUpdateRequest,
  type ScheduleView,
} from "@bs-job-agents/shared";
import { scheduleFixture } from "@bs-job-agents/shared/fixtures";
import type { z } from "zod";
import { criteriaData, type CriteriaData } from "@/components/criteria/data";
import { FixtureApiError } from "./apiError";
import { cronToRepeat } from "./logic";

export type ScheduleDeleteResponse = z.infer<typeof ScheduleDeleteResponseSchema>;
export type ScheduleRunNowResponse = z.infer<typeof ScheduleRunNowResponseSchema>;

/** A Search Profile a schedule can use; null = the active one (the default). */
export interface ProfileOption {
  id: string | null;
  label: string;
}

export interface SchedulesData {
  list(): Promise<ScheduleView[]>;
  /** Options for the modal's "Search criteria" select. */
  profiles(): Promise<ProfileOption[]>;
  create(body: ScheduleCreateRequest): Promise<ScheduleView>;
  update(id: string, body: ScheduleUpdateRequest): Promise<ScheduleView>;
  /** Soft delete; `restore` within the undo window brings it back (UC-21). */
  remove(id: string): Promise<ScheduleDeleteResponse>;
  restore(id: string): Promise<ScheduleView>;
  runNow(id: string): Promise<ScheduleRunNowResponse>;
}

const VN_OFFSET_MS = 7 * 60 * 60 * 1000; // Asia/Ho_Chi_Minh has no DST

/** Next fire time of a simple cron (fixture only; the orchestrator uses croner). */
export function fixtureNextRun(cron: string, now: Date): string | null {
  const r = cronToRepeat(cron);
  if (r.freq === "custom") return null;
  const [hh, mm] = r.time.split(":").map(Number) as [number, number];
  const local = new Date(now.getTime() + VN_OFFSET_MS); // wall clock in Vietnam, read with getUTC*
  for (let i = 0; i <= 7; i++) {
    const day = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + i, hh, mm));
    const at = day.getTime() - VN_OFFSET_MS;
    if (at <= now.getTime()) continue;
    const dow = day.getUTCDay();
    const ok = r.freq === "daily" || (r.freq === "weekdays" && dow >= 1 && dow <= 5) || (r.freq === "weekly" && ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dow] === r.day);
    if (ok) return new Date(at).toISOString();
  }
  return null;
}

/** In-memory stand-in seeded from the shared fixtures (no orchestrator needed). */
export function createFixtureSchedulesData(
  opts: { seed?: ScheduleView[]; criteria?: CriteriaData; now?: () => Date } = {},
): SchedulesData {
  const now = opts.now ?? (() => new Date());
  const criteria = opts.criteria ?? criteriaData;
  const rows: ScheduleView[] = structuredClone(
    opts.seed ?? [{ ...scheduleFixture, nextRunAt: "2026-10-12T09:00:00+07:00", lastResult: "Fri 9 Oct · 3 to review" }],
  );
  let nextId = rows.length + 1;
  let nextRun = 14;
  /** Runs started by "Run now" still in progress (a schedule never overlaps its previous run). */
  const running = new Set<string>();

  const find = (id: string) => {
    const row = rows.find((r) => r.id === id);
    if (!row) throw new FixtureApiError(404, "not_found", `schedule ${id} not found`);
    return row;
  };

  return {
    async list() {
      return structuredClone(rows.filter((r) => r.deletedAt === null));
    },
    async profiles() {
      const active = await criteria.get();
      return [{ id: null, label: `${active.name} (v${active.version})` }];
    },
    async create(body) {
      const req = ScheduleCreateRequestSchema.parse(body);
      const row: ScheduleView = {
        id: `sch_${nextId++}`,
        ...req,
        lastRunId: null,
        nextRunAt: req.enabled ? fixtureNextRun(req.cron, now()) : null,
        deletedAt: null,
        lastResult: null,
      };
      rows.push(row);
      return structuredClone(row);
    },
    async update(id, body) {
      const req = ScheduleUpdateRequestSchema.parse(body);
      const row = find(id);
      Object.assign(row, req);
      row.nextRunAt = row.enabled ? fixtureNextRun(row.cron, now()) : null;
      return structuredClone(row);
    },
    async remove(id) {
      const row = find(id);
      const at = now();
      row.deletedAt = at.toISOString();
      return { deletedAt: row.deletedAt, undoUntil: new Date(at.getTime() + LIMITS.scheduleUndoMs).toISOString() };
    },
    async restore(id) {
      const row = find(id);
      if (row.deletedAt === null) throw new FixtureApiError(409, "conflict", `schedule ${id} is not deleted`);
      if (now().getTime() > Date.parse(row.deletedAt) + LIMITS.scheduleUndoMs) {
        rows.splice(rows.indexOf(row), 1); // purged, like the API
        throw new FixtureApiError(409, "conflict", `the 6 s undo window for schedule ${id} has passed`, { reason: "undo_window_passed" });
      }
      row.deletedAt = null;
      row.nextRunAt = row.enabled ? fixtureNextRun(row.cron, now()) : null;
      return structuredClone(row);
    },
    async runNow(id) {
      find(id);
      if (running.has(id)) return { started: false, reason: "overlap" };
      running.add(id);
      return { started: true, runId: `run_${nextRun++}` };
    },
  };
}

export const schedulesData: SchedulesData = createFixtureSchedulesData();
