// SQLite + Drizzle data layer (spec §9, §9.1). Owned by W1b in Phase 1.
//
//   const db = openDb("data/app.db");            // WAL, FKs, busy_timeout, migrations
//   recoverInterruptedTasks(db);                  // UC-18, once at start-up
//   const task = claimNextTask(db, { allowBrowser: !browserLock.held });
//
// Every repository function takes the Drizzle handle or a transaction
// (`db.transaction(tx => …)`), so several calls can be composed atomically.
export * from "./client.js";
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
