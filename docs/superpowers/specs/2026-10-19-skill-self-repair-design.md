# Skill self-repair: source skills that fix themselves, and a safe answer when a board's API changes

- **Date:** 2026-10-19
- **Status:** Draft, awaiting owner review
- **Owner:** Ba Huynh
- **Scope:** sub-project 4 of 4 from the request in `.vtc/runs/r20261018-074219/request.md`. It builds on sub-project 1 (API research: access paths, `accessPathOf`, the browser fallback and notices) and on the Activity screen built in sub-project 3 (CV guidance).
- **Reference material (reused, not driven):** the approved VTC spec `.vtc/spec/spec.md` (goal G2: REQ-8 to REQ-13), AD-7 and AD-8 in `.vtc/architecture/spine.md`, SEC-9 to SEC-14 in `.vtc/architecture/threat-model/threat-model.md`, and the designs `.vtc/design/screens/{activity,scan-notices}.md`, components `activity-entry`, `skill-diff`, `scan-notice`, prototypes `.vtc/design/prototype/activity/` and `.vtc/design/prototype/chat/lead/`. This work is done directly, not through the VTC engine. Where this document and those files disagree, this document wins. The differences are listed in §9.

---

## 1. Intent

### 1.1 Why
When a board changes its page layout, the Research bot reports "Layout changed", the checker fails the scan as "adapter broken", and that board yields no jobs until someone rewrites `bots/research/skills/source-<board>/SKILL.md`. Ba asked for "auto update all things, no need human to update skill".

After sub-project 1, fewer boards are read through the browser, but not none:
- boards with no usable API
- risky boards Ba has not approved
- `career_site`
- **every API board on a run where its API path falls back to the browser** (token missing or rejected, or the API changed)

The last group matters most. A skill that is rarely used goes stale, and it is needed exactly when the API fails.

### 1.2 What success looks like
1. A browser scan that fails as "adapter broken" starts one automatic repair: draft a new skill, screen it, validate it with a real scan, adopt it. Ba edits nothing.
2. A bad, hostile or useless draft is never adopted. The previous skill stays, and Ba is told in two lines what broke and why the repair failed.
3. Every attempt is in the Activity log with the old and new skill text side by side, and Ba can restore the previous skill in one click.
4. Only `bots/research/skills/source-<board>/SKILL.md` ever changes. Adopting never puts the orchestrator into degraded start.
5. When a board's **API** changes, the scan still returns jobs that run (through the browser), Ba gets one notice, and the API path is used again automatically once it works. No access record or mapper code is ever changed by the system.
6. Repairs are capped. A board that stays broken stops costing quota after 3 failed attempts.

## 2. Goals, non-goals, anti-goals

### Goals
- **G1. Trigger.** Only a `research.scan` that fails for good as `adapter broken: …` on a browser-path task (including fallback tasks) starts a repair. Transient failures, blocks (login wall, CAPTCHA) and API-path failures never start one. Single-flight per source. (REQ-8, AD-7.)
- **G2. Draft, screen, validate, adopt.** A `research.repair` task drafts the skill, a pure screen checks it, a validation scan with the draft must pass the self-check, the `ScanOutputChecker` and return at least 1 job, and then the orchestrator writes the file. (REQ-9, SEC-9, SEC-11.)
- **G3. Narrow write.** One writer (`SkillStore`) that can only write `bots/research/skills/source-<source>/SKILL.md`, atomically, with no symlinks. Proposed changes elsewhere are listed as "not applied". (REQ-13, SEC-10.)
- **G4. Visible and reversible.** One Activity entry per attempt, written before the file is replaced, with the previous and new text. "Restore previous skill" on the latest adopted entry. (REQ-11, SEC-14, OQ-3.)
- **G5. No degraded start.** Skills stay outside the prompt lock. (REQ-12, AD-8, SEC-12.)
- **G6. Capped.** Pause after 3 consecutive non-adopted attempts for a source, until a scan of it succeeds or Ba asks for a retry. (SEC-13.)
- **G7. API changed: fall back, tell, recover.** A new `api_changed` failure on public-API and account-API paths falls back to the browser for that run, posts one notice, and is retried on the API first next run.

### Non-goals
- Changing `ROLE.md`, `bot.json`, workflows, allowed sites, allowed tools or the prompt lock automatically (NG5, OQ-4, §6).
- Re-researching API endpoints, or editing access records or mapper code, automatically (§5.8).
- Repairing the Apply bot, CV bot or any other bot's skills. Only Research has source skills today.
- Repairing a board whose site moved to a new domain. That needs a new allowed site, which is a developer change. The attempt ends "not adopted" and says so.
- Committing to git. The app never runs git.

### Anti-goals (a failure even if it "works")
- An adopted skill tells the bot to visit another host, use another tool, ignore its role, or send page data anywhere.
- A draft that "passes" by returning zero jobs, or a self-report of success, quietly disables a board.
- Two repairs race on one board, or a broken board burns Claude quota and Chrome time every run.
- Ba cannot see what changed in a skill, or cannot undo it.
- The prompt lock is regenerated or weakened so that adoption "works".
- The system starts watching network traffic in Ba's logged-in session to rediscover API endpoints, where cookies and tokens are visible.

## 3. Constraints
- Single user, local Mac, subscription CLIs. One Chrome, shared by every browser task. Same stack and Turborepo note as sub-project 1.
- The Research bot's `allowedTools` (`read`, `web_search`, `chrome:read`, `skill:source-*`) and the Chrome site guard (`allowedSites`) are the runtime limit for any skill text. A skill cannot widen them.
- The skill files live in the repo, under `bots/research/skills/`. They are read by the bot from its bot folder (`runner/prompt.ts` `skillLine`).
- The `ScanOutputChecker` (`apps/orchestrator/src/adapters/checker.ts`) depends on the skill's exact `Layout changed: …` and `No results: …` notes. A draft must keep them.
- Changing `bots/research/ROLE.md` needs a `promptVersion` bump and `bots:lock`. This is the third bump in a row after sub-projects 1 and 3, so the builder takes the current number.

## 4. Decided by Ba (earlier answers, carried over)
1. Skills update themselves with no human editing. (Request; G2 of the spec.)
2. Risky boards' API paths need Ba's approval, which lapses when the record is re-researched. (Sub-project 1, decision 2.)
3. When an account API token is missing or rejected, scan through the browser this time and tell Ba. (Sub-project 1, decision 3.) This design extends the same idea to a changed API.

## 5. How it works

### 5.1 Trigger and single-flight: `apps/orchestrator/src/engine/skill-repair.ts`
- In the transaction that fails a `research.scan` task for good with an `adapter broken: …` error (`engine/scan-check.ts` `adapterBrokenError`), and only when that task ran on the browser path:
  - it inserts a `skill_repairs` row (`source`, `trigger` = the reason, `status: drafting`, `taskId` of the failed scan, `createdAt`)
  - a unique partial index on `skill_repairs(source)` for active statuses (`drafting`, `validating`) makes a second trigger a no-op (REQ-8.AC-3)
- No row is created when:
  - the failure is `scan failed` or `scan output rejected`, or the output is `blocked` (REQ-8.AC-2)
  - the source is paused (§5.6)
  - there were already 2 attempts for that source in the last 24 hours
  - another repair is running for any source. It is queued instead: one repair at a time overall, because Chrome is shared.

  *(Leader's call — Ba can override.)*
- Repairs run in the background, not as part of the run. They are queued behind the current run's browser tasks so they never slow a scan in progress. The failed branch has already been reported as today ("<Source> adapter broken: <reason>").

### 5.2 Draft: the `research.repair` task
- New Research kind `repair` in `bots/research/bot.json`: `outputSchema.repair: "ResearchRepairOutput"`, `selfCheckByKind.repair`. It has the **same Chrome read tools and site guard as a scan**, plus `read` for the current skill. There is no `web_search`, no write, no shell. A `## Repairing a source skill (task repair)` section is added in `ROLE.md`.
- Input:
  - the source key, the current skill text, the failure reason and screenshot path from the failed scan
  - the search URL the code builds (`adapters/sources.ts` `searchUrls`)
  - the checker's required notes and the source's limits (job limit, page views, delays)
- The bot opens the listing and one job page read-only, compares them with the skill, and returns `{ skillMd, otherChanges[{ file, change }], notes }`. `otherChanges` is where it says what it could not do, such as "new allowed site topcv.com.vn".
- The draft is stored in the `skill_repairs` row. It is never written to disk before adoption.
- **Why the repair task has Chrome:** SEC-9.AC-3 asks for a tool-less drafting task fed with captured page text. That needs either a separate capture task (one more Chrome session, so more cost) or relying on the failed scan's transcript, which stops at the first missing element and often lacks the job page. A scan already reads the same hostile pages with the same tools, and the draft's only output is text that is screened by code (§5.3), validated by a real scan (§5.4), and still bounded at run time by the site guard and tool grant. *(Leader's call — Ba can override.)*

### 5.3 Screen: `packages/shared/src/skills/screen.ts` → `screenSkillDraft(draft, ctx)`
Pure, no I/O. `ctx` holds the source, its registered hosts, Research's `allowedTools`, the current skill and the checker's note formats. It rejects a draft with a reason when:
- it is larger than 20 KiB, or has no front matter with `name: source-<dir>` and a `description:`
- it lacks "Read-only", or drops the backticked `Layout changed: …` or `No results: …` notes in the form the checker reads
- it names a URL or host outside the source's registered hosts (`SOURCE_ADAPTERS` and the access record's hosts) (SEC-9.AC-1)
- it names a tool outside `allowedTools`, or tells the bot to log in, click apply, save, follow, message, solve a CAPTCHA, or ignore, replace or skip `ROLE.md` or the output schema (SEC-9.AC-2)
- it contains a secret-like value (the sub-project 1 redactor patterns)
- it raises a limit above the code's (job limit, LinkedIn page views, the 3–8 s delay range for Wellfound and Upwork)

The same function runs in CI over every committed skill (§8). So the runtime screen and the repo tests are one rule set.

### 5.4 Validate
- A `research.scan` for the source, with the failed scan's criteria, `runId: null`, and a new task-input field `skillOverride: { repairId }`. The prompt builder (`runner/prompt.ts`) puts the draft text in the prompt as the skill, marked as the skill to follow, and does not point the bot at the file.
- **Adopt only if** the output passes schema and self-check, the `ScanOutputChecker` returns `ok`, `blocked` is null, and **at least 1 job** came back (REQ-9, SEC-11). The decision comes from the orchestrator's checks, never from the repair task's notes (SEC-11.AC-1).
- The validation scan's jobs are **discarded**. The next scheduled or manual scan finds them through the normal dedupe. *(Leader's call: merging them into a run that already moved on adds complexity for a few jobs.)*

### 5.5 Adopt: `apps/orchestrator/src/adapters/skill-store/`
- The only writer of skill files (AD-7 import check). `SkillStore.write(source, text)`:
  - builds the path from the source key
  - resolves it with `realpath`
  - requires it to equal `<repo>/bots/research/skills/source-<dir>/SKILL.md` for an existing directory, with no symlink anywhere on the path (SEC-10)
  - writes to a temp file in the same directory, then renames
- **Order (SEC-14):**
  1. write the Activity event `skill_repair.adopted`, with source, time, trigger, previous text (read from disk now), new text and the "not applied" list
  2. then replace the file
  3. if the replace throws, append `skill_repair.not_adopted` with the reason; the file is unchanged
- `otherChanges` are never applied. They appear under "Not applied" with the file name (REQ-13.AC-2).
- The module never names `bot.json`, `ROLE.md`, `prompt-versions.json`, `workflows/` or `allowedSites` (AD-7 forbidden-pattern check).
- **Git:** the app never commits. The adopted skill is an uncommitted change in Ba's working tree. The Activity entry shows the file path. The next developer session commits it, and `docs/runbook.md` gets a short section saying so, including what to do if `git pull` reports a conflict on a skill file. *(Leader's call: auto-committing from a running app could interfere with Ba's own branch work.)*

### 5.6 Failure, pause and notices: `engine/notices.ts`
- **Not adopted** (screen, validation, or write failed): the event `skill_repair.not_adopted` with the reason, and Lead posts "Automatic repair failed: <reason>" as the line after the existing "<Source> adapter broken: <reason>" notice (REQ-10). Later scans use the previous skill.
- **Adopted:** Lead posts "Automatic repair worked: <Source>'s skill was updated and passed a validation scan. Next scans use it." *(Leader's call: the spec posts nothing on success, but Ba asked for automatic updates and should know one happened. One line.)*
- **Pause (SEC-13):** after 3 consecutive non-adopted attempts for a source, `skill_repairs` records `paused`. The next adapter-broken failure posts "Automatic repair for <Source> is paused after 3 failed attempts. Scans keep the previous skill." with the action "Open the activity log". It un-pauses after a successful scan of that source, or when Ba presses "Try repair again" on the Activity screen (route under Origin and CSRF).

### 5.7 Restore previous (OQ-3)
- The latest adopted entry for a source has "Restore previous skill" when the file on disk still equals that entry's new text. It writes the previous text through `SkillStore`, logs `skill_repair.restored`, and the source's next adapter-broken failure may repair again as normal.
- No restore is offered on older entries, or after a developer edited the file. *(Leader's call — Ba can override.)*

### 5.8 The API path: when an endpoint or mapper breaks
Sub-project 1 classifies 401 and 403 as `AuthRejected` (fall back to the browser) and 429, 5xx and timeouts as transient (fail the branch, no fallback). This adds a third class, **`ApiChanged`**, in `apps/orchestrator/src/adapters/board-api/`:
- 404 or 410 on an endpoint listed in the record, or
- a 2xx response the mapper's Zod schema rejects, or
- a list response with one or more items from which the mapper yields 0 valid postings.

On `ApiChanged`:
1. **Fall back to the browser for this run**, using the same mechanism as a rejected token: discard the API jobs, queue a browser `research.scan` for the same source, and mark the API task superseded.
2. Record per-source **API health** in SQLite (`brokenSince`, `lastReason` with method, host and path only, never the query or headers).
3. Post the notice **once, when it turns broken**: "<Source> API changed: <reason>. Scanned through the browser this time; scans use the browser until the API works again." Post again **once when it recovers**: "<Source> API works again; scans are back on the API." Also add an Activity entry "API changed" (and "API recovered").
4. **Each later run tries the API first.** A broken endpoint fails on its first request, so the cost is one request per run. Recovery is automatic when the board reverts or the record is fixed.
5. If the fallback browser scan reports "adapter broken" (the rarely used skill went stale), the normal skill repair in §5.1 runs. This is where skill repair and the API path meet.

**Re-researching endpoints is not automated.** *(Leader's call — Ba can override.)* The reasons:
- A new endpoint usually needs a new or changed **mapper**, which is TypeScript in the orchestrator. Adopting generated code is a different risk class from a screened prompt file. It needs a developer, tests and fixtures.
- For risky boards the record is **Ba-approved**, and sub-project 1 lapses the approval when the record is re-researched. An automatic re-research would only end in "needs approval", so it saves Ba nothing.
- Finding internal endpoints means reading network traffic in Ba's logged-in Chrome, where cookies and CSRF values are visible. Giving that to a bot on every API change conflicts with SEC-1 and SEC-4.
- The browser fallback, backed by the self-repairing skill, already keeps the board scanned with zero work from Ba. The only cost is the browser scan until a developer re-runs the §5.5 research of sub-project 1.

A possible later step (not in scope): during the fallback scan, record the job-related GET paths the page calls (method, host and path only) as an "endpoint drift report" on the Activity entry, to speed up the developer's re-research.

## 6. Open questions resolved here
- **OQ-4 ("auto update all things": `ROLE.md`, workflows, bot config):** No. These define what each bot may do (tools, sites, schemas, hard fails), and the prompt lock exists to make changes to them deliberate. "All things" is covered by:
  - skills (this design)
  - bot memory (already self-updating)
  - master facts (sub-project 2, derived facts)
  - CV guidance (sub-project 3)
  - the API path's automatic fallback and recovery (§5.8)

  A repair that needs a config change says so under "Not applied". *(Leader's call — Ba can override.)*
- **OQ-3 (revert), for skills:** yes, "Restore previous skill" on the latest adopted entry (§5.7). *(Leader's call — Ba can override.)*
- **OQ-6 (caps), this sub-project's part:**
  - per source: one active repair, at most 2 attempts in 24 hours, a pause after 3 consecutive failures
  - overall: one repair at a time
  - each attempt costs at most 2 Claude sessions with Chrome (repair and validation), each within the Research timeout of 600 s
  - the API health probe adds at most 1 request per run per broken board

  *(Leader's call — Ba can override.)*

## 7. UI states
In the existing shell and tokens; the VTC designs are reference.
- **Activity (`/activity`, built in sub-project 3)** gains skill-repair entries:
  - **Repairing:** the source, the trigger reason, and "Drafting a new skill" or "Validation scan running". No diff yet. A second failure adds no second entry.
  - **Adopted:** badge "Adopted", source, time, reason. Expanded, it shows the `skill-diff` (previous and new, with "-" and "+" signs, side by side from 1024 px), "Not applied" items with file names, the line "Only bots/research/skills/source-<dir>/SKILL.md changed. This change is not committed to git yet.", and "Restore previous skill" when allowed.
  - **Not adopted:** "Not adopted. The skill text is unchanged." plus the reason (screen rule, validation result or write error). The diff is shown when a draft exists, so Ba can see what was tried.
  - **Restored:** "Restored the previous skill" with the diff reversed.
  - **Paused:** "Automatic repair paused after 3 failed attempts", with "Try repair again".
  - **API changed / API recovered:** source, time, method, host and path, and the reason. No diff.
  - The page states, under the heading, that adopted changes do not put the research bot into degraded start (REQ-12).
  - Empty, loading and error: as in the design.
- **Lead chat notices:** the adapter-broken pair, adopted, paused, API changed and API recovered, each with one "What you can do" line: "Nothing; later scans use it", "Open the activity log", or "Nothing; the browser is used until the API works again". Token values never appear.

## 8. Test strategy
vitest, following the repo's conventions.
- `packages/shared/src/skills/screen.test.ts`: SEC-9.AC-1/AC-2, each rejection rule, and a valid draft passing.
- **`apps/orchestrator/src/adapters/skills.test.ts` is changed.** It runs `screenSkillDraft` over every committed skill, and keeps the city-code and LinkedIn-limit assertions.
  - Removed: "names the card and JD selectors the parser uses" and the `observed 2026-10` match.
  - Why: they tie skill text to the developer-time parsers in `adapters/parsers/`, which is exactly what a self-repair changes. So an adopted repair would fail CI. The parsers keep their own fixture tests (`parsers.test.ts`).
  - *(Leader's call: flagged for review because it loosens an existing test.)*
- `apps/orchestrator/src/engine/skill-repair.test.ts`:
  - REQ-8.AC-1 to AC-3: one attempt only, none for transient or blocked failures, none for an API-path failure
  - REQ-9.AC-1/AC-2
  - REQ-10.AC-1: both notice lines
  - REQ-11.AC-1/AC-2
  - REQ-13.AC-1/AC-2: a file diff before and after touches only `source-topcv/SKILL.md`, and `bot.json` is byte-identical
  - SEC-11.AC-1/AC-2: a self-reported "validated" is ignored; 0 jobs is not adopted
  - SEC-13.AC-1/AC-2
  - the 24 h cap, and one repair at a time
- `apps/orchestrator/src/adapters/skill-store/*.test.ts`: SEC-10.AC-1 to AC-3 (`..` path, symlink, only the one file); SEC-14.AC-1/AC-2 (an injected failure between log and write).
- `apps/orchestrator/src/runner/prompt-lock.test.ts`: change a `SKILL.md` on a temp bots directory, and there is no degraded start (REQ-12.AC-1, SEC-12.AC-2). SEC-12.AC-1 still trips on a `ROLE.md` edit.
- `apps/orchestrator/src/runner/prompt.test.ts`: `skillOverride` puts the draft in the prompt and the file line is dropped.
- Board-API (`apps/orchestrator/src/adapters/board-api/*.test.ts`, from sub-project 1, extended):
  - 404, a schema mismatch, and items with 0 valid postings are each `ApiChanged`
  - fallback queues a browser scan
  - the notice is posted once when it turns broken and once on recovery
  - the next run tries the API first
  - the reason holds no query or headers
- Route tests: SEC-19.AC-1 for "Try repair again" and "Restore previous skill".
- Web: activity-entry and skill-diff component tests for every state above. Screenshots for the PR.
- **Live check (QA):** a staged layout change. Point a validation run at the existing `topcv-listing.layout-changed.html` fixture through a test double, then run one real repair on a board whose skill is deliberately broken on a scratch branch. The PR shows the Activity entry and diff, and that the next scan used the new skill. No live check sends anything to a `high`-risk board that Ba has not approved.

## 9. Differences from the VTC spec and architecture
| VTC item | Here |
|---|---|
| SEC-9.AC-3: the repair task holds no `chrome:` tool | The repair task has the scan's Chrome read tools and site guard; the code screen and validation scan are the controls (§5.2) |
| Spec §6: nothing on a successful repair | One "Automatic repair worked" line (§5.6) |
| OQ-3 open; the design has no revert | "Restore previous skill" on the latest adopted entry (§5.7) |
| Spec §9: "automatic repair of account API paths" out of scope | Still no automatic re-research. Adds an `ApiChanged` fallback to the browser, notices and automatic recovery (§5.8) |
| Not in spec | Caps: 2 attempts per source per 24 h, one repair at a time (§5.1) |
| Not in spec | `skills.test.ts` drops the parser-selector coupling and runs the shared screen instead (§8) |
| AD-7: the validation scan result is not described further | Validation jobs are discarded, and at least 1 job is required (§5.4) |

## 10. Left to the builder
- The `skill_repairs` table shape and statuses, and the API-health storage.
- How `skillOverride` reaches the prompt builder (a task-input field is suggested).
- The queue priority mechanism that keeps repairs behind the run's browser tasks.
- The exact deny-list phrases in `screenSkillDraft`, table-tested.
- The wording of the `ROLE.md` repair section, within §5.2.
- How the live check stages a broken skill without touching Ba's real working tree.
- Test layout.
