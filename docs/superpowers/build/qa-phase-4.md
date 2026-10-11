# QA/QC report: Phase 4 (final integration)

- **Branch:** `worktree-agent-a4851c845a6ff4bb7`, from `develop` at e88c93b (W4a, W4b, W4c, F4 parts A and B merged).
- **Commits:** 7 before this report. Every code fix was made test-first.
- **Result:** the definition of done passes uncached: install, typecheck, lint, test, build, `pnpm e2e` and `pnpm e2e:live-shape` are all green (§1).
- **Scope:**
  - the full check suite;
  - W4b's open issues 2, 3, 4 and 6 fixed in code, with 1 and 7 as runbook notes;
  - an audit against the spec's §1.2 success criteria and §12 testing rows;
  - a clean-clone run of README "First run" plus runbook setup, in live mode;
  - one test flake fixed deterministically.
- **Not done here, by instruction:**
  - no scans of real job sites;
  - no approval and no Apply in live mode;
  - Ba's Chrome and Figma were not driven.

## 1. Checks

The e2e lanes ran on their own ports (`E2E_PORT=3341`; live-shape: web 3441, orchestrator 4241, control 4240), so they could not collide with another worktree.

| Check | Baseline (e88c93b) | Final (HEAD) |
|---|---|---|
| `pnpm install` | ✅ | ✅ |
| `pnpm -w typecheck --force` | ✅ 4/4, 0 cached | ✅ 4/4, 0 cached |
| `pnpm -w lint --force` | ✅ 4/4, 0 cached | ✅ 4/4, 0 cached |
| `pnpm -w test --force` | ✅ 2,676 (shared 392, web 488, orchestrator 1,796) | ✅ 2,692 (shared 392, web 494, orchestrator 1,806) |
| `pnpm build --force` | ✅ 3/3 | ✅ 3/3 |
| `pnpm e2e` (mock lane) | ✅ 151/151 | ✅ 151/151 |
| `pnpm e2e:live-shape` | ✅ 11/11 | ✅ 12/12 |

**Flake found and fixed** (f328284):
- **Symptom:** in one uncached run, `runner/claude/runner.test.ts` "kills the process at the task timeout" failed with `calls[0]` undefined.
- **Cause:** under parallel load, preparing the task (temp folder, MCP config) took longer than the test's 40 ms timeout. The runner then reported a timeout without ever spawning. The cancel tests had the same race, because they aborted on a 30 ms timer.
- **Fix (deterministic, no longer timeouts):**
  - The timeout tests freeze the runner's duration clock, so preparation time is not taken from the timeout.
  - The cancel tests (Claude and Codex) abort from a new `onSpawn` hook on the fake process, so the abort always comes after the spawn.

## 2. Fixes (W4b's open issues)

| # | Issue | Fix | Tests | Commit |
|---|---|---|---|---|
| 2 | `next start` froze the orchestrator's address into the build: `next.config` rewrites are evaluated at build time. | **`apps/web/proxy.ts`** (Next 16's Proxy, Node runtime) replaces the config rewrite:<br>• It forwards `/api/*` with `NextResponse.rewrite` to `orchestratorProxyTarget()`, which reads `ORCH_URL` / `ORCH_PORT` on every request.<br>• Any non-loopback Host gets a 404 and is never forwarded (DNS rebinding).<br>• Next's external rewrite keeps Origin, the CSRF header and the body, and sets `X-Forwarded-Host`, as before. | `tests/proxy.test.ts` (6): matcher, default target, run-time env, malformed escapes passed through, foreign Host → 404, no config rewrite. `config.test.ts` updated.<br>**Manual check:** web built with the default port, then `next start` with `ORCH_PORT=4251` against the real orchestrator. `/api/health` reached 4251. Foreign Host → 404. POST without Origin → 403, without CSRF → 403, with both → reached validation (400), foreign Origin → 403. SSE stayed open for 45 s (pings), past Next's 30 s proxy timeout. | d450fe0 |
| 3 | After a dry run that reported "submitted", the card's return relied on the queue reloading on `application.updated`. | When Ba changes a dry run's status by hand (`POST /applications/:id/status`), the route calls `engine.dryRunStatusChanged(id)`. If the dry run is now settled, that emits `review.ready` for its card, as `announceSettledDryRun` does. It fires once, and only on a real status change. | `review-flags.test.ts` (+1): marking it failed emits one `review.ready` with the dry run's CV; repeating the change emits nothing. | ae4cccb |
| 4 | §12 "a dry run is required before the first live submission" was not enforced. | `engine.approve` refuses a live approval with **409 conflict**, `details.reason: "dry_run_required"`, and "Do a dry run first: …" until **one dry run has settled** on this install, or the app itself has made a live application.<br>• A dry run is always allowed, on any job.<br>• Imported applications do not count.<br>• A dry run that reported "submitted" does not count until Ba has settled it.<br>• `EngineConfig.requireDryRunFirst` defaults to **true**, and production never overrides it.<br>• The test harness and the live-shape launcher turn the gate off unless a test is about it (`/reset?dryRunGate=1`).<br>• Runbook §8 says so. | `engine/dry-run-gate.test.ts` (8); `production-wiring.test.ts` (+1, the production engine has the gate on).<br>New live-shape test: Ba sees the toast, the dialog stays open and nothing is sent. A dry run on another job then lets the live approval through. | ef01e2a |
| 6 | The Proof column said "not captured" for every dry run. | `ApplicationListItem.preSubmitScreenshotFileId` was added to the shared schema (additive, optional) and filled by the server and the mock. For a dry run, the column shows **before submit** and opens the screenshot in the viewer. | `applications.test.ts` (+1 assertion); `ApplicationsScreen.test.tsx` (+1 test, +2 assertions). | 64f9fef |
| 1, 7 | Flaky Chrome checks; manual `--chrome` checks need `--strict-mcp-config`. | Runbook §7 note: one Claude session on Chrome at a time, and keep `--strict-mcp-config` and `--setting-sources ""` on every manual `--chrome` command. | n/a | 4d03d18 |
| 5 | S5 tool steps are not covered by the live lane. | Left open: the mock lane covers them (`chat.spec.ts` "PM3 S5/S7"). It is a test gap, not a defect. | n/a | n/a |

**Contract changes (additive):**
- shared: `ApplicationListItem.preSubmitScreenshotFileId?`;
- engine: `EngineConfig.requireDryRunFirst`, `Engine.dryRunStatusChanged`, `dryRunAcceptanceDone`, `DRY_RUN_REQUIRED_MESSAGE`;
- boot: `StartOptions.engineConfig` (tests only);
- web: `proxy.ts`, with `orchestratorProxyTarget` replacing `orchestratorRewrites`;
- launcher: `/reset?dryRunGate=1`.

## 3. Spec audit

### §1.2 Success criteria (Phase 1)

| # | Criterion | Automated evidence | Live evidence / gap |
|---|---|---|---|
| 1 | A scheduled scan produces at least one review card (job, company profile, tailored CV, QA score ≥ 80) without Ba stepping in. | `engine/scheduler.test.ts` "a due schedule starts its workflow…". **Strengthened here** (81bb0fa): the card has `qaPassed`, no escalation, no input needed and no missing company. Company research is done, every QA review is ≥ 80 with no hard fail, and nothing went to Apply.<br>Also `engine/job-scan.test.ts` (whole pipeline), live-shape `lead-features.spec.ts` (Run now on Schedules starts a scan) and `chat-run.spec.ts`. | **Needs Ba:** a first real scheduled scan. QA did not run one (no real scans). |
| 2 | Approving a card leads to a confirmed submission, and an application record is saved with the link, CV version and confirmation screenshot. | `engine/job-scan.test.ts` (…→ approve → apply → record), `engine/apply.test.ts`, `engine/record-files.test.ts`, `engine/dry-run-live.test.ts`.<br>Live-shape `review-apply.spec.ts`: dry run → Approve live → the record shows SHA-256, the allowed site, the before-submit and confirmation screenshots and the CV in the viewer. | **Needs Ba:** the dry run, then the first live application (runbook §8). |
| 3 | An automated test proves that nothing is ever submitted without Ba's approval. | • `engine/apply.test.ts` describe "nothing is submitted without Ba's approval (§1.2 success 3)": a forged task without a token never spawns, even with Apply at L2 in the DB or in bot.json.<br>• `engine/trust-guard.test.ts`: no token, expired, reused, wrong job, CV or domain, wrong application; injection-flagged jobs stay blocked.<br>• `api/security-routes.test.ts`: approve needs the web Origin and CSRF.<br>• New: `engine/dry-run-gate.test.ts`. | Covered. |
| 4 | Hitting a subscription usage limit pauses the work, and it continues automatically after the reset. | `engine/usage.test.ts` (pause until reset, unknown reset retries every 30 min, 95 % pre-pause, per-engine, survives restart), `runner/usage.test.ts`, `engine/spec-coverage.test.ts`; live-shape `lead-features.spec.ts` UC-16 (banner, auto-resume, Lead answers). | Real limit message shapes come from the spikes' fixtures. A real limit has not been hit live. |

### §12 Testing rows

| Row | What the spec asks | Evidence | Gap |
|---|---|---|---|
| Unit | Workflow engine (order, map/join, partial failure, gate pass/fail/escalate at 3, human gate, per-job branches) | `engine/job-scan.test.ts` (order, fan-out, top-N, fail → revise → pass, three rounds escalate), `engine/flows.test.ts` (a failing source is recorded by the join; one job's branch fails and the other still reaches review), `engine/queue.test.ts` | none |
| | Trust guard (no token, expired, reused, wrong job, wrong domain) | `engine/trust-guard.test.ts`, `db/repos/approvals.test.ts` | none |
| | Dedupe; top-N filter | `db/dedupe.test.ts`; `job-scan.test.ts` "dedupe drops…", "top-N keeps…" | none |
| | Scheduler (overlap skip, catch-up rule) | `engine/scheduler.test.ts` (UC-02 a overlap, §7.4 catch-up within 12 h) | none |
| | Concurrency limiter, browser lock | `engine/queue.test.ts` ("caps are configurable", "the browser lock runs one Chrome task at a time"), `spec-coverage.test.ts` §10.3 | none |
| | Usage-limit pause/resume | `engine/usage.test.ts` | none |
| | Memory appended one at a time, 200-line archive | `runner/memory.test.ts`, `engine/memory-notes.test.ts`, `api/routes/bots-qa3.test.ts` (delete/append race) | none |
| Output formats | Every bot schema accepts valid fixtures and rejects invalid ones; generated JSON Schemas are strict; repair-prompt path | `packages/shared/src/bots/*.test.ts`, `shared/src/json-schema/strict.test.ts` and `check.test.ts`; the repair path in `runner/claude/runner.test.ts` and `runner/codex/runner.test.ts` | none |
| Integration | Full job-scan, trigger → record | `engine/job-scan.test.ts`, `engine/production-wiring.test.ts` (real adapters, fake CLIs) | none |
| | Record complete (fields, consent, both screenshots, JD snapshot, files copied) | `engine/record-files.test.ts`, `engine/apply.test.ts`, `api/routes/applications.test.ts` | none |
| | SHA-256 mismatch aborts the submit | `engine/apply.test.ts` "a copy that is not the approved PDF aborts before spawning" | none |
| | Record immutable after write | `db/schema-guard.test.ts` (the eight §9.1 triggers), `db/repos/applications.test.ts` (append-only history, a second record refused, dry-run triggers) | none |
| | Export ZIP: CSV plus one folder per application | `api/routes/exports.test.ts`, `api/export-helpers.test.ts`, live-shape UC-13b | none |
| | Crash → restart → continue; interrupted Apply → `needs_check`; usage limit mid-run → continue | `engine/recovery.test.ts`, `db/repos/recovery.test.ts`, `engine/usage.test.ts` | none |
| Source adapters | Saved HTML (TopCV, ITviec, LinkedIn, a career page): field extraction, layout-change detection | `adapters/parsers.test.ts`, `adapters/checker.test.ts`, `adapters/normalise.test.ts`, `adapters/skills.test.ts`, with `adapters/fixtures/` | The selectors were observed in 2026-10 and will drift. The checker reports "adapter broken". |
| UI end-to-end | Select (keys, click-outside), Slider (drag, arrows), Checkbox/Switch with Space, NumberInput formatting, menus not clipped | `web/e2e/components.spec.ts` | none |
| | Chat → run card; Flow nodes over SSE; approve → Apply unlocks; request changes; skip | mock lane `chat.spec.ts`, `flows.spec.ts`, `review.spec.ts`; **live-shape** `chat-run.spec.ts`, `review-apply.spec.ts` (canvas over SSE, Apply unlocks), `decisions.spec.ts` | none |
| | Light/dark screenshot checks | `screenshots.spec.ts`, `screenshots-pages.spec.ts` (`toHaveScreenshot`, 9 screens × 2 themes, macOS baselines) | The baselines are macOS-only (W4b). |
| Form filling | Salary rules, Ask/Skip, unknown required pauses, unknown optional never pauses: **Vitest + FakeRunner + HTML form fixtures** | `engine/questions.test.ts` (every salary rule, VI/EN), `engine/apply.test.ts` (UC-12), mock `chat.spec.ts` | **Partial:** there are no HTML form fixtures. Apply fills forms in Ba's real Chrome, so the engine-side rules are tested on FakeRunner outputs. Filling real forms is checked by Ba's dry run. Large to add (needs a browser harness). |
| Safety | A JD with hidden instructions is not obeyed and is flagged; off-domain Apply blocked; double submission impossible | Flagging: `job-scan.test.ts` (UC-07 b), `engine/injection-reports.test.ts`, `engine/conversations.test.ts`. Off-domain: `engine/apply-pages.test.ts`, `trust-guard.test.ts`, `bridges/chrome/site-guard/*.test.ts`. Double submission: reused token (`trust-guard`, `apply.test.ts` UC-11 f), the one-application-per-job index (`schema-guard`), `dry-run-live.test.ts` (`already_applied`). | **"Not obeyed"** is model behaviour. FakeRunner can only prove the flag path. The bot-quality evals below would cover it. |
| Figma bridge | Fingerprint change fails the task; the hook rejects non-Drafts code; base64 export writes a one-page PDF; not connected → `needs_figma` → auto-resume; Figma lock; text extractor | `bridges/figma/{fingerprint,guard,guard-settings,bridge,plugin-code,replies,tools,mcp}.test.ts`, `bridges/pdf/{text,info,hash,files}.test.ts`, `engine/queue.test.ts` (Figma lock, protected page, one A4 page) | none (automated). **Needs Ba:** the live export (runbook check 4). |
| Bot quality evals | On demand: a golden set of 10 real JDs; QA consistency ±5 over 3 runs; a CV seeded with invented facts must hard-fail; one-page CV; results stored per prompt version | — | **Gap: not built.** No eval script or golden set exists. It is on-demand and uses the subscription, so it does not block Phase 1. Large: it needs 10 real JDs from Ba and a script. Recommend it as the first item of sub-project C. |
| Dry-run acceptance | Real pipeline, Apply in `dryRun`: fills and screenshots, never clicks submit; required before the first live submission | Pipeline shape: live-shape `review-apply.spec.ts` (dry run → Approve live). **The requirement is now enforced:** `engine/dry-run-gate.test.ts` and the live-shape §12 test. | **Needs Ba:** the real dry run (runbook §8). |

**Large gaps (listed, not fixed):**
1. Bot quality evals (§12).
2. HTML form fixtures for form filling (§12).
3. Proof that injected instructions are not obeyed, beyond the flag path; depends on (1).
4. From earlier phases and still open: UC-24 fact import and UC-13b weekly auto-export (E2E deferred, Ba's answer pending), and `message.delta` streaming (decided: not in Phase 1).

## 4. Clean-clone check

- **Setup:** a fresh `git clone --branch worktree-agent-a4851c845a6ff4bb7` into the session scratchpad (`/private/tmp/claude-501/…/scratchpad/cc`: no spaces, commas or parentheses), followed exactly as written.
- **Steps run:**
  1. `pnpm install`: ok (3.5 s).
  2. `pnpm build`: 3/3.
  3. `mkdir -p data && cp data.example/master-cv.yaml data/master-cv.yaml`.
  4. `pnpm --filter @bs-job-agents/orchestrator import:applications -- --data data --file data.example/imported-applications.yaml`: "imported 3, skipped 0" (DEKON, SMARTBIT, YAVIET, PDFs hashed). Run again: "imported 0, skipped 3".
  5. `BSJA_API_MODE=live pnpm dev`, with `ORCH_NOTIFY=0` so no macOS notification could fire during the check. This was the only deviation from the docs.
- **Result:**
  - `/health` → `{"ok":true}`.
  - `/api/applications` through the new proxy listed the 3 imported rows, all partial, with `dataDir` set to the clone's `data/`.
  - `/api/master-cv` returned 24 facts.
  - `/bridges` showed both Chrome extensions connected. This was a read-only probe; nothing was driven.
  - A headless Chromium (Playwright's own, not Ba's Chrome) checked the pages:
    - Applications showed 3 rows, marked "imported", with "not captured" proofs;
    - Master CV showed the facts;
    - Bots showed "Locked to Claude";
    - no "Sample data" badge, and no console errors.
- **Clean-up:** both servers were stopped and the clone was deleted.
- **Docs:** no setup step failed, so no doc fix was needed. Note that step 4 depends on `pdfDir` in the YAML, an absolute path on Ba's Mac. On another machine, edit `pdfDir` first.

## 5. Residual risks

- **The gate's definition of "settled".** A dry run whose Apply failed (status `failed`, task ended) also satisfies the gate. This matches what "Approve live" accepts after a dry run. If Ba wants only a dry run that filled the form, narrow `dryRunAcceptanceDone` to `needs_check`.
- **The mock does not enforce the dry-run gate.** Sample-data mode lets a live approval through first. The live and live-shape lanes cover the real behaviour.
- **The proxy exposes the loopback address.** `x-middleware-rewrite` names the orchestrator's loopback URL in `/api` responses. This is harmless (`127.0.0.1` only), but it is visible in devtools.
- **Unchanged from Phase 3:**
  - a local process can forge the Origin header (E1 option A is the real fix, applied);
  - uploads buffer in memory;
  - the adapters' selectors will drift.
- **Screenshot baselines** are macOS-specific, so the light/dark comparisons fail on another OS by design.

## 6. What still needs Ba

1. **Runbook §7, check 1: Claude in Chrome connected.** Close other Claude sessions first.
2. **Check 2:** a screenshot capture (`pnpm --filter @bs-job-agents/orchestrator live:screenshot`).
3. **Check 3:** tab cleanup.
4. **Check 4:** a Figma live export, with Figma desktop and the Desktop Bridge plugin open.
5. **The dry run (runbook §8)** on a job Ba really wants. The app now refuses a live approval until this has been done.
6. **Then, optionally, the first live application.** This proves §1.2 criterion 2 live.
7. **A first real scheduled scan.** This proves §1.2 criterion 1 live.
8. **Owner decisions:**
   - E1: option A is applied; confirm it or pick B/C.
   - E2: defer UC-24 and UC-13b?
   - Whether to build the bot-quality evals (§12), and provide 10 golden JDs.
