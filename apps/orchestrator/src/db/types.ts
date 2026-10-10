// Row types inferred from the Drizzle schema. These are the DB shapes; API and
// bot payloads use the shared Zod types in packages/shared (see report for the
// mapping).
import type * as s from "./schema.js";

export type Bot = typeof s.bots.$inferSelect;
export type PromptVersion = typeof s.promptVersions.$inferSelect;
export type MemoryChange = typeof s.memoryChanges.$inferSelect;
export type Workflow = typeof s.workflows.$inferSelect;
export type Run = typeof s.runs.$inferSelect;
export type Step = typeof s.steps.$inferSelect;
export type Task = typeof s.tasks.$inferSelect;
export type Company = typeof s.companies.$inferSelect;
export type Job = typeof s.jobs.$inferSelect;
export type CvVersion = typeof s.cvVersions.$inferSelect;
export type QaReview = typeof s.qaReviews.$inferSelect;
export type Approval = typeof s.approvals.$inferSelect;
export type Application = typeof s.applications.$inferSelect;
export type Submission = typeof s.submissions.$inferSelect;
export type JobSnapshot = typeof s.jobSnapshots.$inferSelect;
export type ExportRecord = typeof s.exports.$inferSelect;
export type SavedAnswer = typeof s.savedAnswers.$inferSelect;
export type Upload = typeof s.uploads.$inferSelect;
export type SearchProfile = typeof s.searchProfiles.$inferSelect;
export type Schedule = typeof s.schedules.$inferSelect;
export type Room = typeof s.rooms.$inferSelect;
export type RoomMember = typeof s.roomMembers.$inferSelect;
export type Message = typeof s.messages.$inferSelect;
export type EngineStateRow = typeof s.engineState.$inferSelect;
export type EventRow = typeof s.events.$inferSelect;
