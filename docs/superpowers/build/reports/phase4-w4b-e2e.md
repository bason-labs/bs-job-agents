# W4b report (Phase 4: e2e, runbook, live checks)

- **Merged.** develop: 2,676 unit tests; `pnpm e2e` (mock lane) 151; `pnpm e2e:live-shape` 11.
- **Live-shape lane:**
  - `apps/orchestrator/e2e/live-shape-launcher.ts` runs the real built orchestrator, a FakeRunner for every bot, a fake Lead that uses the real MCP server, real PDFs/PNGs, and a control port.
  - The specs cover UC-01, the canvas over SSE, dry run → approve live → record + viewer, request changes, skip, UC-12, UC-16, UC-21b, UC-21, export, and the bot engine locks.
- **Screenshots:** `toHaveScreenshot` for 9 screens × 2 themes; deterministic; macOS baselines.
- **Runbook:** `docs/runbook.md` covers prerequisites, setup, first run, daily use, troubleshooting, the safety model, the pre-dry-run checklist and the dry-run acceptance.
- **Live checks:**
  - (a) Chrome extension: blocked, needs Ba (tabs_context timeout / "not connected"). Script added: `pnpm --filter @bs-job-agents/orchestrator live:screenshot`.
  - (b) Figma plugin not running: blocked, needs Ba.
  - (c) the Codex read-only sandbox cannot reach 127.0.0.1:4100: passed.
  - (d) Research on Claude reads its skills and is denied other bots' files: passed.
- **Fix:** a settled dry run now emits `review.ready` (`announceSettledDryRun`).
- **Open issues:**
  1. Chrome connection is flaky; maybe one Claude session at a time.
  2. `next start` bakes the orchestrator rewrite at build time.
  3. Approve live after a "submitted" dry run relies on the queue reloading on `application.updated`.
  4. §12 "dry run required before the first live submission" is not enforced in code.
  5. S5 tool steps are not covered by the live lane.
  6. The Proof column shows "not captured" for dry runs.
  7. Manual `--chrome` checks need `--strict-mcp-config`.
