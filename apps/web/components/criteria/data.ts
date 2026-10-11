// Data access for the Search criteria screen (UC-21b, spec §7.5).
//
// Screens import `criteriaData` from here and nothing else, so wiring the real API is a
// one-line change: replace the fixture implementation below with an adapter over
// lib/api (W3b's typed client). Shapes are the shared API schemas.
//   GET  /criteria           → CriteriaResponseSchema (the active SearchProfile)
//   PUT  /criteria           → body CriteriaUpdateRequestSchema; a new active version
//   GET  /criteria/versions  → CriteriaVersionsResponseSchema
//   GET  /saved-answers      → SavedAnswersResponseSchema (UC-12 "remember this answer")
//   DELETE /saved-answers/:key → { ok: true }; 404 when there is no such answer
import {
  CriteriaUpdateRequestSchema,
  normalizeAnswerKey,
  type CriteriaUpdateRequest,
  type CriteriaVersionsResponseSchema,
  type SavedAnswer,
  type SearchProfile,
} from "@bs-job-agents/shared";
import { FixtureApiError } from "@/components/schedules/apiError";
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
  /** Answers Ba told Apply to remember (UC-12), newest first. */
  savedAnswers(): Promise<SavedAnswer[]>;
  deleteAnswer(key: string): Promise<void>;
}

const SAVED_ANSWERS: Array<Omit<SavedAnswer, "key">> = [
  { label: "Notice period", answer: "2 weeks", updatedAt: "2026-10-09T19:12:00+07:00" },
  { label: "Work permit", answer: "Vietnamese citizen — no work permit needed", updatedAt: "2026-10-10T15:31:00+07:00" },
  { label: "Thời gian có thể bắt đầu làm việc", answer: "2 tuần sau khi nhận offer", updatedAt: "2026-10-11T08:15:00+07:00" },
];

/** In-memory stand-in seeded from the shared fixtures (no orchestrator needed). */
export function createFixtureCriteriaData(seed: SearchProfile = searchProfileFixture, now: () => Date = () => new Date()): CriteriaData {
  let profile: SearchProfile = structuredClone(seed);
  const history: CriteriaVersions["versions"] = [
    { version: 1, updatedAt: "2026-10-08T21:10:00+07:00", active: false },
    { version: 2, updatedAt: "2026-10-09T20:30:00+07:00", active: false },
    { version: profile.version, updatedAt: profile.updatedAt, active: true },
  ].filter((v) => v.version <= profile.version);
  const answers = new Map(SAVED_ANSWERS.map((a) => [normalizeAnswerKey(a.label), { ...a, key: normalizeAnswerKey(a.label) }]));

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
    async savedAnswers() {
      return [...answers.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).map((a) => ({ ...a }));
    },
    async deleteAnswer(key) {
      if (!answers.delete(key)) throw new FixtureApiError(404, "not_found", `there is no saved answer for "${key}"`);
    },
  };
}

export const criteriaData: CriteriaData = createFixtureCriteriaData();
