# W3d wiring report (Phase 3)

- **Merged.** develop: 2,382 tests (web 451); e2e 135/135 in its worktree. Every screen route is dynamic.
- **Data access:** the six W3c screens use `create<Area>Data(api)` adapters + `use<Area>Data()` hooks over lib/api (`WebApi.request`, `apiUrl`). Skeleton while loading; error with Retry.
- **Live updates:** applications, bots and schedules re-read on their SSE events.
- **Mock backend:** about 45 route/method pairs, parity-tested against the shared schemas; e2e runs on it via `withMock`.
- **Rooms:** live via `POST /chat/messages` and SSE; new `/rooms` page; the flaky RoomScreen test is fixed (gate instead of a timer).
- **Workflow proposals:** a section under /bots (approve saves a version, never runs).
- **F3 web follow-ups:** "Approve live & submit" (`flags.dryRunSettled`), the `companyMissing` notice, Research injection wording, demotion + Restore, "Don't allow" (calls a proposed `POST /tasks/:id/decline-domain`), the figma-change chip.
- **Live check:** real orchestrator + web on the real data flow; all screens passed; no console errors, no 5xx.
- **Left for Phase 3 QA:**
  - API: add `companyMissing` and `dryRunSettled` to the shared `ReviewCardFlagsSchema`, and put settled dry-run cards back in the queue.
  - API: `POST /tasks/:id/decline-domain` → `engine.declineDomain` (a web test flips when it lands).
  - API: fill `BotView.demotion`; switch memory delete to `removeMemoryNote`; route the figma-change "was_me" choice → `protectedChangeWasBa`.
  - Web: `getTranscript` should use the shared `TranscriptResponseSchema`; the sidebar should refresh when a room is created.
