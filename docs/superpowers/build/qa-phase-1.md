# QA/QC report: Phase 1 (Foundations)

- **Branch:** `worktree-agent-acac40093d7c5043b`, from `develop` at d8ed1e7 (all Phase 1 merges). 14 commits.
- **Result:** the definition of done passes, uncached (`turbo --force`): install, typecheck, lint, test, build and e2e are all green.
- **Scope checked:**
  - W1a `packages/shared`: §5.1–5.5, §7, §9, §9.1
  - W1b `apps/orchestrator/src/db`: §9, §9.1, §10.2
  - W1c `apps/web`: §11, plus the §12 rows for output formats and own UI components
  - Live CLI verification of every bot output schema

## 1. Checks

| Check | Baseline (d8ed1e7) | Final (HEAD) |
|---|---|---|
| `pnpm install` | ✅ | ✅ |
| `pnpm -w typecheck` | ✅ 4/4 tasks | ✅ 4/4 (`--force`, 0 cached) |
| `pnpm -w lint` | ✅ 0 warnings | ✅ 0 warnings (`--force`) |
| `pnpm -w test` | ✅ 420 (shared 248, web 68, orchestrator 104) | ✅ 521 (shared 277, web 87, orchestrator 157) |
| `pnpm build` | ✅ | ✅ (`--force`) |
| `pnpm e2e` | ✅ 35/35 | ✅ 37/37 |
| `drizzle-kit check` / `generate` | in sync | in sync; "No schema changes" after 0002 |

Notes on how the checks were run:
- **Turbo cache:** Turbo shares its local cache across git worktrees. The first baseline run printed "cache hit, replaying logs" from other worktrees, so every result above was re-run with `--force`.
- **e2e port:** e2e ran with `E2E_PORT=3147`, so no other worktree's dev server could answer instead.

## 2. Live schema verification (one-off, not in the test suite)

**Setup:**
- **CLIs:** Codex `codex-cli 0.162.0-alpha.17.2` (ChatGPT.app) and Claude Code `2.1.296` (`--model haiku`). Each was run with the exact flags in the brief, from a temp dir outside the repo, with stdin closed.
- **What was checked:** every schema came from `getBotOutputJsonSchema(name)`. Each returned object was checked with `parseBotOutput`.
- **Cost:**
  - Claude: 19 calls, $0.041 in total.
  - Codex: 24 calls, about 20k input tokens each (431k in total).

### 2.1 Bot output schemas

- **v1** = W1a's schemas as merged (structural keywords only).
- **v2** = after commit 215eb1d (bounds and `date-time`).
- **v3** = after the frame-name description was added (CvOutput only).

| Schema | Codex: schema accepted | Codex: object passes Zod (v1 → v2/v3) | Claude: schema accepted, `structured_output` | Claude: object passes Zod (v1 → v2/v3) |
|---|---|---|---|---|
| LeadOutput | ✅ v1, v2 | ❌ empty `selfCheck` → ✅ | ✅ v1, v2 | ❌ empty `selfCheck` → ✅ |
| ResearchScanOutput | ✅ | ❌ empty `selfCheck` → ✅ | ✅ | ❌ empty `selfCheck` → ✅ |
| ResearchFitOutput | ✅ | ✅ → ✅ | ✅ | ✅ → ✅ |
| ResearchCompanyOutput | ✅ | ❌ `researchedAt` not a datetime, empty `selfCheck` → ✅ | ✅ | ❌ same → ✅ |
| CvOutput | ✅ v1, v2, v3 | ❌ empty `sections`/`sectionOrder`/`selfCheck`, bad frame name → ❌ frame name (v2) → ✅ (v3) | ✅ | ❌ → ❌ frame name (v2) → ❌ `figmaFrameUrl: "x"` (v3) |
| QaOutput | ✅ | ❌ empty `selfCheck` → ✅ | ✅ | ❌ empty `selfCheck` → ✅ |
| ApplyOutput | ✅ | ❌ → ❌ "paused needs a pauseReason or pendingQuestions" | ✅ | ❌ empty `selfCheck` → ✅ |
| ConsultOutput | ✅ | ❌ empty `selfCheck` → ✅ | ✅ | ❌ empty `selfCheck` → ✅ |

**Schema rejections:** none on either engine in any round.

**Zod-valid objects:**
- v1: 1 of 8 schemas on each engine.
- Final: 7 of 8 on each engine.

**The two misses that remain are model outputs, not schema defects:**
- **Codex ApplyOutput:** "paused needs a pauseReason or pendingQuestions" is a cross-field rule that strict JSON Schema cannot express.
- **Claude CvOutput:** `figmaFrameUrl: "x"` is a placeholder the prompt itself asked for ("use short placeholder strings").

The runner's repair prompt (§5.5) covers both cases.

### 2.2 Constraint keywords

Each probe used one small strict schema:

| Keyword | Codex strict mode | Claude `--json-schema` |
|---|---|---|
| `minimum` / `maximum` | ✅ accepted, enforced | ✅ |
| `minItems` / `maxItems` | ✅ accepted, enforced | ✅ |
| `pattern`, bounded (`^(EN\|VI)_v[0-9]+$`) | ✅ | ✅ |
| `pattern`, unbounded (`^.+_.+_(EN\|VI)_v\d+$`) | ⚠️ schema accepted, but the turn **never finished** (hung 300 s, and again 90 s) | not tried |
| `minLength` / `maxLength` / `format: date-time` | ✅ | ✅ |

**Decision (commit 215eb1d):** the converter now emits:
- `minimum`/`maximum`
- `exclusiveMinimum`/`exclusiveMaximum` (integers become inclusive ±1)
- `minItems`/`maxItems`
- `format: "date-time"`

Why:
- Both engines accept them.
- The change is about 25 lines.
- It moved the share of Zod-valid outputs from 1 of 8 to 7 of 8.

`pattern` stays out of the JSON Schema, and the strict-schema checker now rejects it (602f8ca), because a model cannot be stopped from producing an unbounded pattern that hangs Codex. The frame-name format moved into the field's `description` instead.

## 3. Defects found and fixed

| # | Defect | Fix | Commit |
|---|---|---|---|
| 1 | Strict JSON Schemas dropped every bound. Both models returned empty `selfCheck` arrays (7 of 8 schemas) and invalid datetimes, so each output would cost a repair prompt. | Emit the live-verified keywords. The subset validator checks them. The frame-name format goes in the description. | 215eb1d |
| 2 | Two `normalizeAnswerKey` implementations disagreed (shared kept a trailing `?` and full-width `：`), so the same form label gave two saved-answer keys. | One shared implementation; the DB re-exports it. | 76ea3f4 |
| 3 | DB enum literals drifted from shared. `cv_versions.language` was `EN`/`VI` (shared: `en`/`vi`). `rooms.kind` was `consult` (shared: `direct`). `steps.status` lacked `locked`/`paused`. `engine_state.reason` and `jobs.work_mode` had no CHECK. | `db/enums.ts` derives every list from shared. `enums.test.ts` reads the live CHECK constraints and fails on drift. Migration 0002. | 57762ec |
| 4 | Shared fields had no DB column: Job `workMode`/`injectionFlagged`; CvVersion `figmaFrameName`/`changeNotes`/`factRequests`; Run `searchProfileVersion`; Step `round`; Schedule `timezone`. | Columns added in 0002. Other fields are derived (see §5). | 57762ec |
| 5 | `jobs.url`/`canonical_url` were NOT NULL, so an uploaded JD with no posting found (§7.3b "no apply link found") could not be stored. | Columns are now nullable; such a job dedupes by hash. | 57762ec |
| 6 | `tasks.run_id`/`step_id` were NOT NULL and `claimNextTask` inner-joined runs, so consult (UC-25) and discussion (UC-15) tasks could not use the queue and its caps (§10.3). | Columns are now nullable; the claim uses a left join. Tested together with run pause and engine pause. | 57762ec |
| 7 | drizzle-kit's output for 0002 was broken. Its rebuild `INSERT … SELECT` listed columns that do not exist yet ("no such column", even on an empty DB). A CHECK reorder would also have rebuilt `applications` and silently dropped its three §9.1 triggers. | Hand-edited 0002 with a header that explains why, and legacy values mapped (`EN`→`en`, `consult`→`direct`). The shared status order is kept so `applications` is never rebuilt. | 57762ec |
| 8 | Migrations ran with foreign keys ON inside the migrator's transaction, where `PRAGMA foreign_keys=OFF` is a no-op. On a DB with data, a rebuild either failed (`jobs`) or cascade-deleted child rows (`rooms` → messages, `steps` → tasks). | `openDb()` turns foreign keys off around the migration, then runs `foreign_key_check`. `migrations.test.ts` upgrades a populated 0001 database and checks the data and triggers survive. | 57762ec |
| 9 | Repositories took loosely typed payloads that the shared schemas reject: QA scores as numbers, hard fails and fixes as strings, free-text pause and engine reasons, `TopCV` source keys, search-profile defaults with `TopCV`/`languages: []`. | Inputs are now the shared types (`JobCandidate`, `CvDraft`, `QaScores`, `PauseReason`, `CompanyProfile`, `SearchProfileFieldsBase`). Pause reasons are validated. Defaults come from shared. | 57762ec |
| 10 | UC-07 b was not enforced: QA `injectionSuspected` never flagged the job, and approvals ignored the flag. | `createQaReview` flags the job. `createApproval` refuses, and `checkApproval`/`consumeApproval` deny (`injection_flagged`), until `clearJobInjection`. | 57762ec |
| 11 | Nothing mapped DB rows to the shared types. | `db/mappers.ts`, plus a mapping test for every main table built from real repository output. | 6f7e97e |
| 12 | The events table could not be replayed as SSE. Recovery wrote an ad-hoc `task.interrupted` row with numeric ids. | `appendAppEvent` (validated with `AppEventSchema`) and `mappers.toAppEvent`. Recovery writes the shared `task.finished` with status `interrupted`. | ec99e86 |
| 13 | The web kept its own copies of shared values: status lists, the upload type/size rules, and Engine/TrustLevel/Room types. | Derived from shared, with drift tests. `lib/api/map.ts` maps BotView, EngineStatus, Room and AppEvent onto the shell view models. No visible change. | e5953a4, ec16096 |
| 14 | Three UI labels paraphrased the approved prototype: "Write “Negotiable / Thỏa thuận”", "Use a fixed amount", "Tech mismatch". | Labels pinned to the prototype copy. | e66c90d |
| 15 | The e2e config reused any server already on port 3100, so parallel worktree agents could test each other's code. | Reuse only with `E2E_REUSE=1`. | e88452a |
| 16 | The `API_ROUTES` comment said `localhost:4100`; the real default is 4318. | Comment fixed. | a77bf4d |

**Coordinator decisions implemented:**
- `jobs.injection_cleared_at` and shared `Job.injectionClearedAt` / `isApplyBlockedByInjection` (1578a89, 57762ec).
- A dry-run Apply is recorded as `needs_check`, with `dryRun: true` in shared `SubmissionRecord` and `submissions.dry_run = 1`. It can never be recorded as `submitted`, and the job is not marked applied (1578a89, 57762ec).
- `/chat/lead` redirects to `/chat`. This is a `next.config` redirect (307 before render, so the shell never flashes), and the sidebar's Lead entry links to `/chat`. Covered by e2e and unit tests (145ffde).
- `/dev/components` stays reachable but is not linked: an e2e test checks 12 screens for `a[href^="/dev"]` (145ffde).

## 4. Tests added: 103

| Package | Before → after | Added | What they cover |
|---|---|---|---|
| shared | 248 → 277 | 29 | converter bounds and formats, the validator, frame-name description, no `pattern` in bot schemas or the checker, injection clearance, dryRun, answer keys, prototype labels |
| orchestrator | 104 → 157 | 53 | enum drift (CHECK constraints vs shared), limits, upgrading a populated database, mapping per table, null-URL jobs, injection flag/clear/approval denial, dry run, consult tasks in the queue, validated pause reasons, step round and statuses, timezone, AppEvent replay |
| web | 68 → 87 | 19 | redirect config, `botChatHref`, Lead link, no `/dev` links, status lists and labels from shared, view-model and AppEvent mappers, upload rules vs `checkUploadFile` |
| e2e | 35 → 37 | 2 | `/chat/lead` redirect; no screen links to `/dev/components` |

## 5. Spec coverage notes

- **§5.1 bot.json:** schema complete; the spec example parses. W1a deviation, kept: `outputSchema` may be a map per task kind (the spec's `ResearchOutput` name does not exist; Research has three outputs).
- **§5.2 outputs:** all five bots plus ConsultOutput match the spec fields, including hard-fail codes, the pass rule, field sources, pending questions and the factIds rule. Live-verified on both engines (§2).
- **§5.3–5.4:** trust labels; `canPromote` keeps Apply disabled (UC-19); memoryNotes max 3 (now also enforced by the engine via `maxItems`).
- **§5.5:** one converter feeds both engines. The startup checker rejects `$ref`, combinators and `pattern`.
- **§7:**
  - Step types, the three workflows, params and overrides.
  - Schedules: cron with 5 fields; `repeatToCron`; the timezone is now persisted.
  - Search profile fields, defaults and UC-21b validation.
- **§9:** every table and column, with these extras:
  - `tasks.uses_browser`/`uses_figma`
  - `runs.schedule_id`/`search_profile_version`/`error`
  - `steps.round`
  - `jobs.work_mode`/`posted_at`/`injection_*`
  - `cv_versions.figma_frame_name`/`pdf_sha256`/`change_notes_json`/`fact_requests_json`
  - `approvals.created_at`
  - `applications.reapply`
  - `submissions.dry_run`
  - `schedules.timezone`
- **Fields derived rather than stored** (documented in `db/mappers.ts`):
  - `Job.company`: joined from `companies`.
  - `Step.branchKey`: `''` maps to null.
  - `Task.pauseReason`: parsed from `code(site)`.
  - Message author, mode (from the room kind), uploadIds and cards (`meta_json.cards`).
  - `Room.members`.
  - `SubmissionRecord.approval`: from the approvals row.
  - `SubmissionRecord.jdSnapshot`: null when an imported snapshot is incomplete.
- **§9.1:** one transaction, immutability triggers (survive 0002, tested), append-only status history, single-use tokens.
- **§10.2 data rules:** rules 1–2 (token, domain), 4 (injection, now enforced in the DB), 5 (one application per job, unless reapply) and 8 (audit log replayable as SSE).
- **§11:** components, shell, layout rule, file viewer and cursor rule are covered by W1c's e2e suite (reviewed: Select keyboard and click-outside, Slider, Checkbox/Switch, NumberInput, menus not clipped, viewer, cursor, no native controls, light/dark screenshots). No defects found beyond §3.
- **§12:** the "Output formats" and "UI own components" rows are covered. The repair-prompt path belongs to the Phase 2 runner.

## 6. Remaining risks and open items for the PM

1. **Dry run vs one application per job.**
   - What happens now: a dry run leaves an application in `needs_check` plus a frozen record.
   - The problem: a later real submission needs Ba to mark the dry run `failed` and use "apply again" (`reapply`).
   - To decide: should dry runs stay outside the one-per-job index (for example, `applications.dry_run`)?
2. **§9.1 SHA-256 mismatch abort is not enforced in the data layer.**
   - `recordSubmission` does not compare `uploaded_sha256` with the approved `cv_versions.pdf_sha256`.
   - W2a/W2c must check before upload (§12 integration row). A DB-level guard is worth considering.
3. **Some SQL columns stay nullable although the domain always fills them.**
   - Which: `jobs.language`, CV `tailored`/frame name/versions, `tasks.prompt_version` (old rows).
   - How they are protected: required repository input types and the mapping tests, not NOT NULL (this avoided further table rebuilds).
   - In mappers, NULL becomes an invalid placeholder, so parsing fails loudly.
4. **Future migrations need a manual review.** drizzle-kit table rebuilds list new columns in `INSERT … SELECT`, and rebuilding `applications`/`submissions`/`job_snapshots`/`approvals` drops their triggers. The 0002 header explains this; worth a line in the W2 briefs.
5. **The shared package gained a `default` export condition.** drizzle-kit loads the DB schema through CommonJS, and that now needs Node ≥ 22.12 (`require(esm)`). `.nvmrc` says `22`, and the machine has 22.17.
6. **The prototype and the spec word the salary-rule options differently.** I followed the prototype (phases.md: approved copy). PM to confirm.
7. **W1c added a sidebar "Manage" link to `/bots`.** The prototype reaches Bots through ⚙ only, so this is a deliberate W1c addition.
8. **The spec diagram says the orchestrator runs on port 4100; the code uses 4318.** A spec or README alignment is pending.
9. **Turbo cache and e2e servers are shared across worktrees.** Run checks with `--force` and set a per-worktree `E2E_PORT` when several agents verify in parallel.

## 7. Handoffs to Phase 2

- **W2b runner:**
  - Use `getBotOutputJsonSchema` (it now includes bounds) for both engines.
  - Call `assertStrictJsonSchema` at startup.
  - Run `parseBotOutput` on every result and expect repairs only for cross-field rules and URL/pattern placeholders.
- **W2a engine:**
  - `createTask` requires `promptVersion`, and consult/discussion tasks pass `runId: null`.
  - `pauseTask` takes a shared `PauseReason`.
  - `pauseEngine` takes `usage_limit | manual`.
  - Use `appendAppEvent` for everything the UI shows, and `mappers.*` for API/SSE payloads.
  - `recordSubmission({ dryRun })` handles the dry run.
  - `createApproval` throws while a job's injection flag is not cleared, and `clearJobInjection` records Ba's confirmation.
- **W3:**
  - `lib/api/map.ts` (`toBotSummary`, `toEngineUsage`, `toRoomSummary`, `toShellEvent`) is ready for `subscribeShellEvents`.
  - `db/mappers.ts` covers every API record.
