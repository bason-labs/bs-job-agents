// Saved form answers (UC-12, §9 `saved_answers`).
import { z } from "zod";
import { IsoDateTimeSchema } from "../common/primitives.js";

/**
 * key = normalised label: NFC, lowercase, single spaces, trimmed, without trailing
 * `*`, `:`, `：` (full-width) or `?`; diacritics kept. The one implementation used by
 * the API and the `saved_answers` repository, so lookups and stored keys agree.
 */
export function normalizeAnswerKey(label: string): string {
  return label
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\s*:：?]+$/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

export const SavedAnswerSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  answer: z.string(),
  updatedAt: IsoDateTimeSchema,
});
export type SavedAnswer = z.infer<typeof SavedAnswerSchema>;
