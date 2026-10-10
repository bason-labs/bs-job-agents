# bs-job-agents

A local, single-user crew of bots (Lead, Research, CV, QA, Apply) that finds jobs, tailors a CV in Figma, checks it, and applies after your approval. It runs on your Mac using your existing Claude and ChatGPT subscriptions through their CLIs, so there are **no API keys**.

- Design spec: [`docs/superpowers/specs/2026-10-10-job-agents-design.md`](docs/superpowers/specs/2026-10-10-job-agents-design.md)
- Build phases and agent rules: [`docs/superpowers/build/phases.md`](docs/superpowers/build/phases.md)

## Layout

```
apps/web/            Next.js UI (App Router, Tailwind v4, bs-kara theme)        → http://localhost:3000
apps/orchestrator/   Fastify API + SSE, engine, runner, MCP server, SQLite      → http://127.0.0.1:4100
packages/shared/     Zod schemas and types shared by web and orchestrator
bots/<bot>/          bot definitions (bot.json, ROLE.md, memory.md, skills/)
workflows/           workflow YAML (job-scan, apply-to-link, ...)
data.example/        example user data (copy to data/, which is gitignored)
```

## Prerequisites

- **Node 22.13 or newer** (`nvm use` reads `.nvmrc`, which resolves to the latest 22.x) and **pnpm 10.11.0** (`corepack enable` picks it up from `package.json`). `.npmrc` sets `engine-strict=true`, so `pnpm install` refuses an older Node. drizzle-kit (`db:generate`) loads the shared package through `require(esm)`, which needs Node ≥ 22.12; ESLint's dependencies need ≥ 22.13.
- **Claude Code CLI**, logged in with your claude.ai account: `~/.local/bin/claude` (2.1.x). Check with `claude --version`.
- **Codex CLI**, bundled with the ChatGPT desktop app and logged in through ChatGPT. It is not on `PATH`; the orchestrator calls it at:
  ```
  /Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex
  ```
- **Google Chrome**, running, with both extensions installed and signed in:
  - **Claude in Chrome** (native host `com.anthropic.claude_code_browser_extension`)
  - **ChatGPT for Chrome / Codex** (native host `com.openai.codexextension`)

  Bots reuse your existing Chrome logins (TopCV, LinkedIn, ITviec, Figma, employer ATS sites). If Chrome is closed, browser tasks wait as `needs_browser`.
- **Figma desktop** with the **Figma Desktop Bridge** plugin (from `figma-console-mcp`, imported once via `~/.figma-console-mcp/plugin/manifest.json`). The bridge does **not** start by itself. Each session:
  1. Open Figma desktop and open your CV file.
  2. Start the plugin: **Plugins → Development → Figma Desktop Bridge**.

  If Figma or the plugin is not running, CV tasks wait as `needs_figma`.

## Develop

```bash
pnpm install
pnpm dev                 # web (3000) + orchestrator (4100) together
pnpm dev:web             # web only
pnpm dev:orchestrator    # orchestrator only (tsx watch)
```

The orchestrator port defaults to `4100` (not `4318`, the OpenTelemetry collector port); override with `ORCH_PORT=5000 pnpm dev:orchestrator`. Health check: `curl http://127.0.0.1:4100/health` → `{"ok":true}`.

## Check

```bash
pnpm -w typecheck
pnpm -w lint
pnpm -w test             # Vitest in every package (no real CLIs, Chrome or Figma)
pnpm build               # builds shared, orchestrator and web
pnpm e2e                 # Playwright UI tests (not part of `pnpm test`)
```

First time running `pnpm e2e`, install the browser: `pnpm --filter @bs-job-agents/web e2e:install`.

## Data

Runtime data lives in `data/` at the repo root (SQLite `app.db`, CVs, PDFs, screenshots, transcripts, `master-cv.yaml`). It is gitignored and stays on your machine. `data.example/` holds templates to start from.
