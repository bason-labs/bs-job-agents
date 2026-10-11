// Data access for the Bots screen and bot settings (§11 Bots, UC-19, §5.3, §5.4): an adapter over
// lib/api (the orchestrator in live mode, the mock backend otherwise). Shapes are the shared API schemas:
//   GET    /bots                              → BotsResponseSchema (BotView[] with demotion, memoryNotes)
//   GET    /bots/:name                        → BotView; 404 → null here
//   PATCH  /bots/:name                        → body BotUpdateRequestSchema (engine, enabled, trustLevel, model,
//                                               acknowledgeRisk) → BotView (figmaGuardOff, engineRiskAcknowledgedAt).
//                                               400 for a model meant for the other engine (live run 1)
//                                               403 for Apply/Lead on Codex (checkBotSafety, whatever acknowledgeRisk
//                                               says) and for a trust level that rises more than one step or above
//                                               the Phase 1 cap; 409 for CV on Codex without acknowledgeRisk: true
//                                               (owner decision 2026-10-11: Ba's opt-in, no Figma guard hook there)
//   DELETE /bots/:name/memory/:noteId         → BotView without the note (PM S14); 404 when it is gone
//   POST   /bots/:name/promotion/dismiss      → BotView; 409 when there is no suggestion (UC-19)
//   GET    /workflow-proposals                → Lead's suggestions (rule 3), newest first
//   POST   /workflow-proposals/:id/approve    → saved as a workflow version; nothing runs (409 when decided)
//   POST   /workflow-proposals/:id/dismiss    → the proposal, dismissed
"use client";

import {
  API_ROUTES,
  BotViewSchema,
  BotsResponseSchema,
  WorkflowProposalApproveResponseSchema,
  WorkflowProposalSchema,
  WorkflowProposalsResponseSchema,
  type BotUpdateRequest,
  type WorkflowProposal,
} from "@bs-job-agents/shared";
import { useMemo } from "react";
import type { WebApi } from "@/lib/api/contract";
import { isApiError } from "@/lib/api/errors";
import { useApi } from "@/lib/api/react";
import type { BotScreenView } from "./logic";

export interface BotsData {
  list(): Promise<BotScreenView[]>;
  get(name: string): Promise<BotScreenView | null>;
  /** Engine switch, enable, or a trust level one step up (promote / restore) or any step down. */
  update(name: string, body: BotUpdateRequest): Promise<BotScreenView>;
  /** Removes one memory note by its id (PM S14: a poisoned note reaches every later prompt). */
  deleteMemoryNote(name: string, noteId: string): Promise<BotScreenView>;
  /** Hides a promotion suggestion (UC-19: Ba accepts or dismisses). */
  dismissPromotion(name: string): Promise<BotScreenView>;
  /** Lead's workflow proposals, newest first (rule 3: nothing runs until Ba approves). */
  proposals(): Promise<WorkflowProposal[]>;
  approveProposal(id: string): Promise<{ proposal: WorkflowProposal; workflow: { name: string; version: number } }>;
  dismissProposal(id: string): Promise<WorkflowProposal>;
}

export function createBotsData(api: Pick<WebApi, "request">): BotsData {
  return {
    async list() {
      return (await api.request("GET", API_ROUTES.bots, { schema: BotsResponseSchema })).bots;
    },
    async get(name) {
      try {
        return await api.request("GET", API_ROUTES.bot, { params: { name }, schema: BotViewSchema });
      } catch (err) {
        if (isApiError(err) && err.code === "not_found") return null;
        throw err;
      }
    },
    update(name, body) {
      return api.request("PATCH", API_ROUTES.bot, { params: { name }, body, schema: BotViewSchema });
    },
    deleteMemoryNote(name, noteId) {
      return api.request("DELETE", API_ROUTES.botMemoryNote, { params: { name, noteId }, schema: BotViewSchema });
    },
    dismissPromotion(name) {
      return api.request("POST", API_ROUTES.botPromotionDismiss, { params: { name }, body: {}, schema: BotViewSchema });
    },
    async proposals() {
      return (await api.request("GET", API_ROUTES.workflowProposals, { schema: WorkflowProposalsResponseSchema })).proposals;
    },
    approveProposal(id) {
      return api.request("POST", API_ROUTES.workflowProposalApprove, { params: { id }, body: {}, schema: WorkflowProposalApproveResponseSchema });
    },
    dismissProposal(id) {
      return api.request("POST", API_ROUTES.workflowProposalDismiss, { params: { id }, body: {}, schema: WorkflowProposalSchema });
    },
  };
}

export function useBotsData(): BotsData {
  const api = useApi();
  return useMemo(() => createBotsData(api), [api]);
}
