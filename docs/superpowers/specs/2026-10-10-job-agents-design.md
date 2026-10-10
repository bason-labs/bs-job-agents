# Job Agents: design spec (Phase 1: platform core + job-apply crew)

- **Date:** 2026-10-10
- **Status:** Draft, awaiting owner review
- **Owner:** Ba Huynh
- **Project folder:** `bason-labs/bs-job-agents`
- **UI prototype (approved direction):** `docs/superpowers/prototypes/2026-10-10-ui-v3.html`

---

## 1. Intent

### 1.1 Why
Ba already ran the whole job-apply loop by hand with an AI assistant: find jobs on LinkedIn/TopCV, tailor a CV per job in Figma (EN/VI), export a one-page PDF, fill the application form, accept consent, submit. It worked (DEKON, SMARTBIT and YAVIET were submitted on TopCV) but needed constant steering, and problems such as a CV that didn't attach, a hidden Figma frame that failed to export, and spacing bugs were caught late.

The goal is a **local multi-bot app** that runs this loop with Ba as the approver rather than the operator, and that can later host bots for other kinds of work.

### 1.2 Success (Phase 1)
1. A scheduled scan produces at least one review card (job, company profile, tailored CV, QA score ≥ 80) without Ba stepping in.
2. Approving a card leads to a confirmed submission, and an application record is saved with the link, CV version and confirmation screenshot.
3. An automated test proves that nothing is ever submitted without Ba's approval.
4. Hitting a subscription usage limit pauses the work, and it continues automatically after the reset.

### 1.3 Non-goals for Phase 1
- The lookback / prompt-improvement agent (sub-project **C**). Phase 1 only *stores* the history it will need.
- Preference insights and packaging skills from conversations (sub-project **D**). Phase 1 only *stores* skip reasons and applications.
- Multi-user use, cloud hosting, a mobile app.
- Fully autonomous submission. Apply always waits for approval in Phase 1.
- Reading email for interview replies.

### 1.4 Hard constraints
- **No API keys.** All model work runs on Ba's existing subscriptions through their CLIs:
  - Claude: `claude` (Claude Code 2.1.x, logged in via claude.ai) at `~/.local/bin/claude`.
  - ChatGPT: Codex CLI bundled at `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex` (logged in via ChatGPT; not on PATH).
- Runs on Ba's Mac (macOS, Apple silicon), as a single user.
- Personal data stays local, except what model calls and job sites need.
- Subscription usage limits are real, so the design caps parallelism and job volume.
- **Browser = Ba's real Chrome, driven through the installed extensions**, so existing logins (TopCV, LinkedIn, ITviec, Figma, employer ATS sites) are reused and Ba never logs in again for the bots (§4.4). Both are already installed:
  - **Claude in Chrome**: native host `com.anthropic.claude_code_browser_extension`; enabled with `claude --chrome`.
  - **ChatGPT for Chrome (Codex)**: native host `com.openai.codexextension`.

---

## 2. Scope and decomposition

| Sub-project | Content | This spec? |
|---|---|---|
| **A. Platform core** | Local web app, Lead bot, bot registry, task/workflow engine, scheduler, trust guard, runner, chat + group rooms, Flow canvas | **Yes (thin version)** |
| **B. Job-apply crew** | Research, CV, QA, Apply bots; source adapters; review queue; applications tracker | **Yes** |
| **C. Lookback loop** | Reflection agent, prompt version scoring, prompt change proposals | Later spec. Phase 1 stores prompt versions, runs, scores and memory diffs. |
| **D. Insights and skills** | Learn preferences (company type, benefits, field, role) from applications and skips; package conversations into skills | Later spec. Phase 1 stores skip reasons and application data. |

---

## 3. Core rules and how they are enforced

These six rules come from the owner ("6 nguyên tắc cốt lõi"). Each is enforced by the system, not only by prompts.

| # | Rule | Enforcement |
|---|---|---|
| 1 | One manager bot receives every request | The chat composer in the main view always addresses **Lead**. Other bots cannot be messaged directly, except in group rooms via `@mention` (brainstorm only; there they cannot start workflows). |
| 2 | Each bot has one name, one role, one memory | One folder per bot with its own role prompt, `memory.md` and skills. Parallel instances share the definition and memory. Memory writes are *proposed* in task output and appended one at a time by the orchestrator. |
| 3 | Repeated work becomes a workflow | Workflows are named, versioned definitions (§7). Lead starts workflows rather than improvising chains. When Lead sees a request pattern repeat (2+ similar requests), it suggests saving it as a workflow; Ba approves. |
| 4 | A bot checks its own work before handing in | Every bot definition has a `selfCheck` checklist. Output must include `selfCheck: [{item, passed, note}]`, and the orchestrator rejects output with any failed item (counted as a failed attempt). |
| 5 | The lead bot only divides work | Lead's CLI session runs with **no** browser, Figma, shell or file-write tools. Its only tools are orchestrator MCP tools: `create_task`, `start_workflow`, `get_status`, `get_result`, `message_user`, `propose_workflow`. |
| 6 | Grant permissions step by step | Each bot has a trust level (L0/L1/L2, §5.3). The trust guard checks every outward-facing action. Promotion is suggested by the system and approved only by Ba. |

---

## 4. Architecture

```
 Ba ──chat──▶ ┌──────────────── apps/web (Next.js, localhost:3000) ──────────────┐
              │ Chat · Rooms · Flow canvas · Review · Applications · Schedules · │
              │ Bots · Master CV                                                │
              └──────────────┬──────────────────────────────────────────────────┘
                             │ REST + SSE (live events)
              ┌──────────────▼──────────────────────────────────────────────────┐
              │ apps/orchestrator (Node, launchd service, localhost:4100)       │
              │  workflow engine · task queue · scheduler · trust guard ·       │
              │  concurrency limiter · usage-limit watcher · runner ·           │
              │  orchestrator MCP server (tools for Lead)                       │
              └───────┬───────────────────────────────┬────────────────────────┘
                      │ spawn per task                │
         claude -p / codex exec                SQLite (data/app.db)
         cwd = bots/<name>/                    files (data/cv, data/pdf,
         allowed tools from bot.json            data/screenshots, data/transcripts)
                      │
         MCP: Figma · orchestrator
         Browser: Ba's real Chrome via Claude in Chrome / ChatGPT for Chrome extensions
```

### 4.1 Tech stack
- **Monorepo:** pnpm + Turborepo, same as `bs-kara`.
- **`apps/web`:** Next.js (App Router), React, Tailwind CSS v4 using the bs-kara token setup (`@theme inline` bridge, `data-theme` light/dark), Be Vietnam Pro + Space Grotesk, **React Flow (`@xyflow/react`)** for the Flow canvas.
- **`apps/orchestrator`:** Node + TypeScript, Fastify (HTTP + SSE), `better-sqlite3` + Drizzle ORM, `croner` for schedules, `@modelcontextprotocol/sdk` for the orchestrator MCP server.
- **`packages/shared`:** Zod schemas and TypeScript types shared by web and orchestrator (bot outputs, events, API).
- **Testing:** Vitest, Playwright.
- **Language:** TypeScript end to end. A faster backend language gives no meaningful gain because the time is spent in model calls and websites (decision recorded 2026-10-10).

### 4.2 Components (one purpose each)

| Component | Does | Depends on |
|---|---|---|
| **Web UI** | Renders state, sends user intents. No business logic. | Orchestrator API |
| **API + SSE** | REST for commands and queries, SSE stream of `Event`s | Engine, DB |
| **Workflow engine** | Advances runs step by step; fan-out/fan-in; QA gate loop; human gates | Task queue, DB |
| **Task queue** | Persists tasks, picks runnable ones respecting concurrency and pauses | DB, limiter |
| **Concurrency limiter** | Max sessions per engine (default Claude 2, Codex 2) and **browser lock** (1 task driving Ba's Chrome at a time) | none |
| **Browser bridge check** | Before a browser task starts, checks that Chrome is running and the engine's extension is connected; otherwise the task waits as `needs_browser` | Chrome extensions |
| **Usage-limit watcher** | Detects limit errors, pauses an engine until reset, auto-resumes | Runner output |
| **Runner** | Builds the CLI command from `bot.json`, spawns it, streams the transcript, parses and validates the final JSON | CLIs, Zod schemas |
| **Trust guard** | Allows or denies outward-facing actions by trust level and approval tokens | DB |
| **Scheduler** | Fires saved schedules as workflow triggers | Engine |
| **Orchestrator MCP server** | Exposes Lead's only tools (rule 5) | Engine |
| **Bots** | Folders with definitions (data, not code) | Runner |

### 4.3 Repository layout (target)
```
bs-job-agents/
  apps/web/                 Next.js UI
  apps/orchestrator/        engine, runner, API, MCP server
  packages/shared/          zod schemas, types
  bots/
    lead/  research/  cv/  qa/  apply/
      bot.json              definition (§5.1)
      ROLE.md               role prompt (versioned)
      memory.md             bot memory (append via orchestrator only)
      skills/               bot-specific skills (e.g. source adapters)
  workflows/
    job-scan.yaml           §7.2
    apply-to-link.yaml      §7.3
  data/                     gitignored: app.db, cv/, pdf/, screenshots/, transcripts/
    master-cv.yaml          Ba's master facts (§6.1), user-owned
  docs/superpowers/         specs, prototypes, plans
```

---

### 4.4 Browser: Ba's real Chrome
- **Why:** reusing Ba's Chrome means every existing login (TopCV, LinkedIn, ITviec, Figma, employer ATS sites) just works, with no separate bot browser to log into.
- **How:**
  - Claude bots run with `claude -p --chrome` (Claude in Chrome extension).
  - Codex bots use the ChatGPT for Chrome extension.
  - Exact headless behaviour is verified in Spike S2. If one engine cannot drive Chrome non-interactively, browser tasks for that bot switch to the other engine (a per-bot setting, not automatic).
- **Isolation:**
  - Each browser task works in its own tab group named after the bot.
  - Only one browser task runs at a time (browser lock, §10.3).
  - Ba can keep using other tabs, but should not close the bot's tab group.
- **Boundaries:**
  - Per-bot `allowedSites` (§5.1), matched by the extension's site permissions.
  - Research is read-only.
  - Apply works only on approved domains (§10.2).
- **Availability:** Chrome must be open with the extension connected, and the Mac awake. Otherwise browser tasks wait as `needs_browser` and start automatically when Chrome reconnects.

## 5. Bots

### 5.1 Bot definition (`bot.json`)
```jsonc
{
  "name": "research",                 // unique, lowercase
  "displayName": "Research",
  "role": "Find jobs that fit Ba and profile the companies behind them.",
  "engine": "codex",                  // "claude" | "codex" (switchable in UI)
  "model": null,                      // null = CLI default for the subscription
  "trustLevel": 2,                    // 0 | 1 | 2
  "allowedTools": ["web_search", "chrome:read", "skill:source-*"],
  "browser": { "mode": "read", "allowedSites": ["topcv.vn", "itviec.com", "linkedin.com"] },
  "mcpServers": [],
  "timeoutSec": 600,
  "outputSchema": "ResearchOutput",   // name of zod schema in packages/shared
  "selfCheck": [
    "Every job has a reachable URL",
    "Every job has full JD text (not a snippet)",
    "No job is a duplicate of another in this output"
  ],
  "promptVersion": 1                  // bumped on every ROLE.md change
}
```

### 5.2 The five Phase 1 bots

#### Lead (Claude, L1)
- **Receives:** every chat message from Ba; scheduled triggers; results from other bots.
- **Tools:** orchestrator MCP only: `start_workflow`, `create_task`, `get_status`, `get_result`, `message_user`, `propose_workflow`.
- **Does:** decides which workflow or task fits a request, fills its parameters (roles, locations, salary floor, sources, job link), starts it, reports progress, answers status questions from stored data.
- **Never:** browses, edits files, writes CVs, or applies.
- **Self-check:** "the request was turned into a workflow/task or a direct answer from stored data; no work was done directly".
- **Output:** `LeadOutput { reply: string, actions: Action[] }`

#### Research (Codex, L2)
- **Input:** search criteria and sources, *or* a single job URL, *or* a company to profile.
- **Tools:** web search, Ba's Chrome through the extension in **read mode** (navigate, read, screenshot; no form fill or submit) limited to job-site allowlist, source adapter skills.
- **Three task kinds:**
  1. `scan`: one source → list of `JobCandidate`.
  2. `fit`: candidate + master CV → `FitScore { score 0–100, reasons[], gaps[] }`.
  3. `company`: company name/site → `CompanyProfile`.
- **Self-check:** URL reachable; full JD captured; language detected; no duplicates; for `company`, at least 2 independent sources cited.

#### CV (Claude, L2)
- **Input:** job (JD), company profile, master CV, optional fix list (from QA or Ba), language.
- **Tools:** read `data/master-cv.yaml`, Figma MCP (write only to the Drafts page), PDF export, PDF text extraction.
- **Output:** `CvDraft { language, tailored: TailoredCv, figmaFrameUrl, pdfPath, changeNotes[] }`. Each bullet in `TailoredCv` carries `factIds[]` pointing at master facts.
- **Self-check:**
  - one A4 page
  - no hidden, clipped or overflowing text frames
  - PDF opens and text extracts in reading order
  - language matches the target
  - company name is correct
  - every bullet has `factIds`
  - no numbers or skills absent from the referenced facts

#### QA (Codex, L2; deliberately a different engine from CV)
- **Input:** JD, company profile, `CvDraft`, master CV, extracted PDF text.
- **Tools:** read-only (files, PDF text). No browser, no Figma.
- **Output:** `QaReview { total, scores{jdMatch/40, companyTone/20, formatAts/20, clarity/20}, hardFails[], fixes[], injectionSuspected: boolean }`.
- **Hard fails (automatic reject):** invented experience, skill or number (claim not supported by its `factIds`); wrong language; wrong company name; PDF does not open or is longer than one page; ATS text extraction out of order or missing sections.
- **Pass rule:** `total ≥ 80` **and** `hardFails` is empty.
- **Self-check:** every score has a justification; every fix is actionable and refers to a section.

#### Apply (Claude, L1)
- **Input:** approved application (job URL, PDF path, cover/intro text, saved answers) **plus an approval token**.
- **Tools:** Ba's Chrome through the extension with full interaction (uses Ba's existing logins), restricted to the approved job's domain(s); file upload of the approved PDF only.
- **Does:** opens the form, fills fields, uploads the PDF, ticks the employer consent box (covered by Ba's approval, §8 UC-08), submits, captures a confirmation screenshot and confirmation text.
- **Pauses:** on any required field with no saved answer (salary expectation, notice period, visa…), on a CAPTCHA, or on login.
- **Self-check before submit:** the correct PDF filename is attached and visible; all required fields are filled; the company and job title on the page match the approved job.
- **Output:** `ApplyResult { status: "submitted" | "needs_check" | "paused", confirmationText?, screenshotPaths[], pendingQuestions[] }`.

### 5.3 Trust levels

| Level | Meaning | Phase 1 assignment |
|---|---|---|
| **L0** | Draft only; every output needs Ba's acceptance | (none; available for new bots) |
| **L1** | Acts, but every outward-facing action needs an approval token | Lead, **Apply** |
| **L2** | Acts on its own within its allowed tools | Research, CV (Drafts page only), QA |

- **Outward-facing action:** submitting a form, sending a message or email, accepting a consent, changing anything outside `data/` and the Figma Drafts page.
- **Promotion suggestion:** after 10 consecutive tasks accepted without changes (QA pass on the first round for CV; approved without edits for Apply), the UI suggests a promotion. Only Ba can apply it. **Demotion:** automatic, back one level, on any hard fail or safety violation.

### 5.4 Bot memory
- Each bot output may include `memoryNotes: string[]` (≤ 3 short lessons, e.g. "TopCV upload limit is 5MB").
- The orchestrator appends them to `bots/<name>/memory.md` one at a time, with date and run id, and stores each change in `memory_changes` for the lookback sub-project.
- Memory is injected into that bot's prompt only. Lead passes cross-bot context explicitly in task input.
- `memory.md` is capped at 200 lines. When over the cap, the oldest notes are archived to `memory.archive.md`.

### 5.5 Runner: how a task runs
1. Build the prompt: `ROLE.md` + `memory.md` + task input (JSON) + output schema description + self-check list + the untrusted-content rule (§10.2).
2. Spawn the process:
   - Claude: `claude -p <prompt> --output-format stream-json` with the bot's allowed tools and MCP config, cwd `bots/<name>/`.
   - Codex: `codex exec --json` with the bot's sandbox/MCP config, cwd `bots/<name>/`.
   - Exact flags are verified in Spike S1 (§13).
3. Stream the transcript to `data/transcripts/<taskId>.jsonl` and emit `task.progress` events.
4. Parse the final message as JSON and validate it with the Zod schema.
   - **Invalid:** one repair prompt in the same session ("re-emit valid JSON for schema X").
   - **Still invalid:** the attempt fails.
5. If any self-check item failed, the attempt fails and its notes are kept.
6. Attempt policy: up to **2 attempts** per task (initial + 1 retry). Then the task fails and Lead reports it.

**Attempts are not QA rounds.** Attempts are technical retries of *one* task (crash, timeout, invalid JSON, failed self-check). QA rounds (§7.2 step 7, max 3) are separate tasks in a `gate` step, and each round's tasks get their own 2 attempts.

---

## 6. CV system

### 6.1 Master data (`data/master-cv.yaml`)
- **Owned by Ba only.** Bots read it and never write to it.
- **Content:** contact, headline options, `facts[]` (each with `id`, `type`: experience | project | skill | education | metric, `text`, `tags`, `org`, `dates`), plus the EN and VI wording when it exists.
- **Initial seed:** the content of the existing `build_targeted_resumes.py` (Gradion, Aegona, Apps Cyclone; skills; education) and the Figma file content. Ba reviews it once.
- **Missing facts:** when CV believes a fact is missing (e.g. "Docker?"), it returns `factRequests[]`. Lead asks Ba, and Ba adds the fact via the Master CV screen.

### 6.2 Figma
- **File:** `kJFoXNrTfFOtkQ515c0jHk` ("Resume (Community) V2").
- **Pages:**
  - `Templates`: 2–4 base templates (master, never modified by bots).
  - `Drafts`: one frame per CV version, named `<COMPANY>_<ROLE>_<LANG>_v<n>`.
- **Layout freedom:** CV may change section order, emphasis, which projects appear, fonts (from an allowed list: Be Vietnam Pro, Inter, Space Grotesk, Arial), accent colour, single/two-column layout and spacing, to suit the job and company.
- **Fixed limits:** A4 portrait, one page, minimum body font 9pt, all content as real text (no text in images), one clear reading order, contact line always present.
- **Export:** PDF to `data/pdf/<frameName>.pdf` (method verified in Spike S3).

### 6.3 Language rule (owner instruction)
- JD in **Vietnamese** → produce **VI and EN** CVs. The review card shows both, and Ba picks which to submit (default VI).
- JD in **English** (or any other language) → **EN** only.

---

## 7. Workflows

### 7.1 Step types

| Type | Meaning |
|---|---|
| `task` | Run one bot task |
| `map` | Fan out: run a `task` for each item of a list, in parallel within concurrency limits |
| `join` | Wait for all branches of a `map`. Continue with successes, and record failures (partial failure allowed unless `requireAll: true`) |
| `filter` | Pure code step (dedupe, threshold, top-N), no model call |
| `gate` | Loop: run producer → checker until pass or `maxRounds` (QA loop) |
| `human` | Wait for Ba's decision (review) |
| `action` | Outward-facing task; needs an approval token from a preceding `human` step |
| `record` | Pure code: write application/job records |

**Per-job pipelines:** after the `filter` that selects the top jobs, each job proceeds through its own branch (company → CV → QA gate → review → apply) independently. One job never waits for another.

### 7.2 `job-scan` (scheduled or from chat)
```
params: searchProfileId (defaults to the active Search Profile, §7.5), optional per-run overrides of any field
        (roles[], locations[], minSalary?, sources[], maxJobs=5, fitThreshold=60, …)
1  map   research.scan        over sources            → JobCandidate[]
2  join                       (partial ok; failed sources reported)
3  filter dedupe              vs jobs table (canonical URL; company+title+location hash) and applications
4  map   research.fit         over new candidates     → FitScore
5  filter top                 fit ≥ fitThreshold, sort desc, take maxJobs
── per selected job (parallel branches) ──
6  task  research.company     (cache hit if profile < 30 days old → skip)
7  gate  cv.tailor ⇄ qa.review   pass: total ≥ 80 && no hardFails; maxRounds=3
         (VI JD → gate runs for both VI and EN drafts)
8  human review               approve | request_changes(comment) → back to 7 | skip(reason)
9  action apply.submit        requires approval token from step 8
10 record application
```

### 7.3 `apply-to-link` (Ba pastes a job URL in chat)
Same as `job-scan` steps 6–10, preceded by `research.scan` on the single URL (kind `single`). There are no fit threshold or top-N filters. Fit is still computed and shown.

### 7.4 Scheduling
- Schedules are stored with a cron expression, workflow name and params; they can be edited in the Schedules screen or via Lead ("scan every weekday at 9").
- **Missed runs** (Mac asleep or off): on wake or start, at most one catch-up run per schedule, if missed within the last 12 hours.
- **No overlap:** a schedule never starts while its previous run is still active.

### 7.5 Search Profile (search criteria)
One active, versioned profile is shared by scheduled scans and chat requests. A chat request can override fields for one run.

| Field | Example | Default |
|---|---|---|
| roles | Frontend Engineer, Software Engineer (React/Node) | from first chat request |
| locations | Ho Chi Minh City, Remote (VN) | from first chat request |
| work modes | onsite / hybrid / remote | all |
| minimum salary + currency | 25,000,000 VND or 1,000 USD | none |
| seniority | mid, senior | mid, senior |
| sources | TopCV, ITviec, LinkedIn (toggles) | these three |
| include keywords | React, Next.js, TypeScript | none |
| exclude keywords | PHP, WordPress | none |
| excluded companies | (list) | none |
| preferred company types | product, AI | none (no filter) |
| CV languages | EN; VI+EN for Vietnamese JDs | as §6.3 |
| max jobs per scan | 5 | 5 |
| fit threshold | 60 | 60 |

---

## 8. Use cases, case by case

Format for each: **Trigger → Preconditions → Main flow → Alternate flows → End state.**

### UC-01: Ba asks Lead to find jobs in chat
- **Trigger:** "Find frontend jobs in HCM, React/Next.js, ≥ 25M, product companies".
- **Preconditions:** orchestrator running; master CV exists.
- **Main flow:**
  1. Lead parses the request into `job-scan` params.
  2. Lead calls `start_workflow`.
  3. A run card appears in chat.
  4. Lead replies with a delegation summary.
  5. Progress streams into the card and the Flow canvas.
- **Alternate flows:**
  - (a) The request is ambiguous (no role or location): Lead asks **one** clarifying question before starting.
  - (b) A `job-scan` run is already active: Lead offers to merge the criteria into the next run or start a second run (subject to concurrency).
  - (c) Master CV missing: Lead directs Ba to the Master CV screen and starts nothing.
- **End state:** run `running`; Ba sees a live card.

### UC-02: Scheduled scan fires
- **Trigger:** cron time reached.
- **Main flow:** the scheduler starts `job-scan` with the saved params. Lead posts "Scheduled scan started" in the Lead chat, then a summary when review cards are ready. A macOS notification is sent.
- **Alternate flows:**
  - (a) The previous run of the same schedule is still active → skip and log "skipped: overlap".
  - (b) An engine is paused for a usage limit → the run is created and waits in the queue (UC-16).
  - (c) Mac was asleep at the time → catch-up rule (§7.4).
- **End state:** run `running` or `waiting`.

### UC-03: Research scans sources (fan-out)
- **Main flow:**
  1. One `research.scan` task per source runs in parallel. Browser-using sources take the browser lock one at a time; search-only sources run concurrently.
  2. Each returns `JobCandidate { source, url, title, company, location, salaryText, postedAt, language, jdText }`.
- **Alternate flows:**
  - (a) A source needs login → that branch pauses (UC-17); the others continue.
  - (b) The source layout changed and the adapter self-check fails → branch failed, with a screenshot; Lead reports "TopCV adapter broken".
  - (c) LinkedIn → read-only, ≤ 40 page views per scan, 3–8 s random delay between pages.
  - (d) Zero results → the branch succeeds with an empty list.
- **End state:** candidates stored as `jobs` with status `new`.

### UC-04: Dedupe and fit score
- **Main flow:**
  1. Drop candidates whose canonical URL or (company + title + location) hash matches an existing job or application.
  2. Run `research.fit` for each remaining candidate.
  3. Keep jobs with fit ≥ 60, take the top 5.
- **Alternate flows:**
  - (a) Fewer than one job passes → the run ends with "no strong matches"; Lead shows the best 3 below the threshold with their gaps.
  - (b) A job seen before but skipped → stays excluded unless Ba says "show skipped".
- **End state:** selected jobs `status = selected`; others `below_threshold`.

### UC-05: Company research
- **Main flow:** `research.company` produces `CompanyProfile { name, website, industry, size, productOrOutsource, culture[], benefits[], reviewsSummary, sources[], researchedAt }`.
- **Alternate flows:**
  - (a) Profile younger than 30 days → reused (cache hit shown on the node).
  - (b) Little public information → profile marked `low_confidence`, and the review card shows a warning.
- **End state:** profile stored and linked to the job.

### UC-06: CV tailors a CV
- **Main flow:**
  1. CV picks a template.
  2. It writes `TailoredCv` from master facts.
  3. It duplicates the template frame into Drafts.
  4. It applies content and layout changes.
  5. It exports the PDF.
  6. It runs its self-check.
- **Alternate flows:**
  - (a) Export fails or a frame is hidden → CV fixes it and retries within the same attempt; if still failing, the attempt fails.
  - (b) Figma auth expired → paused (UC-17).
  - (c) A needed fact is missing → `factRequests` raised; CV continues without it (it never invents).
- **End state:** `cv_versions` row with PDF and Figma frame link.

### UC-07: QA gate and revision loop
- **Main flow:**
  1. QA scores the draft.
  2. Pass → go to review.
  3. Fail → `fixes[]` go to CV as a new round, which produces a new `cv_version` that QA scores again.
- **Alternate flows:**
  - (a) 3 rounds failed → escalate: the job goes to review marked "QA not passed", with all rounds visible. Ba decides (approve anyway, request changes, or skip).
  - (b) `injectionSuspected` → job flagged; Apply is disabled for it until Ba confirms.
- **End state:** a passing CV version, or an escalated card.

### UC-08: Ba approves a review card
- **Trigger:** "Approve & submit" on a card.
- **Main flow:**
  1. An approval token (single-use, bound to `jobId` + `cvVersionId` + target domain, valid 24 h) is created.
  2. `apply.submit` is queued.
  3. Approval explicitly covers ticking the employer's personal-data consent box for that application.
- **Alternate flows:**
  - (a) A VI JD → Ba picks the VI or EN version on the card before approving (default VI).
  - (b) Ba edits the intro/cover text on the card before approving → the edited text is used.
- **End state:** application `approved`, apply task queued.

### UC-09: Ba requests changes
- **Main flow:** Ba types a comment ("lead with Next.js; drop the education portal project"). It becomes a fix list for CV, then a QA gate round again, then the card returns to the queue.
- **Alternate flows:**
  - (a) The comment asks for a fact not in master data → CV raises `factRequests`, and the card shows "needs your input".
- **End state:** new CV version; card back in review.

### UC-10: Ba skips a job
- **Main flow:** Ba picks a reason (`salary_low`, `outsourcing`, `location`, `tech_mismatch`, `company_culture`, `seniority`, `other` + free text). Job `status = skipped`.
- **End state:** the reason is stored (input for sub-project D).

### UC-11: Apply submits
- **Preconditions:** a valid approval token.
- **Main flow:**
  1. The trust guard validates the token.
  2. Apply navigates within the approved domain.
  3. It fills the form and uploads the PDF.
  4. It self-checks.
  5. It ticks consent and submits.
  6. It captures confirmation text and a screenshot.
- **Alternate flows:**
  - (a) A required field has no saved answer → status `paused`; Lead asks Ba (UC-12).
  - (b) CAPTCHA or login → paused (UC-17).
  - (c) No confirmation detected after submit → `needs_check`; **never resubmitted automatically**. Ba checks and marks it submitted or failed.
  - (d) The page shows a different company or job than approved → abort, task failed, safety event logged.
  - (e) Navigation leaves the approved domain (e.g. to an ATS such as Workday or Breezy) → paused; Ba confirms the new domain, which is added to that token.
  - (f) A token is reused or expired → denied by the trust guard.
- **End state:** application `submitted` / `needs_check` / `paused`.

### UC-12: Unknown form question
- **Main flow:** Apply returns `pendingQuestions[{field, label, options?}]`. Lead asks Ba in chat. Ba answers, and Apply resumes on the same form when possible, or restarts the fill.
- **Saving:** Ba can tick "remember this answer", which stores it in `saved_answers` (key = normalised label) for future forms.
- **End state:** apply continues.

### UC-13: Track application status
- **Main flow:** the Applications screen lists every application (company, role, link, CV version + PDF, submitted at, confirmation screenshot, status). Ba updates the status manually: `submitted → interviewing → offer | rejected | withdrawn | no_response`.
- **End state:** status history stored with timestamps.

### UC-14: Ba pastes a job link
- **Trigger:** "Apply to this: <url>".
- **Main flow:** Lead starts `apply-to-link` (§7.3).
- **Alternate flows:**
  - (a) The URL was already applied to → Lead says so and stops, unless Ba says "apply again".
- **End state:** as `job-scan` from step 6.

### UC-15: Group room brainstorm
- **Trigger:** Ba creates a room (e.g. `#cv-brainstorm`), adds bots, and posts "@CV @QA how should I present the AI lab work?".
- **Main flow:** each mentioned bot answers in the room, in parallel, within its role and memory. Bots see the room history. Messages without a mention go to no bot.
- **Rules:**
  - Room bots run in **discussion mode**: no outward-facing tools, no Figma writes, no workflow starts.
  - Ba can say "@Lead turn this into a task" → Lead creates the task.
- **End state:** answers in the room; nothing executed.

### UC-16: Subscription usage limit reached
- **Main flow:**
  1. The runner detects the limit message (patterns verified in Spike S1).
  2. That engine's queue pauses, and the reset time is parsed (if not parseable, retry every 30 min).
  3. Tasks on that engine move to `waiting_limit`.
  4. The UI shows "Claude paused until 14:05".
  5. At reset the queue **resumes automatically**, and the interrupted task restarts from its beginning (its earlier steps are kept).
- **No engine switching** (owner decision).
- **End state:** work continues after the reset without Ba.

### UC-17: Login expired, CAPTCHA, or Figma auth
- **Main flow:** the task pauses with reason `needs_login(site)` / `captcha(site)` / `figma_auth`. Lead asks Ba to fix it in Ba's own Chrome (the bot's tab is brought to front) or to re-authenticate Figma. Because bots reuse Ba's Chrome, this should only happen when a site session has actually expired. Ba clicks "Done", and the task resumes.
- **End state:** task resumed; no credentials stored by the app.

### UC-18: Crash or restart recovery
- **Main flow:** every finished step's output is persisted before the next step starts. On orchestrator start, tasks in `running` are marked `interrupted` and re-queued (each counts as a new attempt). Runs continue from their last finished step.
- **Exception:** an interrupted `apply.submit` is **not** re-queued. It goes to `needs_check` (it may already have been submitted).
- **End state:** runs continue; no duplicate submissions.

### UC-19: Promotion suggestion
- **Main flow:** the trust rule is met (§5.3), and the Bots screen shows "Promote Apply to L2?" with its track record. Ba accepts or dismisses.
- **Phase 1 note:** L2 for Apply would allow submit without per-job approval. Phase 1 UI shows the suggestion but **keeps the promote button disabled for Apply** until a later phase explicitly enables it.

### UC-20: Ba edits master CV data
- **Main flow:** a structured editor on the Master CV screen (facts list with EN/VI text and tags). Saving bumps the master version. Open review cards built on an older master version show "master data changed; regenerate?".

### UC-21: Manage schedules
- **Main flow:** create, edit, enable/disable and delete schedules in the Schedules screen, or by telling Lead. Each shows its next run time and last result. Each schedule uses a Search Profile (default: the active one).

### UC-21b: Edit search criteria on the dashboard
- **Trigger:** Ba opens **Search criteria** from the sidebar, or the "Edit criteria" button on a run card or schedule.
- **Main flow:** Ba edits the profile fields (§7.5) in a form; saving creates a new profile version. The next scheduled or chat-started scan uses it. A run already in progress keeps the version it started with.
- **Alternate flows:**
  - (a) In chat Ba says "also include Đà Nẵng" → Lead asks: "just this run, or save to your criteria?" Saving updates the profile (new version).
  - (b) Validation: at least one role, one location and one source are required; minimum salary must be a number with a currency (VND/USD).
- **End state:** a new active profile version, visible on the dashboard with the date it changed.

### UC-22: Inspect a step
- **Main flow:** clicking a Flow canvas node opens a side drawer with the input, output, self-check results, transcript (streamed live if running), duration, attempts, engine, and the prompt version used.

### UC-23: Pause, cancel, or re-run
- **Main flow:** a run can be paused (no new tasks start; running ones finish) or cancelled (running tasks killed, run `cancelled`). A failed or finished step can be re-run, which invalidates and re-runs the steps after it in that branch.
- **Exception:** a submitted apply step can never be re-run.

---

## 9. Data model (SQLite)

| Table | Key columns |
|---|---|
| `bots` | name PK, display_name, engine, model, trust_level, prompt_version, enabled |
| `prompt_versions` | id, bot_name, version, role_md_hash, role_md_text, created_at |
| `memory_changes` | id, bot_name, run_id, task_id, note, created_at |
| `workflows` | name, version, definition_yaml, created_at |
| `runs` | id, workflow_name, workflow_version, trigger (`chat`/`schedule`/`link`), params_json, status (`running`/`waiting`/`paused`/`done`/`failed`/`cancelled`), created_at, finished_at |
| `steps` | id, run_id, step_key, branch_key (job id for per-job branches), status, output_json, started_at, finished_at |
| `tasks` | id, run_id, step_id, bot_name, kind, input_json, output_json, status (`queued`/`running`/`waiting_limit`/`paused`/`done`/`failed`/`interrupted`), pause_reason, attempt, engine, prompt_version, transcript_path, started_at, finished_at |
| `jobs` | id, source, url, canonical_url, dedupe_hash, title, company_id, location, salary_text, language, jd_text, fit_score, fit_reasons_json, gaps_json, status (`new`/`below_threshold`/`selected`/`reviewing`/`approved`/`applied`/`skipped`), skip_reason, skip_note, first_seen_at |
| `companies` | id, name, website, profile_json, confidence, researched_at |
| `cv_versions` | id, job_id, language, round, tailored_json, figma_frame_url, pdf_path, master_version, prompt_version, created_at |
| `qa_reviews` | id, cv_version_id, total, scores_json, hard_fails_json, fixes_json, injection_suspected, passed, created_at |
| `approvals` | token PK, job_id, cv_version_id, allowed_domains_json, expires_at, used_at |
| `applications` | id, job_id, cv_version_id, submitted_at, status, confirmation_text, screenshot_paths_json, status_history_json |
| `saved_answers` | key PK, label, answer, updated_at |
| `search_profiles` | id, name, version, active, roles_json, locations_json, work_modes_json, min_salary, currency, seniority_json, sources_json, include_keywords_json, exclude_keywords_json, exclude_companies_json, company_types_json, languages_json, max_jobs, fit_threshold, updated_at |
| `schedules` | id, name, cron, workflow_name, search_profile_id, params_json (overrides), enabled, last_run_id, next_run_at |
| `rooms` / `room_members` / `messages` | chat rooms (Lead chat is a room), members, messages (author = ba or bot, mentions, run refs) |
| `engine_state` | engine PK, paused_until, reason |
| `events` | id, type, payload_json, created_at (audit log + SSE replay) |

---

## 10. Errors and safety

### 10.1 Failure handling (summary; details in the use cases)

| Failure | Behaviour |
|---|---|
| CLI crash / timeout (default 600 s) | Retry once, then fail the task, and Lead reports it |
| Invalid output JSON | One repair prompt, then the attempt fails |
| Self-check failed | Attempt fails (counts toward the 2 attempts) |
| Usage limit | UC-16: pause engine → auto-resume at reset |
| Login / CAPTCHA / Figma auth | UC-17: pause, ask Ba |
| Source adapter broken | Branch fails with a screenshot; run continues |
| Apply without confirmation | `needs_check`; never auto-resubmit |
| Crash / restart | UC-18 |

### 10.2 Safety rules
1. **Approval tokens** (UC-08): Apply cannot start without a valid, unused, unexpired token matching the job and CV version. Enforced in the orchestrator before spawning.
2. **Domain lock:** Apply's browser actions are restricted to the token's allowed domains.
3. **Truthfulness:** master data is read-only for bots. Every CV bullet must cite `factIds`, and QA hard-fails unsupported claims.
4. **Untrusted content:** every prompt that includes fetched web content wraps it in a delimited `UNTRUSTED_CONTENT` block, with the instruction that it is data and never instructions. QA reports `injectionSuspected`, and Apply is disabled for flagged jobs until Ba confirms.
5. **One application per job:** a unique constraint on `applications.job_id` (overridable only by an explicit "apply again").
6. **No credentials stored:** logins live in Ba's own Chrome. Bots never read cookies, passwords or other tabs.
7. **Site allowlist for the real browser:** because bots drive the Chrome where Ba is logged into everything (email, banking…), each bot has an explicit `allowedSites` list (Research: job sites; Apply: the token's domains; CV: figma.com). The extension's site permissions are set to match, and any navigation outside the list stops the task and logs a safety event.
8. **Audit log:** every task, tool-relevant event, approval and safety denial is written to `events`.

### 10.3 Concurrency
- Per-engine session caps: default Claude 2, Codex 2 (configurable).
- **Browser lock:** tasks driving Ba's Chrome run one at a time, so two bots never fight over the same browser, and each works in its own tab group labelled with the bot name. Search-only Research tasks don't need the lock.
- **Chrome not open** (e.g. a scheduled scan while Chrome is closed): browser tasks wait as `needs_browser`, Ba gets a notification, and they start as soon as the extension reconnects. Non-browser steps keep running.
- Group room replies obey the same caps.

---

## 11. UI

**Approved direction:** `docs/superpowers/prototypes/2026-10-10-ui-v3.html` (chat-first, bs-kara theme, light/dark).

| Screen | Content | Key states |
|---|---|---|
| **Chat (Lead)** | Centered conversation; Lead replies with delegation trace (Lead → @Bot: task · status); run progress cards; job cards with fit/QA; suggestion chips; composer with `/` commands, `@` mentions (rooms), attach JD, engine chip | empty (first-run guide), streaming, error message from Lead |
| **Sidebar** | Chat, Flows, Review (badge), Applications, Search criteria, Schedules; Team list with live status dots and trust badge; Rooms; subscription usage / pause status per engine | engine paused banner |
| **Flow canvas** | React Flow: nodes per step with live output preview, animated edges for running, red dashed QA loop edge, stacked nodes for `map` (×N, running/queued counts), locked Apply node; Pause / Re-run step; zoom, minimap; node click → drawer (UC-22) | running, paused, failed node (red), waiting_limit (clock) |
| **Review queue** | Cards: job header + fit score, why it fits / gaps, company profile, QA breakdown + truth check, CV preview (VI/EN toggle when both), editable intro text; Approve & submit / Request changes / Skip with reason | QA not passed (escalated), needs your input, injection flagged |
| **Applications** | Table: company, role, link, CV version (PDF), submitted at, status (editable), screenshot | needs_check highlighted |
| **Search criteria** | Form for the active Search Profile (§7.5): roles, locations, work mode, salary floor + currency, seniority, sources (toggles), include/exclude keywords, excluded companies, preferred company types, CV languages, max jobs per scan, fit threshold; version history | unsaved changes, validation errors |
| **Schedules** | List + editor (cron presets: weekdays 9:00, daily, custom), Search Profile used, next run, last result | |
| **Bots** | Per bot: role, engine switch, trust level, track record, promotion suggestion, prompt version, memory view | |
| **Master CV** | Facts editor (EN/VI text, tags, org, dates), version history | |
| **Rooms** | Group chat with @mentions; bots answer in discussion mode | |

**File viewer rule:** clicking any file (CV PDF, confirmation screenshot, exported JD) **opens it in an in-app viewer**; it never downloads straight away.
- **PDFs** render with PDF.js (`pdfjs-dist`), with page count, zoom and "Open in Figma ↗" for CV versions.
- **Images** render in the same viewer with zoom.
- A **Download** button inside the viewer saves the original file. It is served by the orchestrator at `GET /files/:id?download=1` with `Content-Disposition: attachment` and the original filename.
- Esc or ✕ closes the viewer.
- Where it applies: review card (CV thumbnail and filename), Applications table (CV version, screenshot), and the step drawer (output files).

**Cursor rule:** every clickable element (buttons, links, tabs, toggles, chips, cards and canvas nodes with click handlers, checkboxes, sliders) uses `cursor: pointer`, and disabled elements use `cursor: not-allowed`. Set globally in `globals.css`, as in bs-kara, so components don't repeat it.

**Live updates:** SSE events (`run.*`, `step.*`, `task.progress`, `engine.paused/resumed`, `review.ready`, `application.updated`).

---

## 12. Testing (designed before code)

| Layer | Tool | Covers |
|---|---|---|
| Unit | Vitest | Workflow engine (order, map/join, partial failure, gate loop pass/fail/escalate at 3, human gate, per-job branches); trust guard (no token, expired, reused, wrong job, wrong domain); dedupe; top-N filter; scheduler (overlap skip, catch-up rule); concurrency limiter + browser lock; usage-limit pause/resume; memory append one at a time + 200-line archive |
| Output formats | Vitest + Zod | Every bot schema accepts valid and rejects invalid fixtures; repair-prompt path |
| Integration | Vitest + real SQLite + **FakeRunner** | Full `job-scan` from trigger to review to submit to record; crash mid-run → restart → continue; interrupted apply → `needs_check`; usage-limit mid-run → auto-continue |
| Source adapters | Vitest + saved HTML fixtures (TopCV, ITviec, LinkedIn, sample career page) | Field extraction; layout-change detection |
| UI end-to-end | Playwright + FakeRunner | Chat → run card; Flow nodes update over SSE; approve → Apply unlocks; request changes → new round; skip with reason; light/dark screenshot checks |
| Safety | Vitest + fixtures | JD with hidden instructions is not obeyed and gets flagged; Apply off-domain is blocked; double submission is impossible |
| Bot quality evals (on demand; uses the subscription) | Script | Golden set of 10 real JDs + master CV: QA score consistency (±5 across 3 runs), a CV seeded with invented facts must hard-fail, CV output one page; results stored per prompt version |
| Dry-run acceptance | Real pipeline, Apply in `dryRun` | Fills the form and screenshots, never clicks submit; required before the first live submission |

**FakeRunner:** implements the runner interface and replays scripted outputs keyed by bot, kind and scenario, including errors (timeout, invalid JSON, usage-limit message, needs_login).

---

## 13. Delivery stages (each with its own approval)

| Stage | Output | Gate |
|---|---|---|
| **0. Clickable prototype** | Throwaway HTML/React prototype of every screen in §11 and the main flows UC-01, 07, 08, 09, 10, 11, 12, 16, 22, with fake data | Ba approves the UX |
| **S. Technical spikes** (throwaway) | Findings doc answering: **S1** exact `claude -p` / `codex exec` flags for tool restriction, MCP config per bot, JSON output, and the usage-limit error format; **S2** driving Ba's real Chrome from a non-interactive session: `claude -p --chrome` with Claude in Chrome, and `codex exec` with ChatGPT for Chrome (or via the Codex app-server if `exec` cannot reach the extension); also per-site permission prompts, tab-group isolation, and file upload of a local PDF; **S3** Figma MCP from a headless session: duplicate frame, edit text, export PDF; **S4** Codex structured output with `codex exec --output-schema <file>` (flag confirmed to exist on 2026-10-10; verify behaviour) | Findings reviewed; spec updated if any assumption breaks |
| **Plan** | Implementation plan (writing-plans skill), split into small tasks, test-first | Ba approves the plan and picks the execution method |
| **1…n. Build slices** | Engine + FakeRunner first, then the real runner, then bots one at a time, then UI screens | Per plan |

---

## 14. Decisions log

| Date | Decision |
|---|---|
| 2026-10-10 | Split into A–D; Phase 1 = thin A + B |
| 2026-10-10 | Subscriptions only; bots run as `claude -p` / `codex exec` |
| 2026-10-10 | Approach 1: slim custom local web app (not a LibreChat / Vibe Kanban fork, not OpenClaw) |
| 2026-10-10 | Node/TypeScript backend (no Rust/C; bottleneck is model calls) |
| 2026-10-10 | CV: master data file + Figma templates; CV bot may adapt layout and content per JD/company |
| 2026-10-10 | Sources: TopCV, LinkedIn (read-only), ITviec, career sites, any site on request |
| 2026-10-10 | Scheduled scans + chat-triggered; max 5 jobs per scan; fit ≥ 60; QA ≥ 80; max 3 QA rounds |
| 2026-10-10 | One approval per job covers submit + consent; Apply pauses on unknown questions |
| 2026-10-10 | Parallel fan-out allowed; caps Claude 2 / Codex 2; browser lock |
| 2026-10-10 | Bots drive Ba's real Chrome via Claude in Chrome / ChatGPT for Chrome extensions (reuse logins); per-bot site allowlists; `needs_browser` wait when Chrome is closed |
| 2026-10-10 | Usage limit → wait for reset → auto-continue; no engine switching |
| 2026-10-10 | Promotion: system suggests, Ba approves |
| 2026-10-10 | UI: chat-first (Grok Bot style), bs-kara theme, Tailwind v4, React Flow canvas (ElevenLabs Flows style) |

## 15. Confirmed defaults (2026-10-10)
1. Default sources for scheduled scans are TopCV + ITviec + LinkedIn; career sites only via links or on request.
2. The default schedule is weekdays 09:00 Asia/Ho_Chi_Minh (editable).
3. Ba's first chat request seeds the Search Profile; after that, criteria are **edited on the dashboard** (Search criteria screen, UC-21b) or via Lead.
4. Application statuses are updated manually by Ba in Phase 1.
