// Data access for the Search criteria screen (UC-21b, spec §7.5): an adapter over lib/api (the
// orchestrator in live mode, the mock backend otherwise). Shapes are the shared API schemas:
//   GET    /criteria             → CriteriaResponseSchema (the active SearchProfile); 404 → null
//                                   here (no criteria yet: the first save creates v1)
//   PUT    /criteria             → body CriteriaUpdateRequestSchema; a new active version (400 when invalid)
//   GET    /criteria/versions    → CriteriaVersionsResponseSchema
//   GET    /criteria/profiles    → SearchProfilesResponseSchema (the schedule modal's options)
//   GET    /saved-answers        → SavedAnswersResponseSchema (UC-12 "remember this answer")
//   DELETE /saved-answers/:key   → { ok: true }; 404 when there is no such answer
//   GET    /sources/access       → SourceAccessResponseSchema (API research §5.6: each toggle's label)
//   POST   /sources/:source/approval → body { researchedAt }; the board's new view (409 when the
//                                   research changed or it needs no approval)
//   DELETE /sources/:source/approval → the board's new view (Ba revoked his approval)
"use client";

import {
  API_ROUTES,
  CriteriaResponseSchema,
  CriteriaVersionsResponseSchema,
  OkResponseSchema,
  SavedAnswersResponseSchema,
  SearchProfilesResponseSchema,
  SourceAccessResponseSchema,
  SourceAccessViewSchema,
  type CriteriaUpdateRequest,
  type SavedAnswer,
  type SearchProfile,
  type SearchSource,
  type SourceAccessView,
} from "@bs-job-agents/shared";
import { useMemo } from "react";
import type { z } from "zod";
import type { WebApi } from "@/lib/api/contract";
import { isApiError } from "@/lib/api/errors";
import { useApi } from "@/lib/api/react";

export type CriteriaVersions = z.infer<typeof CriteriaVersionsResponseSchema>;

export interface CriteriaData {
  /** The active Search Profile; null when none was saved yet. */
  get(): Promise<SearchProfile | null>;
  /** Saves the fields as a new active version (UC-21b); the server rejects invalid fields. */
  save(fields: CriteriaUpdateRequest): Promise<SearchProfile>;
  /** Version history, newest first. */
  versions(): Promise<CriteriaVersions>;
  /** The newest version of each Search Profile (for schedules). */
  profiles(): Promise<SearchProfile[]>;
  /** Answers Ba told Apply to remember (UC-12), newest first. */
  savedAnswers(): Promise<SavedAnswer[]>;
  deleteAnswer(key: string): Promise<void>;
  /** How each source is read (labels, approval state, the research to show before approving). */
  sourceAccess(): Promise<SourceAccessView[]>;
  /** Ba approves a high-risk board's account API, for the research he read. */
  approveSource(source: SearchSource, researchedAt: string): Promise<SourceAccessView>;
  revokeSource(source: SearchSource): Promise<SourceAccessView>;
}

export function createCriteriaData(api: Pick<WebApi, "request">): CriteriaData {
  return {
    async get() {
      try {
        return await api.request("GET", API_ROUTES.criteria, { schema: CriteriaResponseSchema });
      } catch (err) {
        if (isApiError(err) && err.code === "not_found") return null;
        throw err;
      }
    },
    save(fields) {
      return api.request("PUT", API_ROUTES.criteria, { body: fields, schema: CriteriaResponseSchema });
    },
    async versions() {
      const res = await api.request("GET", API_ROUTES.criteriaVersions, { schema: CriteriaVersionsResponseSchema });
      return { versions: [...res.versions].sort((a, b) => b.version - a.version) };
    },
    async profiles() {
      return (await api.request("GET", API_ROUTES.criteriaProfiles, { schema: SearchProfilesResponseSchema })).profiles;
    },
    async savedAnswers() {
      const { answers } = await api.request("GET", API_ROUTES.savedAnswers, { schema: SavedAnswersResponseSchema });
      return [...answers].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    },
    async deleteAnswer(key) {
      await api.request("DELETE", API_ROUTES.savedAnswer, { params: { key }, schema: OkResponseSchema });
    },
    async sourceAccess() {
      return (await api.request("GET", API_ROUTES.sourceAccess, { schema: SourceAccessResponseSchema })).sources;
    },
    approveSource(source, researchedAt) {
      return api.request("POST", API_ROUTES.sourceApproval, { params: { source }, body: { researchedAt }, schema: SourceAccessViewSchema });
    },
    revokeSource(source) {
      return api.request("DELETE", API_ROUTES.sourceApproval, { params: { source }, schema: SourceAccessViewSchema });
    },
  };
}

export function useCriteriaData(): CriteriaData {
  const api = useApi();
  return useMemo(() => createCriteriaData(api), [api]);
}

/** Everything the screen shows, read in parallel. */
export interface CriteriaRead {
  profile: SearchProfile | null;
  versions: CriteriaVersions["versions"];
  answers: SavedAnswer[];
}

export async function readCriteria(data: CriteriaData): Promise<CriteriaRead> {
  const [profile, versions, answers] = await Promise.all([data.get(), data.versions(), data.savedAnswers()]);
  return { profile, versions: versions.versions, answers };
}
