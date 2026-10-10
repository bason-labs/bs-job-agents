# F1 fixer report (PM must-fix M1–M4, S11, S12)

- **Merged** as 13082b2. Tests: 621 (shared 286, orchestrator 248, web 87).
- **S12:** default port 4100 (ORCH_PORT overrides).
- **S11:** engines `>=22.13.0`, engine-strict. 22.13 rather than 22.12 because a dependency refuses 22.12.
- **M4:** `db/schema-guard.ts` `GUARDED_SCHEMA_OBJECTS` (16 triggers plus `applications_job_uq`). `openDb`/`openTestDb` throw `SchemaGuardError` if any is missing. An upgrade test runs from every earlier migration.
- **M3:**
  - `applications.dry_run`; dry runs are out of the one-per-job index.
  - Shared `APPLICATION_STATUS_TRANSITIONS` has system, record and manual changes.
  - `submitted` is reachable only via `recordSubmission`, or Ba settling a `needs_check`.
  - Dry runs can never reach a post-submit status.
- **M2:**
  - `approvals.application_id`.
  - `approveApplication` creates the application and its token in one transaction.
  - `checkApprovalForResume` requires the same application, approved or paused, no record, token not expired, token used.
  - Approval rows are immutable except `used_at` (set once) and domains (only grow).
- **M1:**
  - `createApplication` and `createApproval` validate that the CV belongs to the job and has a PDF and SHA-256.
  - `recordSubmission` throws `SubmissionRefusedError`: `token_missing`, `token_unused`, `token_mismatch`, `sha_mismatch`, `dry_run_mismatch`.
- **Migrations:** 0003_dry_run_status_machine, 0004_approval_binding, 0005_record_matches_approval. No table rebuilds.
- **Rule for W2a:** trigger bodies name only the four never-rebuilt tables (see the `schema-guard.ts` header).

## Repository API W2a must use
- `approveApplication(db, { jobId, cvVersionId, allowedDomains, reapply?, dryRun?, ttlMs? }, { now? })` → `{ application, approval }`. Wrap it in `db.transaction` together with `createTask`.
- `createApproval(db, { applicationId, jobId, cvVersionId, allowedDomains, ttlMs? })`: for re-approving after expiry. Throws `ApprovalRefusedError` (cv_not_found, cv_job_mismatch, pdf_missing, no_domain, invalid_domain, application_mismatch, application_recorded, application_closed, token_live).
- `consumeApproval(db, token, { applicationId, jobId, cvVersionId, domain?, now? })`: first spawn. `checkApprovalForResume(db, token, { applicationId, jobId, cvVersionId, domain, now? })`: resume.
- `APPROVAL_DENIALS`, `SAFETY_REASON_FOR_APPROVAL_DENIAL`: map trust-guard denials to `safety.denied` reasons.
- `recordSubmission(db, { applicationId, status?, dryRun?, submission: { approvalToken, uploadedSha256, … }, snapshot })`: pass the ORCHESTRATOR's hash of the uploaded copy, never the bot's.
- `markSubmissionRefused(db, { error, taskId, botName? })`: moves to `needs_check` and appends `safety.denied` in one transaction.
- `transitionApplication(db, id, to, { by?: "system" | "manual", note?, now? })`: the W3a status-change API passes `"manual"`.
- `getApplicationByJob(db, jobId, { includeDryRuns? })`; `listApplications({ dryRun })`.
- Shared: `canTransitionApplicationStatus(from, to, change, { dryRun? })`, `canChangeApplicationStatus`, `PRE_/POST_SUBMIT_APPLICATION_STATUSES`, `SUBMISSION_REFUSAL_REASONS`, `SAFETY_DENIAL_REASONS`.
- Test helper: `seedApprovedApplication(db, job, cv, opts)`.
