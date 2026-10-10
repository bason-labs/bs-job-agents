// Search criteria (UC-21b). Saving creates a new active profile version.
import { z } from "zod";
import { IsoDateTimeSchema } from "../common/primitives.js";
import { SearchProfileFieldsSchema, SearchProfileSchema } from "../domain/search-profile.js";

export const CriteriaUpdateRequestSchema = SearchProfileFieldsSchema;
export type CriteriaUpdateRequest = z.infer<typeof CriteriaUpdateRequestSchema>;

export const CriteriaResponseSchema = SearchProfileSchema;

export const CriteriaVersionsResponseSchema = z.object({
  versions: z.array(z.object({ version: z.number().int().positive(), updatedAt: IsoDateTimeSchema, active: z.boolean() })),
});
