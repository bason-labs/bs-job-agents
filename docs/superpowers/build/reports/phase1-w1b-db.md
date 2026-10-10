# W1b data layer report (Phase 1)

- **Branch:** worktree-agent-aacf85c3febe6c7cb, 6 commits on develop@171c82e.
- **Checks:** 104 orchestrator tests (100 DB); typecheck, lint and test pass; drizzle-kit check is in sync.
- **Location:** everything is in `apps/orchestrator/src/db/`, plus `drizzle.config.ts` and `drizzle/0000_init.sql` and `0001_immutability_triggers.sql`.
- **Tables:** all §9 tables, with exact column names. CHECK constraints on enum columns. Unique and partial unique indexes: one application per job unless `reapply`, one active search profile, one Lead room, one consult room per bot.
- **Immutability triggers:**
  - `submissions` and `job_snapshots` reject UPDATE and DELETE.
  - An application that has a record cannot be deleted, and only its status can change.
  - Status history can only grow.
  - `approvals.used_at` cannot be reset.
- **Repository API:**
  - runs, steps, tasks with an atomic `claimNextTask` (BEGIN IMMEDIATE; engine, lock and pause filters)
  - `recoverInterruptedTasks`
  - engine pause/resume and hold/release
  - events
  - jobs dedupe (canonicalizeUrl, jobDedupeHash with VI normalisation) and companies (30-day profile cache)
  - CV/QA (pass rule ≥ 80 and no hard fails)
  - approvals (32-byte token, 24 h, atomic consume with domain match)
  - applications (transitions, `recordSubmission` in one transaction, `importApplication`, `getSubmissionRecord`)
  - search profiles (versioned)
  - schedules (soft delete, restore, purge; UNDO_WINDOW_MS = 6000; overlap check)
  - rooms and messages (Lead and consult rooms)
  - uploads, exports, saved answers
  - bots, prompt versions, memory changes, workflows
- **Deviations from §9:**
  - Integer ids and ISO text timestamps. JSON columns end in `_json` in SQL; the TS property drops the suffix.
  - Extra columns, among them `tasks.uses_browser` and `tasks.uses_figma`, `runs.schedule_id`, `cv_versions.pdf_sha256` and `applications.reapply`.
  - Step statuses chosen: pending, running, waiting, done, failed, skipped, cancelled.
  - Application statuses add approved, paused, needs_check and failed.
- **Handoffs:**
  - Map the DB enums to the shared Zod enums.
  - The W2a engine call sequence:
    1. At start-up: openDb, then recoverInterruptedTasks, then needs_check for each task it returns.
    2. claimNextTask with lock flags and per-engine caps.
    3. updateStepStatus before starting the next step.
    4. pauseEngine + holdEngineTasks, and the matching resume.
    5. dedupeCandidates.
    6. consumeApproval before Apply.
    7. recordSubmission, falling back to needs_check if it throws.
    8. Scheduler: dueSchedules, hasActiveRun, recordScheduleFired.
- **Open question:** UC-07b needs a flag recording that Ba confirmed an injection-flagged job (for example `jobs.injection_cleared_at`). Coordinator decision: add the column during Phase 1 QA.
- **Left to W4:** seeding the three imported TopCV applications.
