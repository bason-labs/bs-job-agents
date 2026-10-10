// SQLite + Drizzle data layer (spec §9, §9.1). Owned by W1b in Phase 1.
//
//   const db = openDb("data/app.db");            // WAL, FKs, busy_timeout, migrations; throws
//                                                 // SchemaGuardError if a §9.1 trigger is missing
//   recoverInterruptedTasks(db);                  // UC-18, once at start-up
//   const task = claimNextTask(db, { allowBrowser: !browserLock.held });
//
// The approve → apply → record path (§9.1, §10.2 rule 1; PM M1–M3):
//   approveApplication(tx, { jobId, cvVersionId, allowedDomains, dryRun? }) // UC-08: app + bound token
//   consumeApproval(db, token, { applicationId, jobId, cvVersionId, domain })        // first spawn
//   checkApprovalForResume(db, token, { applicationId, jobId, cvVersionId, domain }) // resume
//   recordSubmission(db, { applicationId, submission: { approvalToken, uploadedSha256, … }, … })
//   markSubmissionRefused(db, { error, taskId })  // on SubmissionRefusedError: needs_check + safety.denied
//   transitionApplication(db, id, to, { by: "system" | "manual" })               // shared status machine
//
// Phase 2 (W2a) additions the engine uses: recoverInterruptedTasks marks an interrupted Apply's
// application needs_check in the same transaction (PM S2); dedupeCandidates offers again jobs a
// failed run left `new` (jobIdsInActiveRuns, PM S3); upsertBot/updateBot refuse Apply at L2
// (TrustLevelRefusedError, PM S1); latestApprovalForApplication (tokens never sit in task inputs,
// PM S5); pauseTask keeps the bot's output; updateTaskInput; runs.search_profile_id (0006).
//
// Every repository function takes the Drizzle handle or a transaction
// (`db.transaction(tx => …)`), so several calls can be composed atomically.
export * from "./client.js";
export * from "./schema-guard.js";
export * as schema from "./schema.js";
export type { JsonObject, SubmittedField, StatusHistoryEntry } from "./schema.js";
export * from "./enums.js";
export * from "./types.js";
export * from "./errors.js";
export * from "./time.js";
export * from "./dedupe.js";
export * from "./repos/runs.js";
export * from "./repos/tasks.js";
export * from "./repos/recovery.js";
export * from "./repos/engine-state.js";
export * from "./repos/events.js";
export * from "./repos/bots.js";
export * from "./repos/companies.js";
export * from "./repos/jobs.js";
export * from "./repos/cv.js";
export * from "./repos/approvals.js";
export * from "./repos/applications.js";
export * from "./repos/search-profiles.js";
export * from "./repos/schedules.js";
export * from "./repos/rooms.js";
export * from "./repos/files.js";
export * from "./repos/saved-answers.js";
// DB rows → shared domain types (`mappers.toJob(row, company)`, …) for the API and SSE.
export * as mappers from "./mappers.js";
