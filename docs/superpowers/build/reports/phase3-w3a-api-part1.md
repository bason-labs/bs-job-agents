# W3a API part 1 report (Phase 3)

- **Merged** as 87becd3. develop: 1,679 tests (shared 325, orchestrator 1,267, web 87).
- **Routes:** every API_ROUTES entry except chat, consult, rooms messaging, confirm-injection and approve dryRun (part 2), plus new `GET /status`, `GET /steps/:id`, `GET /exports` and `DELETE /saved-answers/:key`. EngineError and db errors map to ApiError (400/403/404/409/500; 503 when degraded); list endpoints skip bad rows.
- **SSE:**
  - frame id = events row id; `Last-Event-ID` / `?after=` replays in order, then streams live
  - first connection gets no history (load state over REST); `retry: 3000`; heartbeat every 15 s
- **S18 security:**
  - binds 127.0.0.1; Host checked (no DNS rebinding); Origin must be a web origin (`ORCH_WEB_ORIGINS`); `Sec-Fetch-Site: cross-site` refused; no CORS
  - mutations need `x-bsja-csrf: 1`; JSON bodies only; prototype-poisoning keys refused
  - approval tokens never returned (any response containing one becomes a 500)
  - files by id only: resolved inside data/, regular file, magic bytes checked, nosniff + no-store
  - uploads stored by content hash; export ZIP has safe names and defused CSV cells, and leaves out dry runs
- **S19 degraded start:** HTTP and SSE stay up; `/health` returns 503 with the reason. Reasons: data path with a space/comma/parenthesis, schema guard, DB open, invalid workflow, invalid bot.json, stale ROLE.md, engine start error. Lock file `data/orchestrator.lock`; graceful shutdown.
- **S22 workflows:** `workflows/{job-scan,apply-to-link,apply-to-file}.yaml` match the shared fixtures and pass the S4 checks. YAML WorkflowSource; versions stored in the `workflows` table; a changed definition without a version bump refuses the start; a run keeps its own version.
- **New dependencies:** yaml, fflate, @fastify/multipart 10.1.2. `apps/orchestrator/turbo.json` passes `ORCH_*` and the CLI env vars through to the dev task.
- **Part 2 (after F2):**
  - S17 Lead MCP server (`createRunners` has no orchestrator server yet, so `lead.chat` can't run)
  - S20 chat, consult, handoffs, room mentions, upload links, macOS notification
  - confirm-injection; approve `dryRun` (refused with 400 for now)
  - storing `propose_workflow` results
  - open: how the step drawer shows transcripts (no file kind or route yet)
- **Requests:**
  1. Export `canApproveAgain`, `EventBus` and `approvalStatus` from the engine index.
  2. `ApproveResponseSchema`: nullable `applicationId` plus `reapproval`.
  3. The engine should check that an apply-to-file upload exists.
  4. `createProductionEngine` creates a FigmaBridge it never stops.
  5. FakeRunner writes no `runner.spawned` rows; the FakeClock scheduler tick is slow over days.
- **Handoffs:** W3b — `/api` same-origin proxy, CSRF header, SSE resume, health body (relayed by message). W3c — API shapes (relayed). W4b — `ORCH_WEB_ORIGINS` for e2e ports. README — document `ORCH_DATA_DIR`, `ORCH_WEB_ORIGINS`, `ORCH_LOG_LEVEL` and the lock file.
