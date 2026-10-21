// Data access for the CV guidance and Activity screens (§7): an adapter over lib/api (the
// orchestrator in live mode, the mock backend otherwise).
//   GET  /guidance                  → GuidanceViewSchema: the rule set, its sources and the last refresh
//   POST /guidance/rules/:id/off    → GuidanceViewSchema: Ba turns a rule off for his CVs (§5.9)
//   POST /guidance/rules/:id/on     → GuidanceViewSchema
//   GET  /activity                  → ActivityResponseSchema: rule added / rule changed, newest first
"use client";

import { API_ROUTES, ActivityResponseSchema, GuidanceViewSchema, type ActivityEntry, type GuidanceView } from "@bs-job-agents/shared";
import { useMemo } from "react";
import type { WebApi } from "@/lib/api/contract";
import { useApi } from "@/lib/api/react";

export interface GuidanceData {
  view(): Promise<GuidanceView>;
  setOff(ruleId: string, off: boolean): Promise<GuidanceView>;
  activity(): Promise<ActivityEntry[]>;
}

export function createGuidanceData(api: Pick<WebApi, "request">): GuidanceData {
  return {
    view() {
      return api.request("GET", API_ROUTES.guidance, { schema: GuidanceViewSchema });
    },
    setOff(ruleId, off) {
      return off
        ? api.request("POST", API_ROUTES.guidanceRuleOff, { params: { id: ruleId }, body: {}, schema: GuidanceViewSchema })
        : api.request("POST", API_ROUTES.guidanceRuleOn, { params: { id: ruleId }, body: {}, schema: GuidanceViewSchema });
    },
    async activity() {
      return (await api.request("GET", API_ROUTES.activity, { schema: ActivityResponseSchema })).entries;
    },
  };
}

export function useGuidanceData(): GuidanceData {
  const api = useApi();
  return useMemo(() => createGuidanceData(api), [api]);
}
