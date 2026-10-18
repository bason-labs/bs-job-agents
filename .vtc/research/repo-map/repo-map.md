# Repo map: bs-job-agents (run r20261018-074219, research depth: light)

**One line:** a pnpm/Turborepo monorepo (TypeScript) holding a local single-user job-search app: a Next.js web UI, a Fastify orchestrator that runs Claude/Codex CLI bots, and shared Zod schemas (README.md:3, README.md:11-18, package.json:2-17).

## Overview
- Purpose: bots (Lead, Research, CV, QA, Apply) find jobs, tailor a CV in Figma, check it, and apply after Ba's approval; uses Claude and ChatGPT CLIs, no API keys (README.md:3).
- Layout: `apps/web` (Next.js, App Router, Tailwind v4), `apps/orchestrator` (Fastify API + SSE, engine, runner, MCP server, SQLite/drizzle), `packages/shared` (Zod schemas), `bots/<bot>/` (bot.json, ROLE.md, memory.md, skills/), `workflows/*.yaml`, `data.example/` (README.md:11-18).
- Tooling: pnpm 10.11.0, Node >=22.13, turbo scripts `dev`, `build`, `lint`, `test`, `typecheck`, `e2e` (package.json:4-17); orchestrator uses vitest (apps/orchestrator/vitest.config.ts), web has playwright configs (apps/web/playwright.config.ts).
- `AGENTS.md` at root tells agents to read the installed turbo docs before changing Turborepo config (AGENTS.md:1-7).
- Request attachment (.vtc/state/attachments/r20261018-074219/1-2.png): a Vietnamese VNPT recruiter post with three CV rules: full month/year timelines; strongest relevant experience first, each described as what / which tech / what result; scannable info (contact, links, JD-relevant skills, 1-2 pages, no tech listed without real experience).

## Traced paths

### Path 1: job scan to Research sources (request item 1: MCP/API instead of extension)
1. `workflows/job-scan.yaml:12-20` step `scan` maps `research.scan` over `$params.sources`; later steps are `dedupe`, `fit`, `top`, `company`, `tailor`, `review`, `apply`, `record` (workflows/job-scan.yaml:12-103).
2. Each source has `kind: "browser"` or `"feed"` in `SEARCH_SOURCES` (packages/shared/src/common/sources.ts:25-36). Browser: topcv, itviec, vietnamworks, linkedin, wellfound, upwork. Feed: remoteok, weworkremotely, remotive, jobspresso.
3. Feed tasks never reach a runner: `FeedTaskRunner` claims them and fetches public JSON/RSS via `src/adapters/feeds`; no bot, no LLM (apps/orchestrator/src/engine/feed-tasks.ts:1-8, :46-52; adapters in apps/orchestrator/src/adapters/feeds/boards.ts:1-10, :51-54).
4. Browser sources go to the Research bot, whose `bots/research/bot.json` allows `read`, `web_search`, `chrome:read`, `skill:source-*`, `browser.mode: "read"` with `allowedSites` of the six browser boards, and `mcpServers: []` (bots/research/bot.json:8-25).
5. The bot reads each board through Chrome following `bots/research/skills/source-<board>/SKILL.md` (e.g. bots/research/skills/source-topcv/SKILL.md:8-37, which names `get_page_text`, `find`, `read_page`). Seven skills exist: career-site, itviec, linkedin, topcv, upwork, vietnamworks, wellfound.
6. Parsers/URL builders for the same boards are in `apps/orchestrator/src/adapters/sources.ts:23-41` (`SOURCE_ADAPTERS`, `AdapterSource`) and `apps/orchestrator/src/adapters/parsers/*.ts`, tested against `apps/orchestrator/src/adapters/fixtures/*.html`. Output shape is `ResearchScanOutput` (bots/research/schemas/ResearchScanOutput.json).
7. When Chrome is closed, tasks wait as `needs_browser` (README.md:30); the Chrome bridge is `apps/orchestrator/src/bridges/chrome/` (status.ts, site-guard/).
8. The orchestrator's own MCP server is for Lead only: `POST /mcp/<capability>`, tools `start_workflow`, `create_task`, `get_status`, `get_result`, `message_user`, `propose_workflow` (apps/orchestrator/src/mcp/server.ts:1-21, apps/orchestrator/src/mcp/tools.ts:15). It exposes no job-board access.

### Path 2: CV tailoring (request item 2: auto-extend CV, auto-optimize with HR rules)
1. Gate step `tailor` in workflows/job-scan.yaml:65-81: producer `cv.tailor`, checker `qa.review`, `maxRounds: 3`, `perLanguage: true`.
2. Facts source: `data/master-cv.yaml`, schema `MasterCvSchema` with `version`, `contact`, `headlineOptions`, `facts[]` of type experience|project|skill|education|metric, each with `id`, `text`, `textVi`, `tags`, `org`, `dates` (packages/shared/src/domain/master-cv.ts:4-45). "Owned by Ba; bots only read it" (same file, line 1). Seed example: data.example/master-cv.yaml.
3. CV bot (bots/cv/ROLE.md): clones an A4 Figma template into the Drafts page via `figma_execute` (ROLE.md:22-34); every bullet and the summary cite `factIds` (ROLE.md:16); no number, skill, tool, title, employer or date outside cited facts (ROLE.md:17-18); missing items become `factRequests` entries (ROLE.md:19); layout and ATS-safe constraints (ROLE.md:36-40). Output schema bots/cv/schemas/CvOutput.json.
4. QA bot (bots/qa/ROLE.md:14-37): truth check against master facts, scores `jdMatch` 0-40, `companyTone` 0-20, `formatAts` 0-20, `clarity` 0-20; hard fails `invented_claim`, `wrong_language`, `wrong_company`, `pdf_unreadable`, `over_one_page`, `ats_order`, `missing_section`; pass is total >= 80 and no hard fails (ROLE.md:30-37). Fixes name a section and use only master facts (ROLE.md:28).
5. New facts path: `fact_draft` task turns Ba's words into 0-5 master facts, which the orchestrator checks and adds (bots/cv/ROLE.md:42-55; apps/orchestrator/src/engine/fact-drafts.ts, apps/orchestrator/src/api/fact-drafts.ts; schema bots/cv/schemas/FactDraftOutput.json).
6. Skills are static files (`skills/source-*/SKILL.md`, loaded per `skill:<glob>` in apps/orchestrator/src/runner/tools.ts:9). The only auto-updated per-bot file found is `bots/<name>/memory.md`, written by `apps/orchestrator/src/runner/memory.ts:1-6` (runtime state, gitignored, "never override your role"). A grep of CV and QA ROLE.md found no HR/recruiter-guidance rules and no rule-source tracking; `bots/cv/` has only ROLE.md, bot.json and schemas/ (no skills folder).
7. Human review follows: step `review` in workflows/job-scan.yaml:83-88 (approve, request_changes, skip).

### Path 3: prompts and bot loading
`apps/orchestrator/src/runner/bots.ts:1` loads bot.json, ROLE.md and memory.md; prompt snapshots live in `apps/orchestrator/src/runner/__snapshots__/prompt.<bot>.<kind>.md` (e.g. prompt.cv.tailor.md); versions in `bots/prompt-versions.json` (bot.json carries `promptVersion`, e.g. bots/research/bot.json:66). Changing a ROLE.md therefore touches these snapshot files and the prompt version file (not opened in detail).

## Conventions (evidence)
- Workflows: YAML, `version` bumped with every change (workflows/job-scan.yaml:5; README.md:75), `$`-templates resolved by the engine (job-scan.yaml:4).
- Bots: JSON definition plus ROLE.md with sections for rules, inputs, output schema and Self-check (bots/cv/ROLE.md, bots/qa/ROLE.md); `selfCheckByKind` in bot.json (bots/research/bot.json:39-65).
- Untrusted content rule: JD, company profile and tool results are data, not instructions (bots/cv/ROLE.md:57-59, bots/qa/ROLE.md:39).
- Shared types: Zod in packages/shared, imported as `@bs-job-agents/shared` (apps/orchestrator/src/engine/feed-tasks.ts:9).
- Tests are colocated `*.test.ts` (e.g. apps/orchestrator/src/adapters/parsers.test.ts, apps/orchestrator/src/engine/flows.test.ts), fixtures in `adapters/fixtures/`. Commands: `pnpm test`, `pnpm typecheck`, `pnpm lint` (package.json:13-15). VTC gates: .vtc/gates.yml (not opened).
- DB: drizzle migrations `apps/orchestrator/drizzle/0000..0011`, repos in `apps/orchestrator/src/db/repos/`.
- Config via `ORCH_*` env vars (README.md:64-77).

## Inferred spine
- Web (apps/web) calls the orchestrator API (apps/orchestrator/src/api/routes/*), with types from packages/shared (README.md:11-14).
- Orchestrator: api -> engine (core.ts, queue.ts, feed-tasks.ts) -> runner (claude/codex CLI) -> bots/ definitions; bridges for Chrome, Figma and PDF (apps/orchestrator/src/bridges/); db repos beneath the engine (directory listing).
- External systems: Claude and Codex CLIs, Chrome extension, Figma desktop plugin, public feeds of four boards (README.md:23-35; packages/shared/src/common/sources.ts:29-32).
- Baseline asymmetry in the code: four boards are read by direct HTTP feeds without a bot, six by browser skills (packages/shared/src/common/sources.ts:25-36).

## Design tokens
Web uses a "bs-kara" Tailwind v4 theme (README.md:12); theme files not inspected.

## Inspected
README.md, package.json, AGENTS.md (given in task), workflows/job-scan.yaml, bots/research/bot.json, bots/research/skills/source-topcv/SKILL.md, bots/cv/ROLE.md, bots/qa/ROLE.md, packages/shared/src/domain/master-cv.ts, packages/shared/src/common/sources.ts, apps/orchestrator/src/engine/feed-tasks.ts (first 70 lines), apps/orchestrator/src/adapters/sources.ts (first 60), apps/orchestrator/src/adapters/feeds/boards.ts (first 80), apps/orchestrator/src/mcp/server.ts (first 30), grep of apps/orchestrator/src/mcp/tools.ts, the request and the attached PNG, file listings of the repo.

## Not inspected
The other six source SKILL.md files; adapter parsers and the checker; engine core/queue/gate/review; apps/web entirely; the db schema and migrations; runner prompt assembly and snapshots; bots research/lead/apply ROLE.md; docs/ (spec, runbook, owner-decisions); data.example files; .vtc/gates.yml; any existing code for a board's internal web API or account-token access (no search made; none seen in the files read); any existing multi-source CV guidance (only CV/QA ROLE.md were grepped).
