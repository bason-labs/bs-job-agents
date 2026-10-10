// Data access for the Search criteria screen (UC-21b, spec §7.5).
//
// Screens import `criteriaData` from here and nothing else, so wiring the real API is a
// one-line change: replace the fixture implementation below with an adapter over
// lib/api (W3b's typed client). Shapes are the shared API schemas.
//   GET  /criteria           → CriteriaResponseSchema (the active SearchProfile)
//   PUT  /criteria           → body CriteriaUpdateRequestSchema; a new active version
//   GET  /criteria/versions  → CriteriaVersionsResponseSchema
import {
  CriteriaUpdateRequestSchema,
  type CriteriaUpdateRequest,
  type CriteriaVersionsResponseSchema,
  type SearchProfile,
} from "@bs-job-agents/shared";
import { searchProfileFixture } from "@bs-job-agents/shared/fixtures";
import type { z } from "zod";

export type CriteriaVersions = z.infer<typeof CriteriaVersionsResponseSchema>;

export interface CriteriaData {
  /** The active Search Profile. */
  get(): Promise<SearchProfile>;
  /** Saves the fields as a new active version (UC-21b); rejects invalid fields. */
  save(fields: CriteriaUpdateRequest): Promise<SearchProfile>;
  /** Version history, newest first. */
  versions(): Promise<CriteriaVersions>;
}

/** In-memory stand-in seeded from the shared fixtures (no orchestrator needed). */
export function createFixtureCriteriaData(seed: SearchProfile = searchProfileFixture, now: () => Date = () => new Date()): CriteriaData {
  let profile: SearchProfile = structuredClone(seed);
  const history: CriteriaVersions["versions"] = [
    { version: 1, updatedAt: "2026-10-08T21:10:00+07:00", active: false },
    { version: 2, updatedAt: "2026-10-09T20:30:00+07:00", active: false },
    { version: profile.version, updatedAt: profile.updatedAt, active: true },
  ].filter((v) => v.version <= profile.version);

  return {
    async get() {
      return structuredClone(profile);
    },
    async save(fields) {
      const parsed = CriteriaUpdateRequestSchema.parse(fields);
      const updatedAt = now().toISOString();
      profile = { ...profile, ...parsed, version: profile.version + 1, updatedAt, active: true };
      for (const v of history) v.active = false;
      history.push({ version: profile.version, updatedAt, active: true });
      return structuredClone(profile);
    },
    async versions() {
      return { versions: [...history].reverse().map((v) => ({ ...v })) };
    },
  };
}

export const criteriaData: CriteriaData = createFixtureCriteriaData();
