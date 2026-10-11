# QA/QC report: Phase 3 (API, MCP, chat, UI screens, wiring)

- **Branch:** `worktree-agent-a74bc50f45979d745`, from `develop` at cca3377 (W3a parts 1–2, W3b, W3c, W3d, F2, F3 merged). 17 commits before this report; every fix test-first.
- **Result:** the definition of done passes uncached: install, typecheck, lint, test, build and e2e are all green (§1).
- **Scope:**
  - the wiring F3 and W3d left open;
  - an automated contract audit (API ↔ web client ↔ mock, events, error codes);
  - UC-01..UC-25 walked through the API and UI, plus the §11 rules on every screen;
  - an S18 security re-check;
  - a live smoke run on the real CLIs.

## 1. Checks

| Check | Baseline (cca3377) | Final (HEAD) |
|---|---|---|
| `pnpm install` | ✅ | ✅ |
| `pnpm -w typecheck --force` | ✅ 4/4, 0 cached | ✅ 4/4, 0 cached |
| `pnpm -w lint --force` | ✅ | ✅ |
| `pnpm -w test --force` | ✅ 2,382 (shared 380, web 451, orchestrator 1,551) | ✅ 2,431 (shared 384, web 467, orchestrator 1,580) |
| `pnpm build --force` | ✅ 3/3 | ✅ 3/3 |
| `pnpm e2e` (`E2E_PORT=3233`) | ✅ 135/135 | ✅ 144/144 |

## 2. Wiring finished

| Item | What now happens | Commit |
|---|---|---|
| `companyMissing`, `dryRunSettled` | Both flags are in the shared `ReviewCardFlagsSchema` (additive, optional) and the API always sets them.<br>A settled dry run puts its card back in the queue, even after its run finished, with only the dry run's CV. Approve applies live and the card leaves.<br>A dry run that reported "submitted" stays out of the queue until Ba marks it failed.<br>The engine predicate `isDryRunSettled` mirrors `approveLiveAfterDryRun`'s checks, so the card shows only when Approve would work.<br>Skip now closes a settled dry-run card (the engine refused it before). | 637c325, 9c2583b |
| `POST /tasks/:id/decline-domain` | In `API_ROUTES`; calls `engine.declineDomain`. Responses: 200 `{ok}`, 409 when the task is not waiting for a domain, 404, and 403 without CSRF.<br>The web posts it from "Don't allow". The "arrives with the next update" copy is gone, and W3d's pending test is flipped. | b13063d, 881beb9 |
| `BotView.demotion` | Filled from `latestBotDemotion` as `{ fromLevel, at, reason }`.<br>A PATCH that raises the bot to its demotion's level (capped: Apply L1) goes through `engine.restoreBot`. | c2d5daa |
| Memory note delete | Uses the runner's `removeMemoryNote`, under the same per-bot lock as appends.<br>**Defect:** a delete racing an engine append brought the deleted (possibly poisoned) note back. A regression test reproduced it. | c2d5daa |
| `figma-change:<taskId>` "was_me" | Goes to `engine.protectedChangeWasBa`: the demotion is undone and the step re-runs. Ba's answer and a short Lead note are posted.<br>**Defect:** before this, the choice queued a `lead.chat` CLI task, which could do nothing. | aa393fa |
| `getTranscript` | Uses the shared `TranscriptResponseSchema`. Saved and live lines render through one view (`lib/api/transcript.ts`).<br>**Defect:** the web-local shape made every saved transcript a `bad_response` in live mode, so the drawer showed an error. | 881beb9 |
| Sidebar after a room is created | The shell exposes `refresh()`, and RoomsScreen calls it after a create. An e2e test asserts the new room appears in the sidebar. | 5c3fdc5 |
| Web-local schema extensions | Removed: `ReviewCardFlagsExt`, `ReviewQueueResponseExt`, the extended `ApproveResultSchema`, the local transcript schemas, `PROPOSED_ROUTES`, `supportsDryRun`, `supportsConfirmInjection`. | 881beb9 |

## 3. Other defects found and fixed

| # | Found | Fix | Commit |
|---|---|---|---|
| 1 | **Confirm-injection disabled in live mode** ("arrives with the next orchestrator update"), though the API served it since W3a part 2. A flagged job could never be approved live (UC-07 b). | The button is always enabled. Component test in live mode. | 881beb9 |
| 2 | The sidebar's Chrome status was hard-coded `true` in live mode, although `GET /bridges` exists. | The status is read from `/bridges`: an engine reporting `false` shows "not connected"; unknown (null) does not alarm. `bridge.status` keeps it live. | 881beb9 |
| 3 | "Request changes" was offered on cards the engine refuses it for: approve-again and a settled dry run (409). | The button is hidden on those cards. | 881beb9 |
| 4 | `POST /chat/messages` was parsed with `ChatSendResponseSchema`, but the server answers `ChatSendResultSchema`.<br>The mock's `POST /chat/choices` answered nothing, while the server posts Ba's answer message. | Both now use the server's shape (found by the parity test). | 22bd5ee |
| 5 | `GET /runs` returned its body without `respond()`, so it was not checked against the shared schema. | Uses `respond(RunsResponseSchema)`. | a1093b6 |
| 6 | The SSE URL was a literal `/events`. | Built from `API_ROUTES.events`. | 22bd5ee |
| 7 | SSE frames bypassed the token guard (S18 backstop). | A frame that would carry a stored approval token is dropped and logged. | 1a2e374 |
| 8 | A CSV formula after leading spaces (`" =HYPERLINK(…)"`) was not defused. | Fixed. Tests now pin `csvCell` and `Content-Disposition` (CR/LF/quote injection). | 1ab01c4 |
| 9 | A malformed MCP capability URL (`/mcp/%E0%A4%A`) caused a 500. | Now 404. | 3dcec92 |
| 10 | §10.3 "Chrome not open → Ba gets a notification": only Lead's pause, question and review cards notified, so a `needs_browser` or `needs_figma` wait was silent. | One macOS notification per wait (throttled per reason, 30 min). | 1ddb38c |
| 11 | e2e cursor check: an autocomplete text box (`role=combobox` on an input) was flagged as needing a pointer cursor. | The helper excludes text boxes. | de5906c |

## 4. Tests added (+49 unit/integration, +9 e2e, plus new assertions in existing e2e)

| File | What it covers |
|---|---|
| `shared/api/api-qa3.test.ts` (4) | The new flags, the decline route, and `API_CONTRACT` covering every `API_ROUTES` key. |
| `orchestrator/api/routes/review-flags.test.ts` (6) | `companyMissing`; `dryRunSettled` back in the queue → live approve; a "submitted" dry run blocked until Ba settles it; Skip; Request changes 409. |
| `…/decline-domain.test.ts` (3) | UC-11 e through the API: needs_check, token not widened, safety event, 409/404, CSRF. |
| `…/bots-qa3.test.ts` (4) | Demotion view, restore via the engine, Apply cap, the delete/append race. |
| `…/figma-choice.test.ts` (2) | "That was me" restores CV and re-runs the step; no Lead task; wrong key 404. |
| `…/events.test.ts` (+1) | No approval token in SSE, replayed or live. |
| `…/notify.test.ts` (+1), `export-helpers.test.ts` (5), `mcp.test.ts` (+2 asserts) | Bridge-wait notification, CSV and Content-Disposition, malformed capability. |
| `orchestrator/api/contract-parity.test.ts` (4) | **Contract audit, server side** (§5). |
| `orchestrator/api/security-routes.test.ts` (3) | S18 on every contract route: foreign Host (GET too), no CSRF, foreign Origin, cross-site, form posts. Nothing changes in the database. |
| `web/lib/api/parity.test.ts` (7) | **Contract audit, web side** (§5), plus the event parity check. |
| `web/lib/api/transcript.test.ts` (3), `web/components/review/ReviewCardItem.test.tsx` (4), `web/lib/api/http.test.ts` (+2) | Transcript mapping; the review card in live mode; `/bridges`; decline route. |
| `web/e2e/screen-rules.spec.ts` (+9), `web/e2e/rooms.spec.ts` (+1 assert), `web/e2e/shell.spec.ts` (+2 paths) | The §11 rules on every route; the sidebar after a room is created; centering for `/bots/apply` and `/rooms`. |

## 5. Contract audit

- **One table:** shared `API_CONTRACT` gives, for every `API_ROUTES` key, the methods and their body, query and response schemas. Its type refuses a route with no row.
- **Server parity** (`contract-parity.test.ts`), fails on drift:
  - every contract method and route is registered (`hasRoute`);
  - every `app.<m>(API_ROUTES.x)` in `routes/` is in the contract, and no literal-path routes exist;
  - each handler's `respond(X)` and `parseWith(X)` are the contract's own schema objects.
  - Two deliberate local variants are listed with their reasons: approve's strict body and its result with `reapproval` always present.
- **Web parity** (`parity.test.ts`):
  - every `("M", API_ROUTES.x, { schema })` call in `lib/`, `components/` and `app/` is in the contract and uses the contract's response schema;
  - every contract route is called, or listed as unused with a reason (`GET /status`, `POST /runs`, `GET /schedules/:id`, `GET /exports`);
  - each typed WebApi method really sends its route (checked with a fetch double);
  - every `MOCK_ROUTES` entry is a contract route with the identical response schema;
  - the mock serves every route the web calls.
- **Events:** every AppEvent type the UI handles is emitted somewhere in the orchestrator. The one exception is `message.delta` (replies are posted whole; listed as mock-only).
- **Error codes:** the web's `ApiErrorCode` is typed from the shared schema. The UI special-cases `already_applied` (sent by approve-live and the unique-violation path), `not_found`, `conflict` reasons, `prompt_version_stale` and `master_cv_invalid`; all of these match what the server sends. `engine_paused` is unused on both sides.

## 6. Spec and prototype audit (Phase 3)

- **Covered in live mode:** UC-02, 05, 06 (engine), 07, 08 (VI/EN, intro, dry run), 09, 10, 11 e (Allow / Don't allow), 12, 13, 14, 15, 16, 17, 18, 19, 20, 22 (now with a working saved transcript), 23, 25.
- **§11 rules:**
  - No native controls anywhere.
  - The global cursor rule holds on every route (e2e).
  - Narrow and wide pages are centred (e2e, now 8 paths); chat, flows and `rooms/[id]` are full width by design.
  - Every file opens in FileViewer first. The only direct downloads are the one inside the viewer and the export ZIP (e2e `directFileLinks`).
- **Prototype copy (sampled):** consult banner, "Open Lead chat", "Handed over from", Export all, Run now, Create one, Undo, "Chrome not connected", and S24's off-site domain copy all match.
- **Gaps for the PM** (not fixed here; behaviour or ownership decisions):
  1. **UC-21 / §7.4 "or by telling Lead"** (schedules): Lead has no tool that writes a schedule. Rule 5 limits Lead to six tools. Decide: add a tool, or keep schedules screen-only and change the spec.
  2. **UC-21b a "save to your criteria?"**: the chip only sends its label back to Lead, which has no tool to save criteria, so nothing is saved. The prototype saves a new version. Needs the API to act on a `criteria` choice key, or a Lead tool. Medium size.
  3. **UC-24 "an old CV → offer to import facts (Ba confirms each)"**: nothing implements it. There is no task kind, and no server-side `fact_request` cards in chat. Phase 4 or a decision.
  4. **UC-13 imported applications** (DEKON / SMARTBIT / YAVIET): there is no route or script to create `origin: imported` rows. The UI already renders them. Suggest a one-off import script.
  5. **UC-13b weekly auto-export:** not built (no API, no UI). Known since W3c.
  6. **UC-21b trigger "Edit criteria" on a run card:** absent, and the prototype has none either. Confirm it is not needed.
  7. `message.delta` streaming is not implemented on the server: replies appear whole.
- **Phase 4 (not gaps now):**
  - Lead prompt behaviour: UC-01 a/b, UC-14 a.
  - Source adapters and the "adapter broken" note with a screenshot (UC-03).
  - The S7 live screenshot check and the dry-run acceptance (UC-11).

## 7. Security re-check (S18)

- **OK, with tests:**
  - Host, X-Forwarded-Host, Origin, Sec-Fetch-Site and CSRF checks, and JSON-only bodies. These are now also tested on every real route (§4).
  - No CORS; the Next rewrite has a host guard.
  - Tokens never appear in JSON (route tests plus the onSend backstop), in SSE (new), in the transcript (redaction), or in the export ZIP. Logs carry the URL only.
  - Files are served by id only, inside `data/`: no symlinks or `..`, magic bytes checked, nosniff, a safe Content-Disposition.
  - Uploads: type and 10 MB limits; stored by content hash with mode 0600; the client's file name is never used as a path.
  - Export: ASCII folder names, CSV defused, dry runs left out.
  - MCP capability:
    - per spawn, 256-bit, only its SHA-256 stored;
    - revoked in `finally` (also when the spawn throws), with a TTL;
    - every call checks the task still runs;
    - consult and room capabilities list no tools;
    - binds 127.0.0.1; foreign Host or browser Origin → 403; malformed → 404 (new).
- **Residual risks (decisions for the PM):**
  - A mutation **without** an Origin header is accepted when Host is loopback and the CSRF header is present. Any local process can therefore call `/review/:id/approve`. That includes a bot that gains a shell and network (Codex read-only sandbox, E1). No bot has that combination today.
  - Uploads buffer up to 10 × 10 MB in memory per request.

## 8. Live end-to-end smoke (real CLIs, throwaway data)

- **Setup:** `ORCH_DATA_DIR` = a temp folder without spaces, `ORCH_NOTIFY=0`, `ORCH_PORT=4177`, `ORCH_WEB_ORIGINS=http://localhost:3277,…`. Web on 3277 with `BSJA_API_MODE=live`. Claude Code CLI plus the ChatGPT app's codex.
- **Every screen walked in the browser:** chat, chat/qa (consult banner), flows, review, applications (data folder shown), criteria (first-save state), schedules, bots, bots/apply, cv (create state), rooms.
  - Each rendered its live empty or first-run state.
  - No "Sample data" badge: live mode was confirmed.
  - `/bridges` reported both extensions connected.
- **Lead:** one message, "What can you do? … don't start any work". Lead (Claude) answered with its capabilities. The reply appeared in the open chat over SSE, without a reload.
- **QA consult:** one question, "what do you check first when you score a CV?". QA (Codex) answered within its role, in consult mode, and the reply appeared over SSE.
- **Nothing else ran:**
  - exactly 2 tasks (`lead.chat`, `qa.consult`, both done), 0 runs, 0 applications;
  - events were only `task.*`, `message.created`, `engine.usage` and `runner.spawned`;
  - no Chrome, Figma, scan or Apply;
  - the capability URL never appeared in the transcripts;
  - `GET /tasks/1/transcript` answered in the shared shape (7 lines);
  - the orchestrator log had only 200/201 responses, plus the expected 404s for criteria and master CV on a fresh data folder;
  - the web log had no errors. The only browser console error was a missing `favicon.ico` (404).
- **Clean-up:** both servers stopped; the throwaway data folder deleted.

## 9. Open items for the PM

1. The gaps in §6 (items 1–6), especially UC-21b a, where the chip has no effect, and UC-21 "by telling Lead".
2. The residual S18 risk in §7: mutations with no Origin header from local processes. Consider requiring the web Origin on mutations, or a per-boot secret header that the Next proxy adds.
3. `message.delta` streaming (cosmetic).
4. Add a favicon (a 404 in every browser session).
5. **Contract changes (all additive):**
   - shared: `ReviewCardFlags.companyMissing` / `.dryRunSettled`, `API_ROUTES.taskDeclineDomain`, `API_CONTRACT` / `apiEndpoints` / `ApiMethod` / `ApiRouteKey`;
   - engine: `isDryRunSettled`; `skip()` now accepts a settled dry-run card;
   - token guard: `storedTokens` is exported;
   - web: `ShellState.refresh` / `useShellRefresh`; `WebApi.getTranscript` returns shared `TranscriptLine`s; `contract.ts` exports `ProgressLine` (the mock stores these).
6. **Phase 4 W4b:** the parity tests fail when a route or schema drifts. New routes need an `API_CONTRACT` row, and the web side needs a call or an `UNUSED` reason.
