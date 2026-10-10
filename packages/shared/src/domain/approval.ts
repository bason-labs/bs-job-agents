// Approval token (UC-08, §10.2 rules 1–2): single use, bound to job + CV version + domains, 24 h.
import { z } from "zod";
import { DomainSchema, IdSchema, IsoDateTimeSchema } from "../common/primitives.js";

export const ApprovalTokenSchema = z.object({
  token: z.string().min(1),
  /**
   * The one application this token authorises (PM M2): created together with it (UC-08), or
   * issued again for it when Ba re-approves after expiry. Null only for tokens issued before
   * tokens were bound to applications; those can no longer start or resume Apply.
   */
  applicationId: IdSchema.nullable().default(null),
  jobId: IdSchema,
  cvVersionId: IdSchema,
  /** Domains Apply may act on; Ba may add an ATS domain mid-apply (UC-11 e). */
  allowedDomains: z.array(DomainSchema).min(1),
  createdAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema,
  usedAt: IsoDateTimeSchema.nullable(),
});
export type ApprovalToken = z.infer<typeof ApprovalTokenSchema>;
