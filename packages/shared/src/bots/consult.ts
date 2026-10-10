// Consult mode (UC-25) and room discussion mode (UC-15): any bot answers within its
// role and memory, never doing work. Work requests are handed to Lead.
import { z } from "zod";
import { botEnvelopeShape } from "./self-check.js";

export const ConsultOutputSchema = z.strictObject({
  reply: z.string().min(1),
  handoffToLead: z
    .strictObject({
      request: z.string().min(1).describe("The work request, restated for Lead"),
    })
    .nullable()
    .describe("Set when the message asks for work (find/apply/tailor/update…)"),
  ...botEnvelopeShape,
});
export type ConsultOutput = z.infer<typeof ConsultOutputSchema>;
