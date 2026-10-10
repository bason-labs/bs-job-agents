# PM review: Phase 1 (Foundations)

- **Reviewed:** `develop` at f53f244 (Phase 1 merges plus the QA/QC fixes), in worktree branch `worktree-agent-a6bdd6c892bb6d960`.
- **Read:** the spec, `stage0-prototype.html`, phases.md, progress.md, the three W1 reports, qa-phase-1.md, and the code in `packages/shared`, `apps/orchestrator/src/db` + `drizzle/`, `apps/web`.
- **Re-ran (uncached):** `pnpm install --frozen-lockfile`; `turbo typecheck lint test --force`: 10/10 tasks, 521 tests (shared 277, web 87, orchestrator 157); `pnpm e2e` on `E2E_PORT=3157`: 37/37. The QA numbers hold.
- **Probed the data layer:** a scratch script (not committed) ran the real repositories against `openTestDb()`. Results:

| # | Case | Result |
|---|---|---|
| 1a | Dry-run application, then `transitionApplication(→ submitted)` | Allowed: status `submitted`, job `applied`, record still says `dry_run = 1` |
| 1b | Real application for the same job after a dry run (no `reapply`) | Refused: `UNIQUE constraint failed: applications.job_id` |
| 2 | `recordSubmission` with `uploaded_sha256` ≠ the approved `cv_versions.pdf_sha256` | Allowed, recorded as `submitted` |
| 3 | `recordSubmission` for job A citing an unused token of job B | Allowed, recorded as `submitted` |
| 4a | `createApproval(job A, CV version of job B)` | Allowed |
| 4b | `createApproval` for a CV version with no `pdf_path` / `pdf_sha256` | Allowed |
| 5 | The same apply task resumes after a pause: `consumeApproval` / `checkApproval` again | Both return `used`; no way to re-validate |
| 6 | `transitionApplication(approved → submitted)` with no submission record | Allowed: job `applied`, `submitted_at` null |
| 7 | `upsertBot(apply, trustLevel 2)` | Allowed |

## 1. Verdict

**Ready for Phase 2: yes, once the must-fix batch (M1–M5) has landed.**

- The foundations are good. The shared schemas were checked live on both CLIs. The data layer has real-SQLite tests: triggers, a two-process claim race, and an upgrade of a populated database. The design system follows the own-components, cursor, centering and viewer-first rules, and its e2e tests exercise real keyboard and pointer behaviour rather than snapshots.
- The gaps sit in one place: the approval → apply → record path. Phase 2 builds the "never submit without Ba's approval" guarantee on that path, so it must be closed first.
- All fixes are additive, in `apps/orchestrator/src/db/**` and `packages/shared/**`.
- **Scheduling:** W2b (runner) and W2c (bridges) can start now; they do not touch approvals or applications. W2a should start only after M1–M4 merge, or do them as its first commits, gated by their tests before any engine code.

## 2. MUST-FIX before Phase 2

### M1. The data layer does not bind approvals and records to the approved job, CV and file
- **What:**
  - `createApproval` accepts a CV version that belongs to another job, a CV version without `pdf_path` / `pdf_sha256`, and an empty domain list. `createApplication` does not check that its CV version belongs to the job.
  - `recordSubmission` accepts any approval token: an unused one, or one issued for another job. It also accepts any `uploaded_sha256`. (Probe cases 2, 3, 4a and 4b.)
- **Where:** `apps/orchestrator/src/db/repos/approvals.ts` (`createApproval`, l.33); `repos/applications.ts` (`createApplication`, l.96; `recordSubmission`, l.173).
- **Why:**
  - §10.2 rule 1 requires the binding.
  - §9.1: "a mismatch aborts the submit", and the record "always proves which file the employer received".
  - The record is Ba's evidence, so it must be impossible to write it with a token or a file that does not match the approval.
- **Acceptance:**
  - `createApproval` and `createApplication` throw unless the CV version exists and belongs to the job. `createApproval` also requires `pdfPath`, `pdfSha256` and at least one valid domain.
  - `recordSubmission` writes nothing and throws a typed error (`reason`: `token_missing`, `token_unused`, `token_mismatch` or `sha_mismatch`) unless all of these hold:
    - the token exists, has `used_at` set, and its `job_id` and `cv_version_id` match the application's;
    - the uploaded file's SHA-256 equals the approved `cv_versions.pdf_sha256`. It is required for `submitted`, and must match whenever it is present for `needs_check`.
  - The engine catches the error, marks the application `needs_check` and appends `safety.denied`.
  - There is a test for each refusal. The existing happy-path tests and `importApplication` are unchanged.

### M2. A used token cannot be re-validated when the same application resumes
- **What:**
  - `consumeApproval` marks the token used at the first spawn. After that, every check returns `used`, including the same application resuming after a pause (UC-11 a/b/e, UC-12, UC-17). Probe case 5.
  - No column links a token to the application it authorises; `submissions.approval_token` is only written at record time.
- **Where:** schema `approvals` plus a migration; `repos/approvals.ts`.
- **Why:** without the link, W2a has only two options for resume, and both weaken rule 1:
  - don't consume the token at spawn, which reopens token reuse and double submits;
  - skip the check on resume, which bypasses the token.
- **Decision:**
  - A token is bound to one application when it is created; UC-08 creates both in one transaction.
  - A used token validates only a resume of that application, and only while all of these hold: the application is `approved` or `paused`, it has no submission record, and the token is not expired. The 24 h limit is applied as written in the spec.
  - After expiry, Ba approves again on the card. That issues a new token for the same application.
- **Acceptance:**
  - Add `approvals.application_id` with `ADD COLUMN`: no table rebuild, and the `approvals_single_use` trigger is untouched.
  - Add `checkApprovalForResume(token, { applicationId, jobId, cvVersionId, domain })`. Tests:
    - the same application passes;
    - each of these is denied: another application, an application with a record, an application in `needs_check`, `failed` or `submitted`, and an expired token.
  - Hardening, in the same migration:
    - an approvals row is immutable except `used_at` (set once) and `allowed_domains`;
    - `allowed_domains` may only grow, and only until a submission references the token. The record panel reads the approval from this row (`mappers.toSubmissionRecord`).
  - `addApprovalDomain` refuses once the application has a record or a terminal status.

### M3. Dry runs, and the application status machine
- **What:**
  - A dry run takes the job's one-application slot, so the first real application fails unless it uses `reapply` (probe 1b).
  - A dry-run application can be moved `needs_check → submitted`. The record then contradicts itself, and the job is marked `applied` (probe 1a).
  - `transitionApplication` allows `approved/paused → submitted` with no record (probe 6).
  - There are two transition tables for one entity:
    - shared `MANUAL_STATUS_TRANSITIONS` (`domain/application.ts` l.56), where `rejected` can never change again;
    - the DB's `canTransitionApplication` (`applications.ts` l.25–43), which allows any change between post-submit statuses.
- **Where:** schema `applications` and the `applications_job_uq` index (`schema.ts` l.382); `repos/applications.ts`; shared `domain/application.ts`.
- **Why:**
  - §10.2 rule 5 and §9.1 record integrity.
  - Open item 1 is decided below.
- **Acceptance:**
  - **Dry-run flag:**
    - `applications.dry_run`: NOT NULL, default 0, set by `createApplication({ dryRun })`.
    - The unique index becomes `WHERE reapply = 0 AND dry_run = 0`. This is a drop and re-create of the index, not a table rebuild.
    - `recordSubmission` refuses a dry-run flag that differs from the application's.
  - **Dry-run guards:**
    - A dry-run application never reaches `submitted` (repository check plus a trigger) and never marks the job `applied`.
    - "Already applied" lookups ignore dry runs.
  - **Status machine:**
    - `submitted` is reachable only through `recordSubmission`, or through Ba's manual `needs_check → submitted` on a non-dry-run application.
    - One transition table lives in shared (system transitions plus manual transitions), and the DB uses it.
    - Manual moves between post-submit statuses stay free, as in the prototype's status select. History keeps every change, so a mis-click on "Rejected" can be corrected.
  - **Triggers:**
    - Re-create `applications_frozen_after_record` so that it also freezes `dry_run` and `created_at`.
    - Make `applications_history_append_only` check that the old history is a prefix of the new one. Today it only compares lengths, so earlier entries can be rewritten.
  - Probe cases 1a, 1b and 6 become tests.

### M4. Guard the §9.1 triggers against future migrations
- **What:**
  - Nothing checks at runtime that the eight immutability triggers exist.
  - drizzle-kit rebuilds a table, and silently drops its triggers, whenever a CHECK, a NOT NULL or the column order changes. Migration 0002 avoided this only by hand-editing and by keeping the enum order.
- **Where:** `src/db/client.ts` (`runMigrations`, `openDb`); `src/db/migrations.test.ts`.
- **Why:** M2 and M3 add migrations to exactly the tables that carry triggers (`applications`, `approvals`).
- **Acceptance:**
  - One exported constant lists the trigger names and the `applications_job_uq` index.
  - After migrating, `openDb` checks `sqlite_master` against that list and throws a clear error if anything is missing. This fails closed: the orchestrator does not start.
  - A test migrates a populated database from every earlier migration to head, then checks rows, triggers and the index.

### M5. Nobody owns `packages/shared` and `apps/orchestrator/src/db` in Phase 2
- **What:** phases.md gives those paths to W1a and W1b for Phase 1 only. Phase 2 needs changes there:
  - the follow-ups to M1–M4;
  - new events and the FakeRunner fixtures;
  - the split of the Apply input schema (S5).
- **Where:** `docs/superpowers/build/phases.md`, Phase 2 rows.
- **Why:** under the "stay inside your owned paths" rule, W2a and W2b would either be blocked or make conflicting edits.
- **Acceptance:** before the Phase 2 briefs go out:
  - **W2a** owns `apps/orchestrator/src/db/**`, `apps/orchestrator/drizzle/**` and `packages/shared/src/{domain,workflow,events,api,fixtures}/**`.
  - **W2b** owns `packages/shared/src/{bots,json-schema}/**`.
  - **W2c** asks for changes through its handoff.
  - Shared changes are additive only. The drift tests (`db/enums.test.ts` and the web status tests) stay green.

## 3. SHOULD-FIX (fold into the next phases)

These are places where existing Phase 1 code or docs need a change. Advice on how to build Phase 2 is in section 7 of this review.

| # | Owner | Item | Why |
|---|---|---|---|
| S1 | W2a | `upsertBot` / `updateBot` refuse Apply at trust level 2 in Phase 1 (probe 7) | UC-19. The trust guard must still require a token for `apply.submit` whatever the level says (see section 7). |
| S2 | W2a | Recovery marks the application `needs_check` in the same transaction as the task, or every start-up reconciles `interrupted` apply tasks. Build the non-retryable list from shared constants, not the literal `{ botName: "apply", kind: "submit" }` (`recovery.ts` l.28). | Today a crash between recovery and the engine's update leaves the application `approved` forever. The string literal silently stops matching if the kind naming changes, and the result would be an apply re-queued after a crash. |
| S3 | W2a | `dedupeCandidates` (`jobs.ts` l.94) treats jobs left `new` by a failed or cancelled run as duplicates forever. Re-offer `new` jobs that no active run owns. | Jobs that were never scored would otherwise disappear silently. |
| S4 | W2a | Workflow schema: a task `kind` must be in `BOT_TASK_KINDS[bot]` (today any string, `definition.ts` l.25), and `apply.submit` may only appear in an `action` step. | Typos fail at load time, and no workflow can run Apply outside an approval-gated step. |
| S5 | W2b | Keep the approval token out of the prompt, the transcripts and anything the UI shows. Today `ApplySubmitInputSchema.approvalToken` (`bots/inputs.ts` l.88) is part of the task input. The runner puts the input in the prompt (§5.5 step 1), and `mappers.toTask` returns it (l.236). Split guard-only fields from the prompt input. | The token is a capability. The bot never needs it. |
| S6 | W2b | `BotDefinitionSchema`: a `browser.mode: "write"` bot must use `engine: "claude"`, and Apply must have `trustLevel: 1` in Phase 1. | §4.4: the site allowlist is enforced only on Claude. Today nothing stops Apply from being switched to Codex. |
| S7 | W2b | FakeRunner fixtures: §12 says they replay the spike's captured `stream-json` / `exec --json` lines, but the spike code was thrown away and the repo has none. Capture fresh samples with a few cheap live calls, as QA did, and commit them. Label the never-observed limit payloads as synthetic. | Without real captures, the parsers are tested against guesses. |
| S8 | W3b (shell) | The paused banner prints raw seconds (`AppShell.tsx` l.96), so a real 3-hour pause reads "auto-resume in 10800s". Show "Claude paused until 14:05 · resumes in 2h 10m". | Spec UC-16 shows the clock time; the prototype shows the countdown. Real pauses last hours, not the prototype's 15 s. |
| S9 | W3c (shell) | Team list: show the trust badge only on Apply (L1), as in the prototype and now the spec (`Sidebar.tsx` l.90). Page widths per the prototype: Review, Applications and Bots `max-w-6xl` (Bots as a two-column grid); Criteria, Schedules and Master CV `max-w-3xl`. Today `wide` is `max-w-5xl` and Bots uses `narrow` (`Page.tsx` l.15–16). | Fidelity to the prototype. |
| S10 | W3a | The bot update API (`BotUpdateRequestSchema`, `api/bots.ts` l.25) refuses Apply `engine: "codex"` and Apply trust level 2 (`canPromote`). The Bots screen disables both, with the reason. | §4.4 and UC-19. The prototype shows an engine toggle on every bot card; the safety rule wins (section 5, FYI b). |
| S11 | Coordinator | Node ≥ 22.12: `engines.node: ">=22.12.0"`, `engine-strict=true` in `.npmrc`, and a README line. | Open item 5. |
| S12 | Coordinator | Orchestrator default port 4100: `config.ts`, `server.test.ts`, README, and the `API_ROUTES` comment. | Open item 8. Do it with the must-fix batch. |
| S13 | Coordinator | Phase 3 ownership: give `apps/web/components/**` and `apps/web/lib/**` (shell, design system, api seam) to one W3 worker. | The W3b/W3c rows cover routes only. S8, S9 and the `lib/api` wiring need an owner. |

## 4. Decisions on the QA open items

1. **Dry-run applications vs one application per job.**
   - **Decision (PM):** dry runs never count toward the one-per-job rule. M3 implements it.
   - **Why:**
     - A dry run sends nothing.
     - Counting it forces "apply again" on the first real application, so `reapply` would no longer mean a second real application, which is the audit meaning of rule 5.
     - It also closes probe 1a.
   - **How it fits the other rules:**
     - The record machinery stays, so Ba can see what would have been sent.
     - The dry run uses its own token.
     - The live run needs a fresh approval, so "Ba says yes before any submission" still holds.
     - Dry runs are labelled in the Applications list and left out of the export by default.
2. **SHA-256 "mismatch aborts the submit" (§9.1).**
   - **Decision:** enforce it in three places. This agrees with the coordinator and adds the copy step in (b).
     - (a) W2c hashes the PDF at export into `cv_versions.pdf_sha256`.
     - (b) Before spawning Apply, W2a copies the approved PDF into `data/applications/<applicationId>/`, re-hashes the copy and aborts on a mismatch. This is the actual abort. Apply's `--add-dir` covers only that folder; today `data/pdf/` holds every CV.
     - (c) `recordSubmission` refuses a mismatched hash (M1). It cannot undo a submit that already happened, but it keeps a bad record from looking clean and routes it to `needs_check`.
   - The hash the bot reports is never evidence; the bot cannot hash files. Store the orchestrator's hash.
3. **Nullable SQL columns guarded only by typed repositories.**
   - **Decision:** accepted.
   - **Why:** there is one writer, repository inputs are typed and required, and the mappers fail loudly on NULL. Tightening the columns means rebuilding tables, which is exactly the trigger risk in item 4.
   - **Conditions:**
     - API list endpoints skip and log a row that fails its mapper instead of failing the whole list (W3a).
     - New Phase 2 columns are NOT NULL with a default wherever possible.
4. **Trigger-dropping table rebuilds.**
   - **Decision:** M4 (a runtime inventory in `openDb` plus an upgrade-path test).
   - Plus these migration rules in every brief:
     - never rebuild `applications`, `submissions`, `job_snapshots` or `approvals`;
     - the shared enum arrays are append-only, because their order feeds the CHECK constraints;
     - read the generated SQL before committing it.
5. **Node ≥ 22.12 for drizzle-kit.**
   - **Decision:** enforce it with `engines`, `engine-strict` and a README line (S11).
   - `.nvmrc` stays `22`, because nvm resolves it to the latest 22.x.
   - Only `db:generate` (dev time) needs it, so it does not block anything.
6. **Salary-rule wording.**
   - **Decision:** the prototype wins.
   - The spec is aligned in this commit (§7.5, UC-12). The shared labels already match the prototype (e66c90d).
7. **Sidebar "Manage" link to `/bots`.**
   - **Decision:** keep it. Owner FYI for the Phase 3 UX review.
   - **Why:**
     - The ⚙ only shows on hover or keyboard focus, so on touch (the mobile drawer) "Manage" is the only way to the Bots overview.
     - It is a quiet 10 px label in the Team header.
   - Not added to the spec, so the owner can still veto it.
8. **Orchestrator port: spec 4100, code 4318.**
   - **Decision:** use **4100** (the spec value). This overrides the coordinator's leaning towards 4318.
   - **Why:**
     - 4318 is the standard OTLP/HTTP port of OpenTelemetry collectors, for example one set up to watch Claude Code usage.
     - A clash would stop the orchestrator from binding.
     - Changing it now costs four lines (S12). Later it would also touch the launchd plist and the web app's orchestrator URL.
   - No spec change is needed.

## 5. Owner escalations

**None blocking.** FYIs for the owner:
- **(a) "Manage" link:** kept (item 7).
- **(b) Apply's engine switch:**
  - The prototype shows an engine toggle on every bot card, including Apply.
  - Spec §4.4 and spike S2 keep browser bots that write on Claude, because the site allowlist is only enforced there.
  - PM keeps the safety rule: Apply's toggle is disabled, with the reason shown.
- **(c) Apply is never retried automatically:**
  - §5.5 allows 2 attempts per task.
  - UC-11c and UC-18 say a submission is never repeated automatically.
  - PM decision for W2a: after `apply.submit` has started, a failed or interrupted attempt goes to `needs_check`; it is never retried or restarted. This covers crashes, timeouts, usage limits, invalid output after the repair prompt, and failed self-checks.
  - Proposed wording for §5.5 step 6 (not applied, because it changes the letter of a rule): *"Exception: `apply.submit` is never retried or restarted automatically once it has started; a failed or interrupted attempt goes to `needs_check` (UC-11c, UC-18)."*
- **(d) The file name employers see:**
  - As designed, Apply would upload `data/pdf/<frameName>.pdf`, so employers would see the internal frame name, such as `NOVAPAY_SENIOR-FE_EN_v1.pdf`.
  - Suggestion: `BA_HUYNH_<COMPANY>_<LANG>.pdf`, like the DEKON, SMARTBIT and YAVIET uploads.
- **(e) Dry-run acceptance (§12):**
  - It runs on a real site and relies on the model not clicking submit.
  - Run it on a job Ba wants to apply to anyway.

## 6. Spec wording fixes

**Applied in this commit.** They align the spec with the approved prototype and change no requirements:
1. **Header:** the approved UX is `stage0-prototype.html`. `ui-v3.html` is now called the earlier direction.
2. **§7.5:** the salary-rule options use the prototype labels:
   - Leave blank when optional
   - Write “Negotiable / Thỏa thuận”
   - Use a fixed amount
   - Ask me each time

   CV languages are marked "shown read-only; fixed by §6.3", as the prototype shows them.
3. **UC-12:** the rule names match those labels.
4. **UC-13b:** the data folder and the last export date are on the Applications screen. Neither §11 nor the prototype has a Settings screen.
5. **§11 intro:** the approved UX reference.
6. **§11 Sidebar:**
   - L1 trust badge on Apply
   - Master CV link
   - Claude/ChatGPT usage and Chrome extension status
   - "Chrome not connected" state
7. **§11 Applications:**
   - the prototype's columns (source, proof);
   - the job link in the record panel;
   - a header with the data folder and the last export.
8. **§11 Search criteria:** lists the application form defaults; CV languages are a read-only note.

**Proposed, not applied:** these need the owner's OK, or follow from technical decisions.
- §5.5 step 6: the Apply exception (FYI c).
- §5.1: the example `"outputSchema": "ResearchOutput"` names a schema that does not exist. Research uses a map from task kind to schema (a W1a decision).
- UC-13b: where the optional weekly auto-export control lives. Proposal: the Applications screen, next to "⬇ Export all (ZIP)".
- §9: list the extra columns once M1–M3 land (`approvals.application_id`, `applications.dry_run`, `submissions.dry_run`, plus the extras listed in QA §5).

## 7. Briefing for the Phase 2 workers

### All workers
- **Tests:**
  - Use `openTestDb()` and `src/db/test-helpers.ts` (`seedBots`, `seedJob`, `seedCv`, `seedRun`, `seedTask`).
  - Every repository function takes `Conn`. Wrap multi-step writes in `db.transaction(tx => …)`.
  - Pass `{ now }` for deterministic time.
- **Validation:** validate at every boundary with the shared Zod schemas:
  - `parseBotOutput` and `BOT_TASK_INPUT_SCHEMAS` for bots;
  - `WorkflowDefinitionSchema` for workflows;
  - `appendAppEvent` for anything the UI shows. It validates with `AppEventSchema`, and its row id is the SSE id. Use `appendEvent` only for audit-only rows.
- **Migrations:**
  - Generate with `pnpm --filter @bs-job-agents/orchestrator db:generate` (Node ≥ 22.12), then read the SQL.
  - Follow the rules in decision 4.
  - Add a populated-upgrade case to `migrations.test.ts`.
- **Checks:**
  - Run them with `turbo --force`; the Turbo cache is shared across worktrees.
  - Run e2e with your own `E2E_PORT`.
  - Never call real CLIs, Chrome or Figma in tests.

### W2a: engine, trust guard, scheduler, FakeRunner
- **Start-up:**
  1. `openDb`, then `recoverInterruptedTasks`.
  2. Mark each returned `needsCheck` task's application `needs_check` (S2).
  3. For each engine in `enginesDueToResume`: `resumeEngine`, then `releaseEngineTasks`.
- **Claim loop:**
  - Call `claimNextTask({ engines: underCap, allowBrowser, allowFigma })`.
    - The caps come from `LIMITS.engineSessionsDefault`, counted with `countTasks({ status: "running", engine })`.
    - The locks live in memory. They are free after a restart, because recovery runs first.
  - While Chrome or the Figma bridge is down, pause the affected tasks with `needs_browser` / `needs_figma`, so the UI shows why they wait. Requeue them on reconnect.
- **Steps:**
  - Persist a finished step with `updateStepStatus(id, "done", { output })` before starting the next one (UC-18).
  - `resetStep` re-runs a step. Never use it on an `action` step whose application has a record (UC-23).
  - `steps` is unique on (run, step_key, branch_key). A gate that runs per language needs the language in the branch key, for example `42:vi`.
- **Data flow, with the repository functions to use:**
  - Dedupe and fit:
    - `dedupeCandidates` (fix S3), then `setJobFit`, then `setJobStatus`.
  - Company research:
    - `getFreshCompanyProfile`, which applies the 30-day cache;
    - `saveCompanyProfile`, which stamps the time with the orchestrator's clock.
  - CV and QA:
    - `createCvVersion`, with the orchestrator setting `pdfPath` and `pdfSha256` after export;
    - `createQaReview`, which flags injection on the job;
    - `qaPassed` for the pass rule.
- **Approve (UC-08):**
  - Create the application, the bound approval (M2) and the `apply.submit` task in one transaction.
  - `createApproval` throws on an injection-flagged job.
  - Derive `allowedDomains` from the job URL's registrable host: strip `www.` and `m.`. `domainAllowed` accepts subdomains of an allowed domain, not its parents, so `www.topcv.vn` would block `topcv.vn`.
- **Apply:**
  - Before spawning Apply:
    - use `consumeApproval` on the first spawn and `checkApprovalForResume` on a resume (M2);
    - always pass `domain`. Without it, the domain check is skipped.
  - Spawn rules:
    - Copy the PDF into the per-application folder and re-check its hash (decision 2).
    - Give Apply that folder only.
    - Use a recruiter-facing file name (FYI d).
  - On the result:
    - call `recordSubmission`;
    - if it throws, mark the application `needs_check`, call `appendAppEvent(safety.denied)` and keep the raw output on the task.
- **Trust guard:**
  - Key it on the task (`apply.submit`), not on the bot's trust level: Phase 1 always requires a token (S1).
  - Write the §1.2 #3 test ("nothing is ever submitted without Ba's approval"), including the case where Apply sits at L2 in the database and in bot.json.
- **Attempt policy for Apply:** see FYI c. Only pauses Apply reports itself resume, and only after Ba acts:
  - a pending question;
  - a login or CAPTCHA;
  - a domain to confirm.

  A usage-limit interruption of a running Apply also goes to `needs_check`; it does not restart from the beginning.
- **Dry run:** if Apply reports `submitted` during a dry run, treat it as a safety event plus `needs_check`, because it may really have submitted.
- **Review decision:** store Ba's decision in the human step's output:
  - approve / request changes / skip;
  - the chosen CV version;
  - whether the intro was edited;
  - the comment and the time.

  The §5.3 promotion rule ("approved without edits") and sub-project C need it, and nothing else stores it.
- **Scheduler:**
  - Use `dueSchedules`, `hasActiveRun` (UC-02a) and `resolveSearchProfile`, so schedules follow profile edits. Then `recordScheduleFired`.
  - Compute the next fire time with croner in the schedule's `timezone`.
  - Allow at most one catch-up per schedule within `LIMITS.catchUpWindowMs`.
  - Call `purgeDeletedSchedules` after the 6 s undo window.
- **Paths:** store file paths relative to `data/`, so restores and exports keep working.

### W2b: runner and bots
- **Commands:** use the verified flags from spike S1, verbatim:
  - always close stdin;
  - pass `--setting-sources ""`;
  - never use `--bare` or `--safe-mode`.

  Codex browser bots need Ba's user config with every other plugin disabled, plus `--enable skip_host_skill_discovery --disable skill_search`. Ignore the warning item that this emits.
- **Schemas:**
  - At start-up:
    - write `bots/<name>/schema.json` from `getBotOutputJsonSchema`;
    - call `assertStrictJsonSchema`, which rejects `pattern`, `$ref`, `oneOf`, `allOf` and `not` (`anyOf` is allowed for nullable values);
    - pick each task's schema with `resolveOutputSchemaName(def, kind)`. Research has one schema per kind, and the consult/discussion kinds use `ConsultOutput`.
  - On each result:
    - validate with `parseBotOutput` and allow one repair prompt. Expect repairs mainly for cross-field rules (Apply `paused` needs a reason) and placeholder URLs; this is QA's live finding.
    - fail the attempt if `failedSelfChecks` is non-empty.
- **Claude stream:**
  - Cross-check `result.permission_denials` against `tool_result.is_error`, because errored calls are listed there too.
  - Read `rate_limit_event` into `EngineUsageSchema` (5-hour and 7-day windows, `resetsAt`) and pause at `LIMITS.usagePauseUtilization`.
- **Codex stream:** detect a limit from `turn.failed` containing `usage_limit_reached`; it has not been observed live yet.
- **Rule 2 (memory):**
  - Append `memoryNotes` one at a time, serialised per bot.
  - Record each with `appendMemoryChange`.
  - Archive beyond 200 lines to `memory.archive.md`.
- **Prompt versions:** at start-up, compare ROLE.md's hash with the stored `prompt_versions` row for the same version. If it differs, refuse to start until `promptVersion` is bumped. `recordPromptVersion` is idempotent and would otherwise keep stale text.
- **Screenshots: unverified risk.**
  - Spike S2 never saved screenshots to files, yet §9.1 needs the pre-submit and confirmation screenshots.
  - Verify early that Claude in Chrome screenshot results arrive as image bytes in `stream-json` `tool_result` blocks. If they do, the runner writes them to `data/applications/<id>/`, and the bot only names which one is which.
  - Screenshots are viewport-only, so the "full-page" JD screenshot needs a fallback: page text plus viewport shots.
- Also S5 (token out of the prompt), S6 (write-browser bots on Claude), S7 (real FakeRunner captures), and the tab-group cleanup after each browser task.

### W2c: bridges
- **Figma:**
  - Call `figma_get_status {probe:true}` before a CV task. If the bridge is down, `pauseTask(needs_figma)`.
  - One CV task uses Figma at a time (Figma lock).
  - Export with `figma_execute` (`exportAsync({format:'PDF'})` plus `figma.base64Encode`), write `data/pdf/<frameName>.pdf`, then hash it into `pdf_sha256` (M1 depends on this).
  - Keep each call under the 30 s cap by chunking long edits.
  - Fingerprint the protected pages (node ids, names, text) before and after each CV task. Any change fails the task and alerts Ba.
  - A `PreToolUse` hook rejects code that references pages other than Drafts.
- **PDF checks:**
  - Extract text with `pdfjs-dist` in Node; it is already a web dependency. Never use macOS PDFKit.
  - Check for exactly one A4 page (595×842).
- **Site guard (Claude):**
  - Hook `navigate` and check the code of `javascript_tool`. Do not match `tabs_create_mcp`.
  - The allowed list is fixed per spawn and comes from the token for Apply. When Ba confirms a new domain mid-apply (UC-11e), that means a respawn with new settings.
- **Hashing:**
  - Use a streaming SHA-256 helper that returns lowercase hex (`Sha256Schema`).
  - Check uploads with shared `checkUploadFile`.

## 8. Notes for Phase 3 (short)
- **W3a:**
  - Never return an unused approval token.
  - Serve files only by id, from known rows under `data/`, never from a path the client sends.
  - Proxy `/files` and `/events` through Next. Same origin means the viewer's Download and SSE need no CORS.
  - List endpoints tolerate a bad row (decision 3).
  - The approve flow is one transaction.
- **W3b:**
  - Use the prototype's copy, for example the empty Review queue: "Nothing to review 🎉 — Lead will ping you after the next scan."
  - The flow title comes from the workflow; today it is always "Job scan #…".
  - The Skip modal keeps the shared rule that "Other" needs a note.
- **W3c:**
  - Applications:
    - label dry runs;
    - offer "Apply again" for `failed` applications, because the one-per-job slot needs the explicit override;
    - the status select follows the unified transition table (M3).
  - Bots: Apply's engine switch and promote button are disabled (S10).
  - Search criteria: CV languages are read-only.
