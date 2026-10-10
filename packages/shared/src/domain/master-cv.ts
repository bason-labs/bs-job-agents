// Master CV data (§6.1, `data/master-cv.yaml`, UC-20). Owned by Ba; bots only read it.
import { z } from "zod";

export const FactTypeSchema = z.enum(["experience", "project", "skill", "education", "metric"]);
export type FactType = z.infer<typeof FactTypeSchema>;

export const FactSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "fact ids are lowercase slugs such as grad-1"),
  type: FactTypeSchema,
  text: z.string().min(1),
  /** Vietnamese wording when it exists. */
  textVi: z.string().min(1).nullable().default(null),
  tags: z.array(z.string()).default([]),
  org: z.string().nullable().default(null),
  dates: z.string().nullable().default(null),
});
export type Fact = z.infer<typeof FactSchema>;

export const MasterCvSchema = z
  .object({
    /** Bumped on every save (UC-20). */
    version: z.number().int().positive(),
    contact: z.object({
      name: z.string().min(1),
      email: z.string().email(),
      phone: z.string().nullable().default(null),
      location: z.string().nullable().default(null),
      links: z.array(z.string().url()).default([]),
    }),
    headlineOptions: z.array(z.object({ en: z.string().min(1), vi: z.string().nullable().default(null) })).default([]),
    facts: z.array(FactSchema),
  })
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    v.facts.forEach((f, i) => {
      if (seen.has(f.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["facts", i, "id"], message: `duplicate fact id ${f.id}` });
      }
      seen.add(f.id);
    });
  });
export type MasterCv = z.infer<typeof MasterCvSchema>;
export type MasterCvInput = z.input<typeof MasterCvSchema>;
