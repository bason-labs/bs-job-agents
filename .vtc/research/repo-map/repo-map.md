# Repo map: bs-job-agents (research depth: light)

Request (`.vtc/runs/r20261017-044722/request.md`): (1) use MCP/API for the job research instead of acting through the browser extension; (2) auto-update everything, with no human updating skills, and auto-extend the CV from what exists to match requirements.

## One line

A local single-user pnpm/Turborepo monorepo (Next.js web + Fastify orchestrator + shared Zod package) that runs Lead, Research, CV, QA and Apply bots on the Claude and Codex CLIs (README.md lines 3, 9-18; package.json scripts lines 9-17).

## Overview

- Layout (README.md 11-18): `apps/web` (Next.js, port 3000), `apps/orchestrator` (Fastify API + SSE, engine, runner, MCP server, SQLite via drizzle, port 4100), `packages/shared` (Zod schemas), `bots/<bot>/` (bot.json, ROLE.md, memory.md, skills/), `workflows/*.yaml`, `data.example/`.
- Languages and tools: TypeScript, pnpm 10.11.0, Node >= 22.13, Turbo (`turbo dev|build|lint|test|typecheck`), Vitest, Playwright e2e (README.md 22, 87-98; package.json).
- Bots: lead, research, cv, qa, apply under `bots/` (directory listing).
- Not inspected: apps/web, most of apps/orchestrator/src/api, engine/queue.ts, db schema and drizzle migrations, qa/apply/lead bots, docs/.

## Traced path A: job scan (research source reading)

1. Workflow `workflows/job-scan.yaml`: step `scan` is a `map` over `$params.sources` that creates a `research` task of kind `scan` per source (lines 12-20); then `scan-join` (requireAll false), `dedupe`, `fit` (research kind `fit`), `top`, per-job `company`, `tailor` gate (cv.tailor with qa.review, maxRounds 3), human `review`, `apply` action, `record` (lines 22-103).
2. Source catalogue: `packages/shared/src/common/sources.ts` `SEARCH_SOURCES` (line 25) marks each source `kind: "browser"` (topcv, itviec, vietnamworks, linkedin, wellfound, upwork) or `kind: "feed"` (remoteok, weworkremotely, remotive, jobspresso). `isFeedSource` at line 57.
3. Feed sources (already API/no-browser): `apps/orchestrator/src/engine/feed-tasks.ts` `FeedTaskRunner.execute` (line 67) takes a research.scan task with a feed source, calls `core.deps.feeds.scan` (line 88), and completes the task with `completeTask` (line 96). No bot or LLM involved (file header lines 1-8). The queue claims them with `claimNextTask({ feedTasks: "only" })` (line 48); filter helpers in `apps/orchestrator/src/db/repos/tasks.ts` lines 107, 112. Wired as `feeds: opts.feeds ?? new FeedScanner()` in `apps/orchestrator/src/engine/wiring.ts` line 158.
4. `apps/orchestrator/src/adapters/feeds/scanner.ts` `FeedScanner.scan` (line 103) fetches via adapters in `feeds/boards.ts` `FEED_ADAPTERS` (line 190): plain HTTP GET to `remoteok.com/api`, `weworkremotely.com/categories/*.rss`, `remotive.com/api/remote-jobs`, `jobspresso.co/?feed=job_feed`; filters with `feeds/filter.ts`; returns `ResearchScanOutputSchema`. Cache, 1.5 s gap, UA at lines 40, 97, 144-179.
5. Browser sources: handled by the Research bot in Ba's Chrome. `bots/research/bot.json` has `allowedTools: ["read","web_search","chrome:read","skill:source-*"]`, `browser.mode: "read"`, `allowedSites` (six boards), `mcpServers: []` (lines 8-25). `bots/research/ROLE.md` lines 12 and 26-36 describe the Chrome tools (`tabs_create_mcp`, `navigate`, `get_page_text`, ...) and per-source skills in `bots/research/skills/source-{topcv,itviec,linkedin,vietnamworks,wellfound,upwork,career-site}/SKILL.md`. Prompt builder points to skills at `apps/orchestrator/src/runner/prompt.ts` lines 194-201. Site allowlist guard: `apps/orchestrator/src/bridges/chrome/site-guard/*`.
6. HTML parsers for browser-sourced pages (fixtures + parsers): `apps/orchestrator/src/adapters/parsers/{topcv,itviec,linkedin,vietnamworks,wellfound,upwork,career-site}.ts`, `adapters/pages.ts`, `adapters/checker.ts`. Also `adapters/sources.ts` (`scanJobLimit` imported by scanner.ts line 16).
7. Output: task output validated by schema in `bots/research/schemas/ResearchScanOutput.json` (bot.json `outputSchema`, lines 27-33), then dedupe by `apps/orchestrator/src/db/dedupe.ts`.

## Traced path B: MCP surface

- Orchestrator MCP server for Lead: `apps/orchestrator/src/mcp/{server,tools,capabilities,runner,index}.ts`. Six tools only: `start_workflow`, `create_task`, `get_status`, `get_result`, `message_user`, `propose_workflow` (`mcp/tools.ts` line 15). `create_task` enum limits bot to `research` and kinds `scan|single|file|fit|company` (lines 44-52). Per-run capability URL on 127.0.0.1 (README.md line 85).
- Bot-side MCP servers: `apps/orchestrator/src/runner/config.ts` `DEFAULT_MCP_SERVERS` holds only `figma` (figma-console-mcp, pinned; lines 58-78, 98). `bots/cv/bot.json` uses `mcpServers: ["figma"]` and `mcp:figma:*` tools. Claude argv builds `--mcp-config` and `--allowedTools` in `runner/claude/argv.ts` lines 70-120. Research has no MCP server configured.
- Runners: `runner/claude/runner.ts`, `runner/codex/runner.ts`, shared `runner/cli-runner.ts`.

## Traced path C: master CV facts, memory and skills

1. Master CV file: `data/master-cv.yaml` (template `data.example/master-cv.yaml`: `version`, `contact`, `headlineOptions`, `facts[]` with `id`, `type`, `text`, `textVi`, `tags`, `org`, `dates`). README.md line 45: "Bots only read it"; Ba edits it on the Master CV screen.
2. `bots/cv/ROLE.md` line 19: when the JD asks for something the facts lack, CV leaves it out and adds a `factRequests` entry (topic, question for Ba, why); output schema `bots/cv/schemas/CvOutput.json`.
3. Ba answers in free text: `cv.fact_draft` task. `apps/orchestrator/src/engine/fact-drafts.ts`: `createFactDraftTask` (line 51), guard `screenFactDraft` using `screenDraftedFacts` from shared (line 77), `onFactDraftDone` (line 84) hands accepted facts to `FactDraftSink`, which adds them to master-cv.yaml as a new version with Undo (header lines 1-5). API side: `apps/orchestrator/src/api/fact-drafts.ts`. Rejected facts logged as audit event `fact_draft.rejected` (line 23). Tool-less task (`bots/cv/ROLE.md` line 44).
4. Bot memory: `apps/orchestrator/src/runner/memory.ts` appends task `memoryNotes` to `bots/<name>/memory.md`, archives beyond `LIMITS.memoryLinesMax`; filtered by `runner/memory-hygiene.ts`; memory.md is gitignored runtime state (header lines 1-7). Injected into prompts by `runner/prompt.ts` line 107.
5. Skills: static files in `bots/research/skills/source-*/SKILL.md` (only the research bot has a `skills/` folder). Bot prompt changes are guarded: `bots/prompt-versions.json`, `runner/prompt-lock.ts`, and README.md line 81 (ROLE.md changed without `promptVersion` bump => degraded start). Research `promptVersion` 5 and cv `promptVersion` 5 (bot.json).
6. Layout-change signal: ROLE.md research rule 5 (line 32) says to report `Layout changed: ...` on the first self-check item so the orchestrator reports the adapter as broken. Where the orchestrator consumes it was not traced.

## Conventions (evidence)

- Bot definition: `bots/<name>/{bot.json,ROLE.md,schemas/*.json}`; bot.json keys `name, engine, model, trustLevel, allowedTools, browser, mcpServers, timeoutSec, outputSchema, selfCheck, selfCheckByKind, promptVersion` (bots/research/bot.json, bots/cv/bot.json).
- Workflow YAML with `version` bumped on every change; `$`-templates (`workflows/job-scan.yaml` lines 1-5; README.md line 74).
- Adapters take injectable `fetch`/`now`/`sleep` for tests (`feeds/scanner.ts` lines 22-38); tests colocated as `*.test.ts` with fixtures in `adapters/fixtures/`.
- Errors: typed `FeedError`, `EngineError`, `ApiHttpError`, `ToolError` (`feeds/scanner.ts` 42, `mcp/tools.ts` 99-145).
- File headers carry spec section references (e.g. "spec §7.5", "W5", "PM2 S5").
- Commands: `pnpm -w typecheck`, `pnpm -w lint`, `pnpm -w test`, `pnpm build`, `pnpm e2e`, `pnpm e2e:live-shape` (README.md 87-96). Gates file: `.vtc/gates.yml` (not read).
- State-changing API calls require web Origin + CSRF header (README.md line 83).

## Inferred spine

- `apps/web` -> HTTP/SSE -> `apps/orchestrator` (api, engine, runner, mcp, bridges, adapters, db) -> CLIs (claude, codex) and bridges (Chrome via site-guard, Figma via figma-console-mcp). `packages/shared` is imported by both apps (e.g. scanner.ts line 8-15). Evidence: README.md 11-18, 28-35; directory listing of `apps/orchestrator/src`.
- Two scan execution paths coexist: orchestrator-fetched feeds (no LLM) and Research bot in Chrome, selected by `SEARCH_SOURCES[...].kind`.
- Baseline pattern breaks: `bots/research/bot.json` has empty `mcpServers` while feed sources bypass bots entirely; only `bots/research` has `skills/`; master CV is documented as bot read-only and changed only through the fact-draft sink after Ba's input.

## Design tokens

Web uses Tailwind v4 with a "bs-kara" theme (README.md line 12). Token files not inspected.

## Files inspected

README.md; workflows/job-scan.yaml; bots/research/{bot.json,ROLE.md}; bots/cv/bot.json; bots/cv/ROLE.md (grep only); packages/shared/src/common/sources.ts; apps/orchestrator/src/adapters/feeds/{scanner,boards}.ts; apps/orchestrator/src/engine/{feed-tasks,fact-drafts}.ts; apps/orchestrator/src/mcp/tools.ts; apps/orchestrator/src/runner/{memory,config,claude/argv,prompt}.ts (partial/grep); data.example/master-cv.yaml (first 40 lines); package.json (grep).

## Not inspected

apps/web; docs/runbook.md and docs/superpowers specs; engine/queue.ts and the rest of engine; api routes; db schema and migrations; bots lead/qa/apply; the source SKILL.md files; adapters/parsers and checker bodies; bridges/chrome internals; .vtc/gates.yml; the scheduled-trigger code; any code that auto-edits skills or ROLE.md (none found in files read; not searched exhaustively).
