# PM review: Phase 4 (final integration) and Phase 1 hand-off

- **Reviewed:** `develop` at f1d6fec (W4a, W4b, W4c, F4 parts A and B, and the Phase 4 QA/QC fixes), in worktree branch `worktree-agent-ac0904493f84a81ab`.
- **Read:**
  - the spec, `stage0-prototype.html`, phases.md, progress.md, owner-decisions.md;
  - pm-phase-1/2/3.md, qa-phase-4.md, the three Phase 4 reports, `docs/runbook.md` and README;
  - the code behind every prior must-fix item and every link of the safety chain (§3, §4).
- **Re-ran, all uncached:**

  | Check | Result |
  |---|---|
  | `pnpm install` | ✅ |
  | `pnpm -w typecheck --force` | ✅ 4/4 |
  | `pnpm -w lint --force` | ✅ 4/4 |
  | `pnpm -w test --force` | ✅ 2,692 tests (shared 392, web 494, orchestrator 1,806), 0 cached |
  | `pnpm e2e` (mock lane, `E2E_PORT=3517`) | ✅ 151/151 |
  | `pnpm e2e:live-shape` (web 3617, orchestrator 4617, control 4618) | ✅ 12/12 |

  The QA numbers hold.
- **Not run, by instruction:** no live bot, scan, Chrome or Figma. I made one read-only Turbo dry run (`turbo run dev --dry=json`) to check which environment variables reach the dev tasks (SF-1).

## 1. Verdict

**Ready for Ba's live checks and the dry run: yes.** There is no must-fix item.

- **All 13 must-fix items** from pm-phase-1, -2 and -3 have landed. Each has code and tests behind it (§5).
- **The safety chain holds end to end** in code and tests (§3):
  1. approval token → Apply → record;
  2. the site guard;
  3. the Figma guard and fingerprint;
  4. untrusted content;
  5. the dry-run gate;
  6. Lead on Claude only;
  7. the Origin/CSRF checks;
  8. the per-spawn MCP capability.
- **Every way it can fail goes the safe way:**
  - a doubtful Apply ends in `needs_check`;
  - a missing screenshot means `needs_check`, never a clean record;
  - a bad start-up goes to degraded mode with the reason shown;
  - a live approval before any dry run is refused.
- **What is left needs a person,** and it is in the right order in the runbook:
  - checks 1–4 (Claude in Chrome, the screenshot capture shape, tab cleanup, the Figma export);
  - the dry run;
  - the first live application;
  - the first scheduled scan.
- **Two small should-fix items** are worth doing early. Neither blocks the live checks or the dry run:
  - SF-1, before the dry run: Turbo drops `BSJA_API_MODE`;
  - SF-2, before the first live submission: narrow the dry-run gate.

### §1.2 success criteria

| # | Criterion | Automated | Live |
|---|---|---|---|
| 1 | A scheduled scan gives a review card (job, company, CV, QA ≥ 80) without Ba | ✅ `engine/scheduler.test.ts` (strengthened by QA4: QA passed, company present, nothing sent to Apply), `engine/job-scan.test.ts`, live-shape `lead-features.spec.ts` | **Needs Ba:** runbook §8 step 9 (added in this commit) |
| 2 | Approve → confirmed submission → record with link, CV version and confirmation screenshot | ✅ `engine/job-scan.test.ts`, `apply.test.ts`, `record-files.test.ts`, `dry-run-live.test.ts`; live-shape `review-apply.spec.ts` | **Needs Ba:** runbook §8 steps 1–8 |
| 3 | An automated test proves nothing is submitted without Ba's approval | ✅ `engine/apply.test.ts` "nothing is submitted without Ba's approval" (forged task, Apply at L2 in the DB and in bot.json), `trust-guard.test.ts`, `security-routes.test.ts`, `dry-run-gate.test.ts` | n/a |
| 4 | A usage limit pauses, then resumes by itself after the reset | ✅ `engine/usage.test.ts`, `runner/usage.test.ts`; live-shape UC-16 | Only when a real limit happens. The parsers use the spikes' captured shapes. |

### The six core rules

| # | Rule | Holds? | How |
|---|---|---|---|
| 1 | One manager receives every request | ✅ | Consult and room sessions get no tools (`conversationPlan`). A work request is handed to Lead with Ba's own words (UC-25 a). |
| 2 | One name, role and memory per bot | ✅ | One folder per bot. The orchestrator appends memory one note at a time, keeps it out of git and filters it for hygiene (PM2 S5, S14). Ba can delete notes on the Bots screen. |
| 3 | Repeated work becomes a workflow | ✅ (Phase 1 meaning) | `propose_workflow` saves a preset (base workflow + params) when Ba approves it. Lead starts it by name (PM3 S4). |
| 4 | Bots check their own work | ✅ | `selfCheck`/`selfCheckByKind` in every bot.json. The runner fails an attempt with any failed item. |
| 5 | Lead only divides work | ✅ | Claude only: shared rule, API 403 and degraded start. Exactly six orchestrator tools through a per-spawn capability. `create_task` is limited to `research.*`. No approve or answer tool. |
| 6 | Permissions step by step | ✅ | Apply is at L1, and promotion to L2 is locked in Phase 1. The trust guard keys on `apply.submit` whatever the level. Automatic demotion (PM2 S8). Only Ba restores a level. |

## 2. MUST-FIX

**None.**

## 3. Safety chain, end to end

| Link | What enforces it | Evidence | Residual |
|---|---|---|---|
| **Approval token → Apply → record** | Approve creates the application, its bound token and the `apply.submit` task in one transaction (24 h, single use).<br>The token is consumed at the first spawn; a resume re-validates it with `checkApprovalForResume`.<br>The approved PDF is copied to `data/applications/<id>/` and re-hashed before the spawn; that folder is Apply's only read directory, plus a per-task copy of `master-cv.yaml`.<br>The token is never in a prompt, transcript, API response, SSE event or the export.<br>`recordSubmission` refuses a missing, unused or mismatched token or SHA-256 (`needs_check` + `safety.denied`). A trigger enforces the same.<br>The record cites only screenshots the runner captured.<br>Apply is never retried. | `db/repos/applications.ts` l.313–330, `db/repos/approvals.ts` l.278, `engine/trust-guard.ts` l.89, `engine/apply.ts` (copy, re-hash, `SCREENSHOTS_NOT_CAPTURED`); tests `apply.test.ts`, `trust-guard.test.ts`, `record-files.test.ts`, `approvals.test.ts`, `schema-guard.test.ts` | The screenshot block shape is still a synthetic fixture until check 2. If the real shape differs, every Apply ends `needs_check`. That is a safe failure. |
| **Site guard** | A PreToolUse hook on `navigate` (and on `javascript_tool` code; Apply has no `javascript_tool`).<br>One host rule based on the Public Suffix List (`tldts` 7.4.18, pinned) refuses public suffixes, IPs, `localhost` and private ranges.<br>`domain_confirm` is offered only for a host the guard actually blocked.<br>A guard block fails the task without a retry and demotes the bot.<br>After the task, `finalUrl` and every page URL Apply saw are checked against the approval's domains (PM2 S10). | `shared/src/common/host.ts` + `host.test.ts`; `engine/queue.ts` l.605–636; `bridges/chrome/site-guard/*`; `engine/apply-pages.test.ts`, `demotion.test.ts` | A click that leaves the site is not a `navigate` call. It is caught after the fact (S10) and by the extension's own site permissions (runbook check 1). Owner FYI from PM2. |
| **Figma guard + fingerprint** | CV runs on Claude only and sees 3 Figma tools (`knownTools`).<br>The hook rejects code that names a page other than Drafts.<br>Before and after each CV task, the protected pages are fingerprinted, including their visual properties (S9); the "before" hash is persisted (S4).<br>One CV task uses Figma at a time.<br>The orchestrator, not the bot, exports the PDF and checks it is one A4 page. | `bridges/figma/{guard,fingerprint,plugin-code}.ts` + tests; `engine/queue.test.ts` | Live export not yet run (check 4). |
| **Untrusted content** | Every fetched or bot-made field goes into an `UNTRUSTED_CONTENT` block (`UNTRUSTED_INPUT_FIELDS`), including Apply's `jobUrl`/`answers`/`savedAnswers`, QA's `fixes` and Lead's `history`/`handoff`.<br>QA, Research and Apply report injections. A flagged job cannot be approved until Ba confirms it (an audited event). | `runner/prompt.ts` l.47–58 + `prompt.test.ts`; `engine/injection-reports.test.ts` | Whether a model actually ignores an injection is model behaviour. Only the flag path is proven (backlog B1). |
| **Dry-run gate** | `engine.approve` refuses a live approval (409 `dry_run_required`) until a dry run has settled or the app has made a live application. It is on in production. | `engine/dry-run-gate.test.ts`, `production-wiring.test.ts`; live-shape §12 test | "Settled" includes a dry run whose Apply failed (SF-2). That Apply never clicks submit in a dry run is prompt-only (pm-phase-1 FYI e), so run it on a job you want anyway. |
| **Lead on Claude only** | `checkBotSafety` (`LEAD_ENGINE_RULE`), so bot.json loading, `PATCH /bots/lead` and start-up all refuse Codex. The Bots screen says "Locked to Claude". | `shared/src/bots/definition.ts` l.117–154; `api/boot/start.test.ts` l.147; live-shape `bots.spec.ts` | none |
| **Origin / CSRF** | Every POST/PUT/PATCH/DELETE needs one of `ORCH_WEB_ORIGINS` plus the CSRF header; a missing Origin is a 403.<br>Host and Sec-Fetch checks, no CORS headers.<br>The web proxy returns 404 for any non-loopback Host. | `api/security.ts` l.66–81; `security-routes.test.ts` l.36–42; `apps/web/tests/proxy.test.ts` | A local program can forge Origin. The real defence is that no bot has code execution and network together: E1 option A, and check 6 showed Codex's sandbox cannot reach `127.0.0.1:4100`. |
| **MCP capability** | Each Lead spawn gets a 256-bit capability URL, written to its MCP config file (never to argv) and revoked in `finally`. Consult and room sessions get no tools. | PM3 review; `api/routes/lead-proposals.test.ts`; live-shape Lead flows | none |

## 4. Runbook and README

- **Overall:** the runbook is accurate and clear enough for a first run. It covers:
  - prerequisites with how to check each;
  - settings, the lock file, launchd;
  - first run, daily use;
  - a troubleshooting table per degraded-start reason;
  - a plain-words safety model;
  - seven live checks, with the 2026-10-11 results recorded under each;
  - an eight-step dry run.

  QA4's clean-clone run followed it with no failed step.
- **Fixed in this commit (docs only):**
  1. **`BSJA_API_MODE` caveat (§2):** `pnpm dev` passes this variable to the web app only after SF-1. Until then the Sample data badge is the guard, and the runbook now says what to do when the badge shows.
  2. **Check 4:**
     - names where `SPIKE_TEST_EN_v1` comes from, and how to use another Drafts frame (`LIVE_CHECK_FRAME`);
     - says the `needs_figma` → resume part needs the app running and is a real scan, so it can be folded into the dry run.
  3. **§8 step 1:** the search criteria must be saved first; a scan without them is refused (`no_search_profile`).
  4. **§8 step 9 (new):** create the first schedule and watch one scheduled scan. This proves §1.2 criterion 1.
  5. **README:**
     - the ChatGPT for Chrome extension is not needed under E1 option A (it said both were required);
     - First run step 3 starts with `BSJA_API_MODE=live` and points to the badge check, as the runbook does.

## 5. Verification of every prior must-fix item

| Item | Landed? | Evidence (code; tests) |
|---|---|---|
| **PM1 M1:** approvals and records bound to job, CV and file | ✅ | `createApproval`/`createApplication` check that the CV belongs to the job and has a PDF and SHA. `recordSubmission` throws `SubmissionRefusedError` (`token_missing`/`token_unused`/`token_mismatch`/`sha_mismatch`), `applications.ts` l.313–330. Trigger `submissions_match_approval`. Tests: `db/repos/applications.test.ts`, `approvals.test.ts`. |
| **PM1 M2:** a used token re-validates only a resume of its own application | ✅ | `approvals.application_id` (ADD COLUMN); `checkApprovalForResume` (`approvals.ts` l.278), used by `engine/trust-guard.ts` l.89. Triggers `approvals_immutable`, `approvals_domains_grow_only`, `approvals_no_delete`. Tests: `approvals.test.ts`. |
| **PM1 M3:** dry runs and one status machine | ✅ | `drizzle/0003_dry_run_status_machine.sql`: the unique index is `WHERE reapply = 0 AND dry_run = 0`, plus the `applications_dry_run_{insert,update}_guard` triggers. One transition table in shared. History is prefix-checked. Tests: `applications.test.ts`, `schema-guard.test.ts`. |
| **PM1 M4:** runtime guard on triggers and the index | ✅ | `db/schema-guard.ts` `GUARDED_SCHEMA_OBJECTS` (15 triggers + `applications_job_uq`). `openDb` fails closed, and boot goes to degraded `schema_guard`. Tests: `schema-guard.test.ts`, `migrations.test.ts` (populated upgrade). |
| **PM1 M5:** Phase 2+ ownership of shared/db | ✅ | phases.md rows for F1, W2a–c, F2, F3, W3a–c, F4 and W4a–c. |
| **PM2 M1:** the record never cites a path the bot names | ✅ | `engine/apply.ts`: only files inside `data/applications/<id>/` with PNG/JPEG magic bytes. Missing screenshots → `needs_check` ("screenshots not captured", l.675). Test: `record-files.test.ts` "probe P1", plus S7 copy-only tests. |
| **PM2 M2:** no public-suffix, IP or LAN allowlists; `domain_confirm` only for a blocked host | ✅ | `shared/src/common/host.ts` (`tldts` pinned), used by `DomainSchema`, approvals and the site guard. `engine/queue.ts` l.605–636 (a bot-named site without a guard block → `needs_check` + `safety.denied`). Tests: `host.test.ts` (`com`, `vn`, `com.vn`, `github.io`, `127.0.0.1`, `192.168.1.1`, `localhost` refused), `site-guard.test.ts`. |
| **PM2 M3:** Codex browser sessions keep only the Chrome plugin | ✅ (now moot) | `runner/codex/argv.ts` l.62–66: `mcp_servers.<id>.enabled=false`, `notify=[]`, `--disable apps`, and the skill flags. With E1 option A, no bot uses Codex's browser. |
| **PM2 M4:** fetched or bot-made fields in untrusted blocks | ✅ | `runner/prompt.ts` l.47–58. cv.tailor's intro says QA's fixes are suggestions. Tests: `prompt.test.ts`, snapshots. |
| **PM2 M5:** a source waiting for Ba no longer stalls the scan or later schedules | ✅ | `engine/workflow.ts` l.221/257/625–660; `engine/scheduler.ts` l.78. Test: `scan-waits.test.ts` "probe P4". |
| **PM3 M1:** Lead on Claude only | ✅ | `shared/src/bots/definition.ts` `LEAD_ENGINE_RULE` l.117; `ENGINE_LOCKS.lead` on the web. Tests: `api/boot/start.test.ts` l.147 (a DB row on Codex → degraded start), the shared rule and the API 403; live-shape `bots.spec.ts`. |
| **PM3 M2:** every mutation needs the web Origin | ✅ | `api/security.ts` l.78–81. Tests: `security-routes.test.ts` l.36–42, where nothing changes in the DB. QA4's manual check through the new proxy: no Origin → 403. README says so. |
| **PM3 M3:** "Save to my criteria" works live | ✅ | `LeadAction propose_criteria_change` (`shared/src/bots/lead.ts` l.87); `api/chat/lead-proposals.ts` (server-stored proposal, server-written card text, `criteria-save:<id>`). Tests: `lead-proposals.test.ts` (a replay is a 409; forged keys refused); live-shape `lead-features.spec.ts` UC-21b a. |

**Should-fix items from earlier phases:** PM2 S1–S28 and PM3 S1–S13 have landed, according to the reports, and I spot-checked S2, S3, S4, S7, S9, S10 and S12 of PM2 and S2–S4 of PM3 in code. The only partial items are carried into §6 below:
- PM2 S26 (scan screenshots): Research has no screenshot tool, so a scan's screenshot is always "not captured" (B4).
- PM3 S5 (Lead's tool steps): covered only on the mock lane (B9).

## 6. SHOULD-FIX and backlog

### Before the dry run (XS)

**SF-1. Turbo drops `BSJA_API_MODE` (and `ORCH_URL`) before they reach the web app.**
- **What:**
  - Turbo runs in strict env mode.
  - `apps/web` has no `turbo.json`, and the root `globalEnv` lists only `NEXT_PUBLIC_*` and `ORCH_PORT`.
  - `turbo run dev --dry=json` shows `web#dev` with `passThroughEnv: null` (the orchestrator's `dev` passes `ORCH_*`).
  - So `BSJA_API_MODE=live pnpm dev` leaves the web app in `auto`. If the orchestrator is slow to answer `/health` (600 ms), the web app falls back to sample data.
- **Why it matters:**
  - It is not a safety issue: the sample-data backend sends nothing anywhere and is labelled with a badge.
  - But runbook §2 promised "never falls back", and approving a sample card by mistake would be confusing.
- **Fix:** add `apps/web/turbo.json` (`extends: ["//"]`, `tasks.dev.passThroughEnv: ["BSJA_API_MODE", "BSJA_MOCK_SPEED", "ORCH_URL"]`).
- **Acceptance:**
  - `turbo run dev --dry=json` lists them for `web#dev`.
  - With the orchestrator stopped, `BSJA_API_MODE=live pnpm dev:web` shows "orchestrator unreachable", not sample data.
  - Then remove the caveat in runbook §2.

### Before the first live submission

**SF-2. Narrow the dry-run gate to a dry run that actually filled the form.**
- **What:** `dryRunAcceptanceDone` (`engine/review.ts` l.379) counts any dry run that ended `needs_check` **or `failed`**. A dry run that failed at once therefore opens the gate, for example when Chrome was not connected or "screenshots not captured" came back.
- **Proposed rule:** count only a dry run that:
  - ended `needs_check`;
  - has a pre-submit screenshot in its record;
  - has no `dry_run_submitted`, `off_allowlist` or `page_mismatch` safety event.
- **Acceptance:** `dry-run-gate.test.ts` gets a failed dry run and one with no screenshot, and both keep the gate closed. The live-shape §12 test stays green.
- **Owner's call:** Ba may prefer to keep it as it is, because his own inspection in runbook §8 step 6 is the real acceptance (QA4 residual risk).

### Backlog after the dry run (prioritised)

| # | Item | Size | Why |
|---|---|---|---|
| B1 | **§12 bot-quality evals:**<br>• a script plus a golden set of 10 real JDs from Ba;<br>• QA score consistency ±5 over 3 runs;<br>• a CV seeded with invented facts must hard-fail;<br>• one-page output;<br>• a JD with hidden instructions is not obeyed;<br>• results stored per `promptVersion`. | L | The only §12 row not built. It is also the only way to prove "injections are not obeyed" beyond the flag path. Needs Ba's JDs and subscription quota (owner decision). The natural first item of sub-project C. |
| B2 | **Prompt and skill tuning from the dry-run transcripts** (Apply ROLE.md, Research skills, CV template choice). Bump `promptVersion` and run `bots:lock` with every change. | M | The prompts have never driven a real form or a real Figma edit. |
| B3 | **HTML form fixtures (§12 form filling):** local pages on `127.0.0.1` for the salary rules, required vs optional unknowns, consent and file upload, driven through the real runner's tool plan. | M–L | Today the form rules are proven only on FakeRunner outputs. |
| B4 | **Scan screenshots for UC-03 b:** Research has no screenshot tool, so "adapter broken" always says "not captured". Option: give Research `computer` limited to `screenshot` by a PreToolUse rule, captured by the existing S7 pipeline. | M | Ba needs to see what changed on the page. |
| B5 | **A policy-violation outcome:** LinkedIn over 40 page views or with pauses under 3 s is reported today as "adapter broken". Make it a distinct outcome (and a Lead note), so Ba doesn't fix a skill that isn't broken. | S | UC-03 c. |
| B6 | **`career_site` as a source in shared:** the skill exists, but it cannot be chosen as a search source. §15.1 says career sites are used "only via links or on request", so add it as an on-request source, off by default. | S | W4a deferred item. |
| B7 | **UC-24 fact import from an old CV** (E2 a). Today Lead points Ba to the Master CV screen. | M | Deferred pending Ba. |
| B8 | **UC-13b weekly auto-export** (E2 b), on the Applications screen next to "Export all". | S–M | Deferred pending Ba. |
| B9 | **Reply streaming:** decided against in Phase 1 (structured replies). Keep the tool-step indicator, and add live-shape coverage for the S5 tool steps (QA4 open item 5). | S | Test gap only. |
| B10 | **§15.3, the first chat request seeds the Search Profile:** today a scan with no saved criteria is refused (`no_search_profile`), and the runbook has Ba save criteria first. Let Lead answer that refusal with a `propose_criteria_change` built from the request. | S | Spec fidelity; first-run friction. |
| B11 | **Low items:**<br>• uploads are buffered in memory;<br>• `x-middleware-rewrite` shows the loopback URL in devtools;<br>• screenshot baselines are macOS-only;<br>• adapter selectors will drift, so refresh the fixtures every few months. | XS–S | QA4 residual risks. |
| B12 | **Flow canvas "wow":** live last-line preview and elapsed timer in running nodes, an edge pulse on hand-off, a one-line run timeline. | M | PM3 §6 ideas. |

## 7. Owner decisions still open

| # | Question | Recommendation | Today |
|---|---|---|---|
| **E1** | Research's engine | **Confirm option A** (Claude). Check 7 passed live: skills readable, other files denied, no Codex browser in use, and Codex's sandbox cannot reach the API (check 6). | Option A applied in `bots/research/bot.json` |
| **E2** | Defer UC-24 (fact import) and UC-13b's weekly auto-export | **Defer both** (B7, B8) | Deferred |
| **Evals** | Build the §12 bot-quality evals, and provide 10 golden JDs? | **Yes, after the dry run** (B1). Pick 10 JDs you would really apply to, some VI and some EN. | Not built |
| **SF-2** | Should only a dry run that filled the form open the gate? | **Yes, narrow it** | Any ended dry run counts |
| **Spec wording** | The proposals from earlier PM reviews that change the letter of a rule. All of them describe what is built:<br>• §5.5 step 6, the Apply exception (never retried);<br>• §5.3, the demotion triggers;<br>• §7.4 / UC-02 a, waiting review cards do not block the next scan;<br>• §4.4, tab cleanup by the bot;<br>• §10.2 rule 7, a guard block fails without a retry;<br>• §3 rule 3, a saved workflow is a preset;<br>• §5.1, Research's per-kind schema map;<br>• §9, the extra columns;<br>• UC-24 / UC-13b, the deferral (with E2). | **Approve as one batch.** The coordinator then applies them to the spec. | Proposed, not applied |

**FYIs** (no decision needed unless you disagree):
- **(a) The CVs you already sent:** W4c found that the three `*_Figma_EN.pdf` files sent to DEKON, SMARTBIT and YAVIET have no extractable text, so an ATS may not have read them. The bridge's exports do have a text layer, and the pipeline checks it.
  **Correction (2026-10-11):** wrong. The PDFs do have text; pdf.js 4 failed on Figma's embedded fonts (\"invalid font name\"). pypdf, pdfminer and pdf.js 5 read them, and the orchestrator now uses pdf.js 5 with a Figma-export regression test.
- **(b) The dry run:** "never click submit" is a prompt rule. If Apply submits anyway, the app records it as a safety event, demotes Apply and sends the application to `needs_check`. That is why the dry run should be on a job you want.
- **(c) Leaving the site by a click:** a click (not a `navigate`) that leaves the employer's site is caught after the task and by the extension's site permissions, not blocked up front.

## 8. What Ba does next

In order. The § numbers are runbook sections.

1. **Decide, or let the defaults stand:** E1 (confirm A), E2 (defer), evals (yes, after the dry run), SF-2 (narrow), and the spec-wording batch. None of these blocks steps 2–8.
2. **Setup (§1, §2):**
   - check each prerequisite;
   - run `pnpm install && pnpm build`.
3. **First run (§3):**
   1. Read `data.example/master-cv.yaml` and fix any fact that is wrong. Bots will cite only these facts.
   2. Copy it into `data/`.
   3. Import the three earlier applications (with the orchestrator stopped).
   4. Start with `BSJA_API_MODE=live pnpm dev` and confirm there is no **Sample data** badge.
   5. Check Applications (3 imported rows) and Master CV.
   6. Save your **Search criteria** (version 1).
   7. Check **Bots**: Lead, CV and Apply locked to Claude; Research on Claude; QA on Codex; Apply at L1.
4. **Stop the app and close every other Claude Code session,** then run **check 1** (§7). If it doesn't print `CONNECTED`, work through §5.3 and run it again.
5. **Check 2:** run `live:screenshot` and expect `PASS`, a captured image with a manifest, and `transcript keeps base64: no`. If the printed image-block shape differs from the fixture, save it and report it before the dry run. Every Apply would end in `needs_check` until it is fixed.
6. **Check 3:** `LEFT 0`, and no leftover tab or group in Chrome.
7. **Check 4:**
   1. Open Figma desktop with the CV file and start the Desktop Bridge plugin.
   2. Run `bridges:live-check`. Expect one A4 page, clean text and `protected pages: unchanged`.
   3. The `needs_figma` → resume part can be done during the dry run.

   Checks 5–7 need nothing from you under option A.
8. **Dry run (§8 steps 1–7)** on a job you really want:
   - Approve with **Dry run** ticked, and watch Apply in Chrome.
   - Verify everything in step 6: the card is back with "Approve live & submit"; the record has a **Before submit** screenshot; the dry run is left out of the export; nothing was sent; no tabs are left.
   - If anything is wrong, stop and report it with the record and the transcript (step 7).
9. **First live application (§8 step 8),** when you are happy. This proves §1.2 criterion 2 live.
10. **First scheduled scan (§8 step 9):** create a schedule (Weekdays 09:00) and leave the app, Chrome and Figma running. One card arriving without you proves §1.2 criterion 1.
11. **Only then, optionally,** move the orchestrator to launchd (§2).
12. **Send the results back:**
    - each check's outcome, so it can be recorded in §7;
    - anything odd from the dry run.

    The coordinator then schedules SF-1/SF-2 (if they are not done yet) and the backlog, starting with B1 and B2.
