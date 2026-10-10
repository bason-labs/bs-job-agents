// Workflow names and their start parameters (§7.2, §7.3, §7.3b).
import { z } from "zod";
import { IdSchema, UrlSchema } from "../common/primitives.js";
import { SearchProfileOverridesSchema } from "../domain/search-profile.js";

/** Phase 1 workflows shipped in workflows/*.yaml. */
export const WORKFLOW_NAMES = ["job-scan", "apply-to-link", "apply-to-file"] as const;
export const WorkflowNameSchema = z.enum(WORKFLOW_NAMES);
export type WorkflowName = z.infer<typeof WorkflowNameSchema>;

/** Slug for any workflow, including ones Ba saves later (rule 3). */
export const WorkflowSlugSchema = z.string().regex(/^[a-z][a-z0-9-]*$/, "workflow names are lowercase slugs");

/** §7.2: searchProfileId defaults to the active profile; any field may be overridden for one run. */
export const JobScanParamsSchema = z
  .object({
    searchProfileId: IdSchema.nullable().default(null),
    overrides: SearchProfileOverridesSchema.nullable().default(null),
    /** UC-04 b: Ba said "show skipped": jobs Ba skipped before are offered again in this run. */
    showSkipped: z.boolean().optional(),
  })
  .strict();
export type JobScanParams = z.infer<typeof JobScanParamsSchema>;

/** §7.3, UC-14: applyAgain overrides the "already applied" stop (§10.2 rule 5). */
export const ApplyToLinkParamsSchema = z
  .object({
    url: UrlSchema,
    applyAgain: z.boolean().default(false),
    searchProfileId: IdSchema.nullable().default(null),
  })
  .strict();
export type ApplyToLinkParams = z.infer<typeof ApplyToLinkParamsSchema>;

/** §7.3b: the uploaded JD file. */
export const ApplyToFileParamsSchema = z
  .object({
    uploadId: IdSchema,
    searchProfileId: IdSchema.nullable().default(null),
  })
  .strict();
export type ApplyToFileParams = z.infer<typeof ApplyToFileParamsSchema>;

export const WORKFLOW_PARAMS_SCHEMAS = {
  "job-scan": JobScanParamsSchema,
  "apply-to-link": ApplyToLinkParamsSchema,
  "apply-to-file": ApplyToFileParamsSchema,
} as const satisfies Record<WorkflowName, z.ZodTypeAny>;

/** `start_workflow` input (orchestrator MCP tool for Lead, and POST /runs). */
export const StartWorkflowInputSchema = z.discriminatedUnion("workflow", [
  z.object({ workflow: z.literal("job-scan"), params: JobScanParamsSchema }).strict(),
  z.object({ workflow: z.literal("apply-to-link"), params: ApplyToLinkParamsSchema }).strict(),
  z.object({ workflow: z.literal("apply-to-file"), params: ApplyToFileParamsSchema }).strict(),
]);
export type StartWorkflowInput = z.infer<typeof StartWorkflowInputSchema>;
