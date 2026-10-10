// Exports (UC-13b, §9 `exports`).
import { z } from "zod";
import { IdSchema, IsoDateTimeSchema } from "../common/primitives.js";

export const ExportSchema = z.object({
  id: IdSchema,
  createdAt: IsoDateTimeSchema,
  path: z.string().min(1),
  applicationCount: z.number().int().nonnegative(),
});
export type Export = z.infer<typeof ExportSchema>;

/** Layout of the ZIP (UC-13b). */
export const EXPORT_LAYOUT = {
  csv: "applications.csv",
  /** One folder per application containing these files when captured. */
  perApplication: ["submission.json", "<uploaded CV>.pdf", "jd.txt", "jd.png", "pre-submit.png", "confirmation.png"],
} as const;
