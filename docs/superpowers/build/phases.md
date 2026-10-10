# Build phases and agent workflow

Owner instruction (2026-10-10): no separate implementation plan. Build in phases. In each phase, worker agents run in parallel, then a **QA/QC agent** verifies and fixes until everything is green, then a **PM agent** reviews against the spec and writes comments that feed the next phase.

- **Source of truth:** `docs/superpowers/specs/2026-10-10-job-agents-design.md` (the spec).
- **Also read:**
  - `docs/superpowers/spikes/2026-10-10-spike-findings.md` (verified CLI flags, Chrome, Figma)
  - `docs/superpowers/prototypes/stage0-prototype.html` (approved UX: every screen, copy and interaction)
- **Branch:** all work merges into `develop`. Parallel workers use their own git worktrees, and the coordinator merges them.

## Rules for every agent
1. **Test first.** Write the failing test, make it pass, then refactor. Use Vitest for logic and Playwright for UI. Never call real CLIs, Chrome or Figma in automated tests; use the FakeRunner and fake bridges.
2. **Stay inside your owned paths** (table below). If you need something outside them, write a stub or interface in your own area and note it under "Handoff" in your report. Don't edit another worker's files.
3. **Small commits** with clear messages, each ending with exactly this one trailer line (updated 2026-10-10; do not add a `Claude-Session` line):
   ```
   Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
   ```
4. **Definition of done:**
   - `pnpm install && pnpm -w typecheck && pnpm -w lint && pnpm -w test` pass from the repo root
   - no `TODO`s left without a matching note in your report
5. **Report back:**
   - what you built (paths)
   - tests added (count) and their results
   - spec sections covered
   - deviations from the spec, with reasons
   - handoffs and open questions
6. **No secrets or API keys anywhere.** Engines run only through the user's `claude` / `codex` subscriptions (spec §1.4).
7. **UI:**
   - bs-kara theme tokens, own components (Radix primitives for behaviour, lucide-react icons)
   - `cursor-pointer` on everything clickable; narrow pages centered
   - file viewer first, download from inside the viewer (spec §11)

## Phases and ownership

| Phase | Worker | Owns | Spec |
|---|---|---|---|
| **0 Scaffold** | W0 | everything (repo skeleton) | §4.1, §4.3 |
| **1 Foundations** | W1a Shared schemas | `packages/shared/**` | §5, §7, §9, §9.1, §5.5 (strict JSON Schema converter) |
| | W1b Data layer | `apps/orchestrator/src/db/**` | §9, §9.1 |
| | W1c Design system + app shell | `apps/web/**` | §11 (components, layout, theme, sidebar, routing shell) |
| **2 Engine and runner** | W2a Engine | `apps/orchestrator/src/engine/**` (workflow engine, task queue, limiter, browser/Figma locks, trust guard, scheduler, FakeRunner) | §3, §5.3, §7, §10 |
| | W2b Runner | `apps/orchestrator/src/runner/**`, `bots/**` (bot.json, ROLE.md, memory.md) | §5, §5.5, §10.2, spike S1/S2/S4 |
| | W2c Bridges | `apps/orchestrator/src/bridges/**` (Figma bridge, Chrome site-guard hook, PDF text + SHA-256 tools) | §4.4, §6.2, spike S2/S3b |
| **3 API and UI** | W3a API | `apps/orchestrator/src/api/**`, `src/mcp/**`, `workflows/**` | §4.2, §7, §8, §11 (SSE events) |
| | W3b UI: chat, flows, review | `apps/web/app/(chat\|flows\|review)/**` and their components | §11, UC-01/07/08/09/10/16/22/25 |
| | W3c UI: apps, criteria, schedules, bots, CV, rooms, viewer | the other `apps/web/app/**` routes | §11, UC-12/13/13b/15/19/20/21/21b/24 |
| **4 Integration** | W4a Source adapters | `bots/research/skills/**`, `apps/orchestrator/src/adapters/**` | UC-03/04, §12 source adapters |
| | W4b End-to-end | `apps/web/e2e/**`, wiring fixes | §12 integration + UI e2e, dry-run acceptance |
| | W4c Bot prompts + master CV | `bots/*/ROLE.md`, `data.example/master-cv.yaml` | §5.2, §6.1, §6.3 |

**QA/QC agent (after each phase):**
- runs the full check suite
- reads each worker's report
- checks the phase's spec sections line by line, writing missing tests where coverage is thin
- fixes defects and repeats until green
- writes `docs/superpowers/build/qa-phase-<n>.md`

**PM agent (after QA):**
- reviews the merged result against the spec and the prototype: scope, behaviour, UX copy, the six core rules
- writes `docs/superpowers/build/pm-phase-<n>.md` with must-fix and should-fix items
- must-fix items are done before the next phase starts; should-fix items are folded into the next phase's worker briefs
