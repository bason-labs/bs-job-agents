# PM review: Phase 3 (API, Lead MCP server, chat, UI screens, live wiring)

- **Reviewed:** `develop` at 20a0658 (W3a parts 1–2, W3b, W3c, W3d, F2, F3 and the Phase 3 QA/QC fixes), in worktree branch `worktree-agent-ac83c131a54236503`.
- **Read:**
  - the spec, `stage0-prototype.html`, phases.md, progress.md, owner-decisions.md, pm-phase-1.md, pm-phase-2.md, the seven Phase 3 reports and qa-phase-3.md;
  - the code in `apps/orchestrator/src/{api,mcp,engine}`, `apps/web/**`, `packages/shared/src/{api,bots}` and `bots/`.
- **Re-ran (uncached):**
  - `pnpm install`
  - `pnpm -w test --force`: 2,431 tests green (shared 384, web 467, orchestrator 1,580)
  - `pnpm e2e` on `E2E_PORT=3291`: 144/144 green

  The QA numbers hold.
- **Looked at every screen:** the web app in mock mode (`BSJA_API_MODE=mock`, port 3292, stopped afterwards) and the prototype, side by side in Playwright screenshots at 1440×900 in light and dark. That covered:
  - chat (Lead and consult), a live mock run in chat and on the canvas, the flow list, the canvas and step drawer;
  - review and the approve dialog;
  - applications, the record panel and the file viewer;
  - criteria, schedules and the schedule modal, bots and `/bots/apply`, Master CV, rooms;
  - chat and review at phone width.

  No live CLI, Chrome or Figma call was made.

## 1. Verdict

**Ready for Phase 4: yes, once fixer F4 has merged M1–M3 plus S1 and S8.** W4c needs S1's new Lead action for Lead's ROLE.md, and W4a needs S8's port. F4's other items (S2–S7) are a second merge that runs alongside Phase 4 and must land before W4b's dry run.

- **What is solid:**
  - **The API is a careful piece of work.** Every route is in one shared contract (`API_CONTRACT`), and parity tests on both sides fail on drift. S18 is enforced and tested on every route: Host, Origin, Sec-Fetch, CSRF and JSON-only checks. Approval tokens never leave the server, whether in JSON, SSE, transcripts or the export. Files are served by id inside `data/`.
  - **The Lead MCP server holds rule 5 on Claude:**
    - per-spawn 256-bit capabilities, revoked in `finally`;
    - exactly six tools, and `create_task` limited to `research.*`;
    - consult and room sessions get no tools at all (`conversationPlan`);
    - the UC-25 handoff passes Ba's own words as the trusted text.
  - **The human gate holds:** approve runs only through `POST /review/:jobId/approve` with a strict body. Lead has no approve or answer tool.
  - **Record and export:** the submission record and the export ZIP match §9.1 and UC-13b, field for field.
  - **UX fidelity is high.** Chat, review, applications, criteria, schedules, bots, Master CV and rooms reproduce the prototype's layout, copy and interactions almost one to one. Several screens go beyond it: the Master CV contact card and inline edit, the bot detail page with its trust ladder, the step drawer with per-source tabs, and "View as form" in the record panel. The theme, own components, the cursor rule, centring and viewer-before-download hold everywhere (e2e).
- **What must change first:**
  - one way to break rule 5 with a single click (M1);
  - one way around Ba's approval for any local process (M2, defence in depth until E1 is settled);
  - one prototype interaction that looks like it works but does nothing live (M3).

## 2. MUST-FIX before Phase 4 (fixer F4)

### M1. Lead can be switched to Codex, which gives it a shell (rule 5)
- **What:**
  - `PATCH /bots/lead {engine:"codex"}` is accepted, and the Bots screen shows Lead's engine switch enabled.
  - On Codex, every session has Codex's built-in shell and `apply_patch` (read-only sandbox, whole-disk read), sub-agents and image_gen. The runner's own live check lists these (`runner/codex/argv.ts` l.11–16).
  - On Codex the orchestrator capability URL is passed in argv (`-c mcp_servers.orchestrator.url=…`). It then shows in `ps` and in the `runner.spawned` args, which only hide the prompt.
- **Where:**
  - `packages/shared/src/bots/definition.ts` l.124–145 (`checkBotSafety`: no engine rule for `lead`)
  - `apps/web/components/bots/logic.ts` l.28–31 (`ENGINE_LOCKS`: apply and cv only)
  - `apps/orchestrator/src/api/routes/bots.ts` l.60–65
- **Why:**
  - §3 rule 5: "Lead's CLI session runs with **no** browser, Figma, shell or file-write tools." §5.2 assigns Lead to Claude. The six-tool limit is only real on Claude, through `--tools`/`--allowedTools` and `--strict-mcp-config`.
  - One click on the Bots screen silently turns "Lead only divides work" into a prompt-only rule. It also exposes the capability.
- **Acceptance:**
  - `checkBotSafety` refuses `lead` on any engine but `claude`, with the message "lead: Lead must run on Claude, where its only tools are the orchestrator's (rule 5)". bot.json loading, `PATCH /bots/lead` (403) and the spawn-time trust guard therefore all refuse it.
  - `ENGINE_LOCKS.lead` = "Locked to Claude: Lead only divides work, and its tool limit holds only on Claude."
  - Tests:
    - the shared rule;
    - the API 403;
    - the bot card's disabled switch with the reason;
    - a DB row already set to `codex` makes start-up refuse (degraded start with the reason), not run Lead on Codex.

### M2. A local process without an Origin header can approve a review card
- **What:**
  - `api/security.ts` l.66–70 checks Origin only when one is present. The CSRF header is a public constant (`x-bsja-csrf: 1`).
  - So any process on the Mac can call `POST /review/:jobId/approve` (and `/tasks/:id/resume {confirmDomain}`, which widens a token's domains). That covers `curl` and Node `fetch`.
- **Why it matters now:**
  - The Phase 1 product rule is that Ba says yes before every submission.
  - Codex Research's Chrome plugin is a JavaScript REPL (`cua_repl`). It runs as an MCP server outside Codex's sandbox, so it very probably has network access. An injected job page that takes over Research could:
    1. read `GET /review` to get the job and `cvVersionId`;
    2. approve the card with no Origin header;
    3. let Apply submit with no human in the loop.
  - Claude bots have no shell or out-of-page fetch. Page JavaScript always sends an Origin header on POST, so it is refused today.
- **Where:** `apps/orchestrator/src/api/security.ts` (the request guard).
- **Acceptance:**
  - Every mutation (POST/PUT/PATCH/DELETE) needs an `Origin` that is one of `ORCH_WEB_ORIGINS`; a missing Origin is a 403 like a foreign one. GETs are unchanged.
  - The Next rewrite already forwards the browser's Origin, and `serverClient()` makes no mutations. Confirm both with a test, and keep e2e green.
  - Tests: approve, resume and bot PATCH with no Origin → 403, and nothing changes in the database (extend `security-routes.test.ts`).
  - README "Orchestrator settings" says the API refuses mutations from anything but the web app.
- **Limits (said plainly):** Node can forge an Origin header, so this stops naive payloads, not a determined one. The real fix is E1 option A (§5), which leaves no bot with code execution plus network. We considered a per-boot secret header added by a Next middleware and dropped it: a Codex sandbox can read the whole disk, so the secret would be readable too.

### M3. "Save to my criteria" does nothing live (UC-21b a)
- **What:**
  - In live mode the chip only sends its label back to Lead as Ba's message (`api/routes/chat.ts` l.97–133). Lead has no tool that saves criteria (rule 5), so nothing is saved. Lead may even reply as if it had.
  - The mock really saves a new version (`lib/api/mock/sim.ts` l.621), so e2e `chat.spec` passes on behaviour that does not exist live.
  - `bots/lead/ROLE.md` l.11 tells Lead to offer this choice.
- **Why:** UC-21b a and the approved prototype ("Saved to your search criteria (now v4)"). A button that looks like it worked but did nothing breaks Ba's trust in every other card.
- **Design (keeps Lead at six tools; Ba's click is the consent):**
  1. Add a `LeadAction` member to `packages/shared/src/bots/lead.ts`: `{ type: "propose_criteria_change", changes: <partial §7.5 fields, e.g. addLocations / removeLocations / roles / minSalary …> }`. This is an additive union member, and the strict JSON Schema is regenerated.
  2. The chat sink validates `changes` against the active profile with the same rules as `PUT /criteria`. It stores a server-side pending proposal (`data/api-state.json`, as dismissals are) and posts a `choice` card with key `criteria-save:<proposalId>` and options `just_this_run` / `save`. The card text is computed by the server from the stored proposal ("Add Đà Nẵng to locations"), never taken from Lead's wording.
  3. In `POST /chat/choices`:
     - `criteria-save:<id>` + `save` → the API writes a new profile version from the stored changes, settles the card and posts "Saved to your search criteria (now v<n>)". It does **not** start a run.
     - `just_this_run` → the label goes back to Lead as today, and Lead starts the run with per-run overrides.
     - The card is single-use, and a second click is a 409.
  4. The mock follows the same keys, so the mock and live behave alike.
- **Acceptance:**
  - API tests: save writes exactly one new version with the stored change; a forged key or option is a 404/400; a replay is a 409; a proposal that fails validation never produces a card.
  - Web test: the chip calls `/chat/choices` with the typed key.
  - e2e on the mock passes unchanged.
  - W4c then words ROLE.md around the new action (§6).

## 3. SHOULD-FIX

| # | Owner | Item | Why / acceptance |
|---|---|---|---|
| S1 | F4 | **UC-21 schedules through Lead:**<br>• `LeadAction propose_schedule { name, repeat, time, searchProfileId? }`<br>• same mechanism as M3 (card key `schedule-create:<id>`; the server computes the "Runs: Weekdays 09:00" summary and the next run)<br>• Ba's click creates the schedule | Spec §7.4 "or via Lead ('scan every weekday at 9')". Shares M3's code. Test as in M3. |
| S2 | F4 | **A Lead-started "apply again" is invisible on the card.** `engine/lead-tools.ts` l.133 lets Lead pass `applyAgain: true`, and Lead's input includes untrusted history and `get_result` output. | Add an additive `ReviewCardFlags.appliedBefore` (with the earlier application's date and status) and a visible notice on the card. Ba must know before approving a second application to the same job (§10.2 rule 5). W4c: Lead sets `applyAgain` only on Ba's explicit words. |
| S3 | F4 | **The record panel loses the approval details before a submission row exists.** `db/mappers.ts` l.174–176 returns no record without a submission. Approved, applying, paused or `needs_check` applications therefore show no approval time, CV version or allowed sites. | UC-13 lists them. `ApplicationDetail` carries the approval summary separately (additive). Never the token. |
| S4 | F4 | **Rule 3 stops halfway.** Approving a `propose_workflow` saves a copy of the base workflow; its preset params go only into a YAML comment (`api/proposals.ts` l.133–137). `StartWorkflowInputSchema` accepts only the three shipped names, so an approved workflow can never be started. | **Phase 1 meaning of "becomes a workflow":** a saved preset = base workflow + stored params.<br>• Store the params as data.<br>• `start_workflow` accepts a saved preset name and starts its base workflow with those params.<br>• The flow list shows the preset's name.<br>Test: approve → Lead starts it by name → the run uses the preset params. |
| S5 | F4 | **Replies and "Lead is working":**<br>• Drop the 90 s typing-indicator cutoff (`ChatScreen.tsx` l.23) and drive it from the conversation task's `task.started` / `task.progress` / `task.finished`.<br>• Under the indicator, show Lead's tool calls as one-line progress ("start_workflow job-scan…", "get_status run 13") from `task.progress`.<br>• Turn off the mock's fake token streaming, so the mock matches live. | A live Lead turn on Opus with tool calls often takes over 90 s. Showing tool steps is what makes harness UIs feel alive (the owner's "wow"). No real `message.delta`: replies are structured JSON. |
| S6 | F4 | **Flow canvas follows the run (UX D1, §7).**<br>• When nodes are added (branches appear), re-fit with animation unless Ba has panned or zoomed since the last fit.<br>• Clamp the fit's minimum zoom to ~0.6, so node text stays readable; at that floor, centre on the running node instead.<br>• Keep the running node in view. | Today a live run's branches appear off-screen to the right. A finished 3-branch run fits at a zoom where node text is about 6 px, unreadable at 1440×900. e2e: after a branch is added the running node is inside the viewport, and node titles render at ≥ 11 px. |
| S7 | F4 | **Small UI items:**<br>• favicon (`app/icon.svg`, the "J" brand mark);<br>• chat auto-scroll keeps following a run card while it grows;<br>• the narrow header truncates the page title to one letter at phone width (hide the "Sample data" badge text below `sm`);<br>• `exports` CSV: add `cv_version`, `cv_language` and `partial_record` columns. | Each is XS. The favicon 404 shows in every browser session (QA). |
| S8 | F4 → W4a | **Scan-output check port:** a `ScanOutputChecker` hook where a `research.scan` output settles (default: accept). It returns `ok` or `{ adapterBroken, reason }`, and its result drives UC-03 b ("<source> adapter broken" plus the screenshot or "not captured"). | W4a owns `src/adapters/**` but not `engine/**`, and the engine has no such seam (`adapters/index.ts` is `export {}`). F4 adds the port and its test. W4a implements it. |
| S9 | W4b | **One e2e lane on the real orchestrator:** orchestrator (FakeRunner, temp data folder) + web in live mode, through the Next rewrite. Cover:<br>• chat → run card;<br>• Flow nodes update over SSE;<br>• approve → the Apply node unlocks;<br>• request changes → new round;<br>• skip;<br>• UC-21b save (M3). | §12 says "Playwright + FakeRunner". Today every e2e test runs on the web mock, which is how M3 slipped through. |
| S10 | W4b | **Real light/dark checks:** `toHaveScreenshot` with a small threshold for the main screens in both themes. | `screenshots*.spec.ts` only asserts that a PNG is over 10 KB (§12 "light/dark screenshot checks"). |
| S11 | W4a | **LinkedIn limits (UC-03 c):** ≤ 40 page views per scan and a 3–8 s random delay between pages, enforced by the checker (`pageViews` is in the schema, but nothing enforces it) and stated in the skill. | Spec UC-03 c. |
| S12 | W4c | **Imported applications (UC-13):** a one-off `apps/orchestrator/scripts/import-applications.ts` that reads `data/imported-applications.yaml` and calls `importApplication()` (`db/repos/applications.ts` l.401) with `origin: imported`. It copies each PDF into `data/applications/<id>/` and computes its SHA-256.<br>Commit `data.example/imported-applications.yaml` with the three TopCV rows:<br>• DEKON 2316742, 15:40;<br>• SMARTBIT 2298533, 15:44;<br>• YAVIET 2325969, 15:38;<br>all on 2026-10-10, with URLs and PDF names as in the prototype. The PDFs are in `/Users/bason/Documents/Codex/2026-09-23/i-m-software-engineer-and-i/output/pdf/`. | Re-running the script does not duplicate rows (keyed by URL). Missing parts show "not captured". Ba checks the three rows once in the app. |
| S13 | W4c | **Master CV seed:** `data.example/master-cv.yaml`, built from `/Users/bason/Documents/Codex/2026-09-23/i-m-software-engineer-and-i/build_targeted_resumes.py` (Gradion, Aegona, Apps Cyclone, skills, education) and the Figma file's text, with EN and VI where both exist. | §6.1. It must pass `MasterCvSchema` (test). Ba reviews it once. |

## 4. Decisions on the QA open items

1. **UC-21 "by telling Lead" (schedules).**
   - **Decision:** build it without a seventh tool: Lead proposes, and Ba's click on a server-validated card creates the schedule (S1, F4, same code as M3).
   - **Why:** rule 5 lists Lead's six tools, and a schedule fires work unattended. Ba's click is the consent.
   - The spec text stays; it does not say Lead creates the schedule itself.
2. **UC-21b a "save to your criteria".**
   - **Decision:** must-fix M3, with the same mechanism. "Just this run" stays as it is: Lead's `start_workflow` with overrides.
3. **UC-24 "an old CV → offer to import facts".**
   - **Decision:** defer past Phase 1's build; this needs the owner's OK (escalation E2).
   - Until then, Lead's ROLE.md (W4c) answers an uploaded CV with "I can't import facts from a file yet. Add them on the Master CV screen", plus a link card.
   - W4c's seed covers Ba's current facts anyway.
   - A later build: a `cv.import_facts` task returns proposed facts, and Ba confirms each one on the Master CV screen as a fact request.
4. **UC-13 imported DEKON / SMARTBIT / YAVIET applications.**
   - **Decision:** a one-off script plus a YAML file (S12, W4c).
   - The prototype already holds their URLs, times and PDF names, so Ba only checks the three rows. No API route: imports are a one-time, local action.
5. **UC-13b weekly auto-export.**
   - **Decision:** defer, as optional and off by default per the spec (escalation E2).
   - The manual "Export all (ZIP)", the data folder path and the last export date are built.
6. **"Edit criteria" on a run card.**
   - **Decision:** not needed. The approved prototype has no such button. The schedule editor has the "Edit criteria" link, and the sidebar has Search criteria.
   - Spec UC-21b's trigger is aligned with the prototype in this commit (§9).
7. **No-Origin mutations and CSRF.**
   - **Decision:** M2. Require a web Origin on every mutation. No per-boot secret.
   - The real mitigation is E1 option A. W4b's runbook records the two live checks (§8).
8. **Reply streaming (`message.delta`).**
   - **Decision:** no token streaming in Phase 1. Lead's reply is a structured JSON object, so partial text is not meaningful.
   - Instead, S5: a task-driven "working" indicator that shows Lead's tool calls as they happen. The mock stops faking a stream.
   - `message.delta` stays in the event schema, unused.
9. **Favicon.**
   - **Decision:** add `app/icon.svg` (S7, F4).
10. **E1, Research's engine (still pending with the owner).**
    - **Decision for Phase 4:** no live Research scan, fit or company task runs on Codex unless Ba has answered B or C in owner-decisions.md.
    - W4c switches `bots/research/bot.json` to `"engine": "claude"` (option A, the recorded default) in the commit that adapts Research's ROLE.md to Claude's tool names. That commit bumps `promptVersion` and runs `pnpm bots:lock`.
    - W4b verifies the result live before the first scan:
      - Research on Claude gets `--chrome` with the site guard for `scan`/`single`, and no `--chrome` for `fit`/`company`;
      - `skill:source-*` maps to `Read(./skills/**)`;
      - the Bots screen's residual-risk note disappears.
    - M2's finding makes option A stronger. Escalation E1 is updated in §5.
    - If Ba picks B or C, W4b first runs the `cua_repl` network check (§8). If the REPL can reach `127.0.0.1:4100`, B and C are not safe and we go back to Ba.

## 5. Owner escalations

**E1 (update). Research's engine: decide before the first live scan.**
- Nothing changed in the recommendation (option A, Research on Claude).
- **New finding:** on Codex, Research's Chrome plugin is a JavaScript REPL that very probably has network access. An injected job page could use it to approve review cards through the local API, which means applications sent without your yes. M2 blocks the naive form of this; a determined payload can still forge the header.
- **If you have no answer by W4b's first live scan:** option A is applied, as recorded.

**E2. Two spec use cases deferred past Phase 1's build (confirm or overrule):**
- **(a) UC-24, importing facts from an old CV** (decision 3).
- **(b) UC-13b, the optional weekly auto-export** (decision 5).

Both are scope reductions, so they are your call. The default is to defer both. Building both would add roughly one fixer slice.

**FYIs (no decision needed unless you disagree):**
- **(a) Saved workflows (rule 3):** in Phase 1 an approved proposal is a saved preset of one of the three workflows (S4). It never becomes a new step graph.
- **(b) Schedules from chat:** Lead proposes a schedule and you confirm it with one click (S1). It is never created without your click.
- **(c) No live token streaming:** replies arrive whole, and you see Lead's tool steps while it works (S5).

## 6. UX differences from the prototype (prioritised)

The app matches the prototype closely on every screen. Copy samples checked against the prototype all match, including:
- the consult banner and greetings;
- the "Lead →@Bot" trace, "Open review queue", "Just this run" / "Save to my criteria" and the UC-12 card;
- review's "Approve & submit", "Request changes…" and "Skip (give reason)";
- applications' header and imported note, criteria's "+ add, press ↵", the schedules' footnote, the Bots promote copy and rooms' discussion-mode line.

The differences, most important first:

| # | Screen | Difference | Fix |
|---|---|---|---|
| D1 | Flow canvas | During a live run, new branches appear off-screen; a 3-branch run fits at an unreadable zoom (node text ~6 px). The prototype's nodes are readable at 1440 px. | S6 (follow + minimum zoom). |
| D2 | Chat | "Save to my criteria" works only on the mock (M3). | M3. |
| D3 | Chat | Lead's turn shows a typing indicator that stops after 90 s, with no tool steps. Harness UIs show the agent's steps live. | S5. |
| D4 | Chat | The chat stops scrolling while a new run card grows below the fold, so the later trace rows (CV, QA) are hidden until Ba scrolls. | S7. |
| D5 | Review | A Lead-started "apply again" card looks like any other card. | S2. |
| D6 | Applications panel | No approval details before submission. | S3. |
| D7 | Shell | No favicon. | S7. |
| D8 | Phone width | The page title collapses to one letter next to "Sample data" + Simulate; the run card header wraps into three lines. Phase 1 is a Mac app, so this is low. | S7 (title); the rest later. |
| D9 | Chat | `job` cards (§11 "job cards with fit/QA") are never sent. The review summary lists the jobs in text with "Open review queue", as the prototype does. | No change: the prototype is the approved UX. |

**Better than the prototype (keep):**
- the Flow toolbar's run status, trigger, start time and criteria version;
- the stacked map nodes;
- the step drawer's per-source tabs, attempt, prompt, duration, self-check and transcript;
- "View the posting", company source links, the "needs your input" box with a link to Master CV, and QA round chips;
- the record panel's "View as form";
- the Master CV contact card and inline fact editing;
- the bot detail page with the trust ladder, Restore and Dismiss;
- the demotion notice;
- the Research residual-risk note.

**"Wow" ideas for later (not blocking, ElevenLabs-Flows-style):**
- the last transcript line as a live preview inside a running node, plus an elapsed timer;
- a short pulse on an edge when a branch hands work to the next bot;
- a one-line run timeline above the canvas.

S6 and S5 are the two that matter most for the feeling of watching bots work.

## 7. Test quality

- **Strong:**
  - Behaviour-level orchestrator tests on real SQLite and FakeRunner, with spec references.
  - Contract parity tests on both sides, and S18 checks on every route.
  - No `.skip`, `.only`, `.todo` or `fixme`, and no `waitForTimeout` in e2e.
- **Weak:**
  - **All 144 e2e tests run on the web mock.** Where the mock does more than the server, e2e proves behaviour that does not exist live (M3, streaming). S9 adds a live-shape lane; M3 and S5 bring the mock back in line.
  - **The light/dark "screenshot checks" are not comparisons** (S10).
  - **No e2e covers the Apply node unlocking on the canvas after an approval** (S9).

## 8. Briefing for Phase 4 workers

### All workers
- **Checks:** run them with `--force` and run e2e on your own `E2E_PORT`. Never call real CLIs, Chrome or Figma in automated tests.
- **Contract:** a new route needs an `API_CONTRACT` row, and the web needs a call or an `UNUSED` reason. The parity tests fail otherwise.
- **Safety:** everything a bot returns is untrusted: paths, sites, labels, URLs and choice labels. Typed choice keys are acted on only with server-stored payloads (M3).

### F4 (fixer, before Phase 4)
- **First merge (before Phase 4 starts):** M1–M3, S1 and S8.
- **Second merge (alongside Phase 4, before W4b's dry run):** S2–S7.
- **Contract updates:** update the mock and `API_CONTRACT` with every API change.
- **Report:** list the new `LeadAction` members and choice keys for W4c.

### W4a: source adapters
- **Wait for F4's S8 port,** then implement the checker in `src/adapters/**`, with layout-change detection and the LinkedIn limits (S11). Use saved-HTML fixtures for TopCV, ITviec, LinkedIn and one career page (§12).
- **Skills** go in `bots/research/skills/source-*/`. On Claude (E1 option A) Research reads them through `Read(./skills/**)`.
- **UC-03 b's screenshot:** on Claude it comes from S7's capture pipeline; otherwise record "not captured" plus the page URL.

### W4b: end-to-end, runbook, live checks, dry run
- **First:** add the live-shape e2e lane (S9) and the real light/dark comparisons (S10).
- **`docs/runbook.md`:** setup (`ORCH_DATA_DIR` without spaces, `ORCH_WEB_ORIGINS`, `ORCH_NOTIFY`, the lock file, launchd), then these live checks before the dry run. Record the result of each in the runbook:
  1. **Chrome extension connected:** `/bridges` reports Claude in Chrome connected. The Chrome site permissions for the bot's sites are set, and how the extension enforces them headless is noted (pm-phase-2 decision 10c). F3's S7 check was blocked by "Browser extension is not connected"; start here.
  2. **Screenshot image format:** one Apply-mode screenshot of a page on `127.0.0.1` through the runner. Confirm the stream-json image block shape matches F3's synthetic fixture, that a file lands in `data/screenshots/<task>-<attempt>/` with a manifest, and that the transcript holds a reference, not base64. Commit the captured shape as a fixture if it differs.
  3. **Tab cleanup:** after a browser task, the bot's tab group has no leftover tab, including the empty New Tab. List anything Ba must close by hand.
  4. **Figma bridge live export:** with Figma desktop and the Desktop Bridge plugin open, run one CV task on a throwaway Drafts frame. Check:
     - the protected-page fingerprint is unchanged;
     - the PDF is exported by the orchestrator, one A4 page, with text extractable in reading order;
     - `needs_figma` → Done → resume works when the plugin is closed and reopened.
  5. **Codex with `node_repl` off:** if Research stays on Codex, or for QA, a `codex exec` browser-setup session lists only the Chrome plugin's tools, web search and the built-ins. Confirm `node_repl` is disabled and Chrome still works. Then check whether `cua_repl` can `fetch('http://127.0.0.1:4100/health')`. If it can, record it and stop: Codex Research is not safe (E1).
  6. **Codex sandbox network:** inside `codex exec --sandbox read-only`, `curl http://127.0.0.1:4100/health` fails. This confirms QA consult on Codex can't reach the API.
  7. **E1:** confirm Research runs on Claude (option A) unless owner-decisions.md says otherwise, and that the Bots screen shows no residual-risk note.
- **Dry-run acceptance (§12):**
  - Run it on a job Ba wants anyway, with the approve dialog's "Dry run".
  - Apply fills the form and screenshots it, and never submits.
  - The card comes back with "Approve live & submit".
  - The record has both screenshots; the dry run is labelled and left out of the export.
  - Needs both F4 merges, Phase 2's S7 (already merged) and W4c's ROLE.md.

### W4c: ROLE.md prompts, master CV, imports
- **Every ROLE.md change** bumps `promptVersion` in the same commit, plus `pnpm bots:lock` (S6 lock test).
- **Lead:**
  - use `propose_criteria_change` and `propose_schedule` (M3/S1) instead of promising to save;
  - set `applyAgain` only on Ba's explicit words (S2);
  - answer an uploaded old CV with the Master CV pointer (decision 3);
  - ask one question at most (UC-01 a), and offer merge or second run (UC-01 b);
  - send Ba to Master CV when it is missing (UC-01 c);
  - treat `get_result` output as data.
- **Research:**
  - Claude tool names (E1 option A, and switch `engine` in bot.json);
  - read-only;
  - report injections (`injectionSuspected`);
  - close every tab it opened, including the group's empty tab.
- **Apply:**
  - name screenshots by the tool's id, never `save_to_disk`;
  - pause on any site change;
  - report injections;
  - close its tabs.
- **CV:** cite `factIds` on every bullet; raise `factRequests` instead of inventing; Drafts page only.
- **QA:** hard-fail rules from §5.2; `injectionSuspected`.
- **Data:** the master CV seed (S13) and imported applications (S12).

## 9. Spec wording fixes

**Applied in this commit** (aligns the spec with the approved prototype):
1. **UC-21b trigger:** "or the Edit criteria link in a schedule's editor". The approved prototype has no "Edit criteria" button on a run card.

**Proposed, not applied** (they change the letter of a use case, so they wait for E2):
- **UC-24 main flow 3:** "an old CV → (later phase) Lead points Ba to the Master CV screen".
- **UC-13b:** "The optional weekly auto-export is planned after Phase 1."
- **§3 rule 3:** "In Phase 1 a saved workflow is a named preset of a shipped workflow (its params), started by Lead by name."
