# W3b UI + lib/api report (Phase 3)

- **Merged.** develop: 2,166 tests (web 408); e2e 122/122 (twice) in its worktree. Live check against the real orchestrator through the `/api` rewrite: health, bots, rooms, engines, review, runs and SSE work; CSRF is enforced.
- **Screens:**
  - **Chat:** bot tabs, consult banner, run card with live delegation trace, streaming replies; question, pause, domain-confirm, hand-off, choice, review-link, fact-request and job cards; composer with attachments (IME-safe Enter).
  - **Review:** cards with fit, company, QA rounds and truth check, VI/EN CV in the viewer; approve dialog with optional intro; request changes; skip; flags (escalated, injection confirm, low confidence, master CV changed, no apply link, needs input, approve again).
  - **Flows:** run list; React Flow canvas with a lane per job, live status, QA loop edge, step drawer (UC-22) with streamed transcript and re-run (UC-23); pause/resume/cancel.
  - **Shell:** paused banner with human time (S8); degraded/unreachable banner; reconnect indicator; mock-mode "Sample data" badge + Simulate menu; S9 widths and trust badge.
- **Design system:** `Drawer`, FileDropzone wrap mode, `useReturnFocus`; `cn` uses tailwind-merge; focus return everywhere.
- **lib/api:** `useApi()` (WebApi), hooks, `browserClient()` / `serverClient()` for any API_ROUTES call; http and mock implementations (mock parity-tested against the shared schemas); SSE with Last-Event-ID resume, backoff and de-duplication. Mode via `BSJA_API_MODE` (live/mock/auto); base URL `ORCH_URL`/`ORCH_PORT` through the Next rewrite (host-guarded); CSRF in `lib/api/csrf.ts`.
- **API gaps → relayed to W3a part 2:** direct rooms per bot, attachment metadata, `/chat/choices`, `/tasks/:id/transcript`, step previews + workflow definition, Chrome bridge status, `answered` on question cards, delta-before-created ordering, "Don't allow" for domain_confirm.
- **Follow-up:** swap W3c's `components/<area>/data.ts` singletons to `browserClient()` adapters after W3a part 2 merges.
