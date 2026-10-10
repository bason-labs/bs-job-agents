// Shared Zod schemas and TypeScript types for web and orchestrator (spec §4.1).
// Phase 1 (W1a) adds the bot output, event and API schemas here.
import { z } from "zod";

export const PACKAGE_NAME = "@bs-job-agents/shared";

/** Response body of the orchestrator's `GET /health`. */
export const HealthSchema = z.object({ ok: z.literal(true) });
export type Health = z.infer<typeof HealthSchema>;
