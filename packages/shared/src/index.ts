// @bs-job-agents/shared: Zod schemas and TypeScript types shared by web and orchestrator
// (spec §4.1): bot definitions and outputs (§5), domain records (§9), workflows (§7),
// SSE events and API shapes (§4.2, §11), and the strict JSON Schema converter (§5.5).
// Fixtures live in the separate entry `@bs-job-agents/shared/fixtures`.
import { z } from "zod";

export const PACKAGE_NAME = "@bs-job-agents/shared";

/** Response body of the orchestrator's `GET /health`. */
export const HealthSchema = z.object({ ok: z.literal(true) });
export type Health = z.infer<typeof HealthSchema>;

// common
export * from "./common/primitives.js";
export * from "./common/host.js";
export * from "./common/sources.js";
export * from "./common/timezone.js";

// strict JSON Schema (§5.5, spike S4)
export * from "./json-schema/strict.js";
export * from "./json-schema/check.js";
export * from "./json-schema/validate.js";

// bots (§5)
export * from "./bots/self-check.js";
export * from "./bots/lead.js";
export * from "./bots/lead-proposals.js";
export * from "./bots/research.js";
export * from "./bots/cv.js";
export * from "./bots/qa.js";
export * from "./bots/apply.js";
export * from "./bots/consult.js";
export * from "./bots/registry.js";
export * from "./bots/definition.js";
export * from "./bots/inputs.js";
export * from "./bots/models.js";

// domain (§9, §9.1)
export * from "./domain/search-profile.js";
export * from "./domain/job.js";
export * from "./domain/cv-version.js";
export * from "./domain/application.js";
export * from "./domain/approval.js";
export * from "./domain/run.js";
export * from "./domain/schedule.js";
export * from "./domain/upload.js";
export * from "./domain/export.js";
export * from "./domain/engine-state.js";
export * from "./domain/chat.js";
export * from "./domain/master-cv.js";
export * from "./domain/saved-answer.js";
export * from "./domain/bot-record.js";

// workflows (§7)
export * from "./workflow/params.js";
export * from "./workflow/tasks.js";
export * from "./workflow/definition.js";

// events (§11)
export * from "./events/events.js";

// API (§4.2)
export * from "./api/common.js";
export * from "./api/chat.js";
export * from "./api/review.js";
export * from "./api/criteria.js";
export * from "./api/schedules.js";
export * from "./api/applications.js";
export * from "./api/uploads.js";
export * from "./api/runs.js";
export * from "./api/bots.js";
export * from "./api/contract.js";
