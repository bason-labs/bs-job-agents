// Data access for the Schedules screen (UC-21, spec §11 Schedules): an adapter over lib/api (the
// orchestrator in live mode, the mock backend otherwise). Shapes are the shared API schemas:
//   GET    /schedules             → SchedulesResponseSchema
//   POST   /schedules             → 201 body ScheduleCreateRequestSchema → ScheduleView (400 when invalid)
//   PATCH  /schedules/:id         → body ScheduleUpdateRequestSchema → ScheduleView; 404 when gone
//   DELETE /schedules/:id         → ScheduleDeleteResponseSchema (soft delete, 6 s Undo)
//   POST   /schedules/:id/restore → ScheduleView; 409 { reason: "undo_window_passed" } after 6 s
//   POST   /schedules/:id/run     → ScheduleRunNowResponseSchema (may answer "overlap")
//   GET    /criteria/profiles     → the "Search criteria" options (null = the active profile)
"use client";

import {
  API_ROUTES,
  ScheduleDeleteResponseSchema,
  ScheduleRunNowResponseSchema,
  ScheduleViewSchema,
  SchedulesResponseSchema,
  type ScheduleCreateRequest,
  type ScheduleUpdateRequest,
  type ScheduleView,
  type SearchProfile,
} from "@bs-job-agents/shared";
import { useMemo } from "react";
import type { z } from "zod";
import { createCriteriaData } from "@/components/criteria/data";
import type { WebApi } from "@/lib/api/contract";
import { useApi } from "@/lib/api/react";

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

/**
 * The modal's options: the active profile (null: a schedule follows whatever version is active when
 * it fires) first, then every other profile pinned to its newest version.
 */
export function profileOptions(profiles: readonly SearchProfile[]): ProfileOption[] {
  const active = profiles.find((p) => p.active);
  const options: ProfileOption[] = [{ id: null, label: active ? `${active.name} (v${active.version})` : "Active criteria" }];
  for (const p of profiles) if (p.name !== active?.name) options.push({ id: p.id, label: `${p.name} (v${p.version})` });
  return options;
}

export function createSchedulesData(api: Pick<WebApi, "request">): SchedulesData {
  const criteria = createCriteriaData(api);
  return {
    async list() {
      return (await api.request("GET", API_ROUTES.schedules, { schema: SchedulesResponseSchema })).schedules;
    },
    async profiles() {
      return profileOptions(await criteria.profiles());
    },
    create(body) {
      return api.request("POST", API_ROUTES.schedules, { body, schema: ScheduleViewSchema });
    },
    update(id, body) {
      return api.request("PATCH", API_ROUTES.schedule, { params: { id }, body, schema: ScheduleViewSchema });
    },
    remove(id) {
      return api.request("DELETE", API_ROUTES.schedule, { params: { id }, schema: ScheduleDeleteResponseSchema });
    },
    restore(id) {
      return api.request("POST", API_ROUTES.scheduleRestore, { params: { id }, body: {}, schema: ScheduleViewSchema });
    },
    runNow(id) {
      return api.request("POST", API_ROUTES.scheduleRunNow, { params: { id }, body: {}, schema: ScheduleRunNowResponseSchema });
    },
  };
}

export function useSchedulesData(): SchedulesData {
  const api = useApi();
  return useMemo(() => createSchedulesData(api), [api]);
}

export async function readSchedules(data: SchedulesData): Promise<{ schedules: ScheduleView[]; profiles: ProfileOption[] }> {
  const [schedules, profiles] = await Promise.all([data.list(), data.profiles()]);
  return { schedules, profiles };
}
