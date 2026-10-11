# Runbook: running the job crew on your Mac

For Ba. How to set the app up, use it day to day, fix the usual problems, and do the checks and the dry run before the first real application.

Everything runs on your Mac, through your own Claude and ChatGPT subscriptions (no API keys). Nothing is ever sent to an employer without your click on **Approve**.

**Contents**
1. [Prerequisites](#1-prerequisites)
2. [Setup](#2-setup)
3. [First run](#3-first-run)
4. [Daily use](#4-daily-use)
5. [Troubleshooting](#5-troubleshooting)
6. [The safety model in plain words](#6-the-safety-model-in-plain-words)
7. [Pre-dry-run live checklist](#7-pre-dry-run-live-checklist)
8. [Dry-run acceptance](#8-dry-run-acceptance)
9. [Automated test lanes (for developers)](#9-automated-test-lanes-for-developers)

---

## 1. Prerequisites

| What | How to check | Expected |
|---|---|---|
| **Node 22.13 or newer** | `node --version` | `v22.13.0` or later (`nvm use` reads `.nvmrc`) |
| **pnpm 10.11.0** | `corepack enable && pnpm --version` | `10.11.0` |
| **Claude Code CLI**, logged in with your claude.ai account | `~/.local/bin/claude --version` | `2.1.x (Claude Code)` |
| **Codex CLI** (comes with the ChatGPT desktop app, logged in through ChatGPT; not on `PATH`) | `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex --version` | `codex-cli 0.162.x` |
| **Google Chrome**, running, with **Claude in Chrome** installed, signed in to the same claude.ai account as the CLI, and **connected** | see [check 1](#check-1-claude-in-chrome-is-connected) | the probe answers `CONNECTED` |
| **Figma desktop** with the **Figma Desktop Bridge** plugin, imported once from `~/.figma-console-mcp/plugin/manifest.json` | see [check 4](#check-4-figma-bridge-live-export) | `figma: connected` |

**Starting the Figma bridge (every session; it never starts by itself):**
1. Open Figma desktop and open your CV file.
2. Run **Plugins → Development → Figma Desktop Bridge**, and leave the plugin window open.

If Figma or the plugin is closed, CV steps wait (`needs_figma`) and start by themselves once it connects.

**Chrome:** the bots use your normal Chrome profile and its logins (TopCV, ITviec, LinkedIn, employer sites). Each bot session works in its own tab group. Keep Chrome open while a run works; if it is closed, browser steps wait (`needs_browser`).

The ChatGPT for Chrome extension is **not needed** while Research runs on Claude (owner decision E1, option A, applied). Only QA runs on Codex, and QA never uses a browser.

## 2. Setup

Run everything from the repo root.

```bash
pnpm install
pnpm build
```

### Settings (environment variables)

All are optional. Set them in the shell before starting the orchestrator.

| Variable | Default | Notes |
|---|---|---|
| `ORCH_DATA_DIR` | `data/` at the repo root | The path must not contain spaces, commas or parentheses (the bots could not read it). So **not** `~/Library/Application Support`. The repo's `data/` is fine. |
| `ORCH_WEB_ORIGINS` | `http://localhost:3000,http://127.0.0.1:3000` | The web app's address. Change it only if you run the web app on another port. |
| `ORCH_NOTIFY` | on | `0` turns off the macOS notifications ("review cards ready", "Lead needs you", "Chrome is closed"). |
| `ORCH_PORT` | `4100` | The API port (on `127.0.0.1` only). If you change it, start the web app with the same `ORCH_PORT`. |
| `BSJA_API_MODE` | `auto` | Set `live` for the web app, so it never falls back to the sample data when the orchestrator is down. |

### Start

```bash
BSJA_API_MODE=live pnpm dev
```

This starts the orchestrator (`http://127.0.0.1:4100`) and the web app (`http://localhost:3000`). Open http://localhost:3000.

- `curl http://127.0.0.1:4100/health` → `{"ok":true}`. A `503` with a reason means a degraded start (§5.1).
- The header must **not** show a **Sample data** badge. If it does, the web app is not talking to your orchestrator.

**The lock file.** While it runs, the orchestrator holds `data/orchestrator.lock`, so two orchestrators never share one database. A second one waits briefly and then refuses to start. A lock left by a crash is taken over automatically. Delete the file only when no orchestrator is running (`pgrep -fl "orchestrator"` shows nothing).

**Optional: start at login (launchd).** The spec runs the orchestrator as a launchd service. Do this only after the dry run has passed. Save the following as `~/Library/LaunchAgents/com.bason.job-agents.plist`, with your own repo path and Node path (`which node`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.bason.job-agents</string>
  <key>WorkingDirectory</key><string>/Users/bason/Documents/bason-labs/bs-job-agents/apps/orchestrator</string>
  <key>ProgramArguments</key><array>
    <string>/Users/bason/.nvm/versions/node/v22.13.0/bin/node</string><string>dist/index.js</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/Users/bason/.local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/job-agents.log</string>
  <key>StandardErrorPath</key><string>/tmp/job-agents.log</string>
</dict></plist>
```

Then `launchctl load ~/Library/LaunchAgents/com.bason.job-agents.plist`, and run the web app with `pnpm dev:web`. Run `pnpm build` again after every update. Stop the service with `launchctl unload …` before you run `pnpm dev` (otherwise the lock file stops the second orchestrator).

## 3. First run

1. **Master CV.** Review `data.example/master-cv.yaml`, then copy it into the data folder:
   ```bash
   mkdir -p data && cp data.example/master-cv.yaml data/master-cv.yaml
   ```
   After this, edit your facts on the **Master CV** screen. Bots only read this file. A CV bullet must cite a fact from it; anything else becomes a "fact request" for you.
2. **Earlier applications** (DEKON, SMARTBIT and YAVIET on TopCV). Run this while the orchestrator is **stopped**:
   ```bash
   pnpm --filter @bs-job-agents/orchestrator import:applications -- --data data --file data.example/imported-applications.yaml
   ```
   Running it again changes nothing.
3. **Start the app** (§2). Then check:
   - **Applications** lists the three imported rows, marked "imported". Missing parts show "not captured".
   - **Master CV** shows your facts.
4. **Search criteria.** Open **Search criteria**. Fill in roles, locations, sources, salary floor, maximum jobs per scan and the fit threshold, then **Save**. That saves version 1. Every later save makes a new version, and a run keeps the version it started with.
5. **Bots.** Open **Bots** and check:
   - Lead, CV and Apply say "Locked to Claude".
   - Research is on Claude, with no residual-risk note.
   - QA is on Codex.
   - Apply is at trust level **L1** (asks before every submission).

## 4. Daily use

- **Ask Lead** in **Chat**, for example "Find frontend jobs in HCM". Lead starts a job scan and a run card appears. It fills in as Research, CV and QA work. Open the run's **Flow** to see each step, its input, output, transcript and self-check.
- **Review queue.** Each job that passed QA (or was escalated after 3 rounds) waits as a card: fit, company profile, QA score, the CV (it opens in the viewer first) and your intro text. You decide:
  - **Approve & submit**: the dialog says exactly what Apply will do (site, file, consent box). Tick **Dry run** to fill and screenshot only.
  - **Request changes…**: your note goes to CV, and QA re-scores the new version.
  - **Skip (give reason)**.
- **Questions.** When a form asks something your saved answers don't cover, Apply pauses and the question appears in Chat. Answer it there; tick "Remember this answer" to save it for future forms.
- **Logins and CAPTCHAs.** A bot stops on a login wall or CAPTCHA and posts a card. Log in or solve it in your Chrome, then click **Done**.
- **Applications.** Every submission has its record: the fields Apply filled, the consent text, the uploaded CV with its SHA-256, the before-submit and confirmation screenshots, and the frozen JD. Update the status there (Interviewing, Offer, …). **Export all (ZIP)** gives you a CSV plus one folder per application; dry runs are left out.
- **Schedules.** Create them on **Schedules**, or ask Lead ("scan every weekday at 9") and click **Create schedule** on its card. Lead never creates one by itself.
- **Criteria from chat.** When Lead suggests a change ("also look in Đà Nẵng"), **Save to my criteria** saves a new version; **Just this run** doesn't.

## 5. Troubleshooting

### 5.1 Degraded start (`/health` answers 503, the UI shows the reason)

| Reason | What it means | Fix |
|---|---|---|
| `data_dir_invalid` | The data folder path has a space, comma or parenthesis, or isn't writable. | Use the repo's `data/`, or set `ORCH_DATA_DIR` to a path without those characters. |
| `db_open_failed` | `app.db` can't be opened. | Check disk space and permissions. Restore `data/` from your backup if the file is damaged. |
| `schema_guard` | A safety trigger or index is missing from the database (the records must stay immutable). | Don't edit `app.db` by hand. Restore it from backup, then report it. |
| `workflows_invalid` | A file in `workflows/` doesn't validate. | Undo the change (`git diff workflows/`), or fix the YAML and bump its `version`. |
| `bots_invalid` | A `bot.json` breaks a safety rule, e.g. Lead set to Codex on the Bots screen. | Use the message's fix (switch the bot back to Claude), then restart. |
| `prompt_version_stale` | A `ROLE.md` changed without a `promptVersion` bump. | Bump `promptVersion` in that bot's `bot.json`, run `pnpm --filter @bs-job-agents/orchestrator bots:lock`, then restart. |
| `engine_start_failed` | Something else failed at start-up (for example Lead's MCP server). | Read the orchestrator log, then restart. |

### 5.2 Usage limits (UC-16)
When a subscription hits its limit, that engine pauses until the reset time. The app shows a banner, and the sidebar says "paused · resumes in …". Queued tasks wait. At the reset, everything continues by itself; you don't need to click anything. There is no automatic switch to the other engine. To free quota, cancel a run on its Flow.

### 5.3 `needs_browser`: "Chrome is closed or its Claude extension is not connected"
1. Open Chrome.
2. Click the Claude in Chrome icon. It must be signed in to the same claude.ai account as the CLI and show it is connected. Answer any prompt it shows.
3. Close other Claude sessions that are driving Chrome at the same moment. The extension serves one session at a time; another one makes calls time out.
4. Re-run [check 1](#check-1-claude-in-chrome-is-connected). The waiting steps start by themselves once Chrome reconnects (it is checked every 15 s).

### 5.4 `needs_figma`: "Figma desktop … is not running"
Open Figma desktop with the CV file, then run **Plugins → Development → Figma Desktop Bridge**. The CV steps start by themselves. If a CV step stopped because a protected page changed, Lead asks whether it was you. "That was me — retry" restores CV's trust level and re-runs the step.

### 5.5 "<Source> adapter broken" (UC-03 b)
The source's page layout changed, so Research can't read it the way its skill says. That branch fails, and the other sources go on. The note includes a screenshot, or "not captured" plus the page URL; Research on Claude has no screenshot tool, so expect "not captured". Open the page yourself to see what changed, then ask for the skill in `bots/research/skills/source-<name>/SKILL.md` to be updated. LinkedIn is also marked broken when a scan goes over 40 page views or pauses less than 3 s between pages.

### 5.6 Other
- **The UI says "orchestrator unreachable"**: start it (`pnpm dev`), or check that `ORCH_PORT` matches for both.
- **"already applied"**: the job (or the same posting URL) already has an application. Ask Lead to "apply again" in your own words if you really mean it. The card then shows that you applied before.
- **A dry run reported "submitted"**: it counts as applied, and Apply is demoted one trust level. On Applications, check whether anything was really sent, and mark it Failed if not. Then restore Apply on the Bots screen.
- **Logs**: the orchestrator prints to its terminal (or `/tmp/job-agents.log` under launchd). Each task's transcript is in `data/transcripts/`, and in the Flow step drawer.

## 6. The safety model in plain words

1. **You say yes before anything is sent.** Apply can only submit with a one-time approval token, created when you click Approve. The token is tied to that job, that CV file (checked by SHA-256) and that site, and it expires after 24 h. Lead can't approve anything or answer Apply's questions for you.
2. **Only the web app can change things.** The API listens on `127.0.0.1` only, and it refuses any change that doesn't come from the web app's page (`Origin` and CSRF header checks). A script or another program on the Mac gets `403`. Reading needs no permission.
3. **Each bot has only the tools it needs:**
   - **Lead** only divides work. It has six orchestrator tools, no browser, no files, no shell, and it runs on Claude only.
   - **Research** reads job sites in your Chrome (read-only, TopCV / ITviec / LinkedIn only, enforced by a site guard) and its own skill files.
   - **CV** edits only the Drafts page in Figma; a guard blocks anything else, and the protected pages are fingerprinted before and after.
   - **QA** only reads.
   - **Apply** fills forms only on the approved site and pauses when a page leads elsewhere.
4. **Pages are untrusted.** Text on a job page is data, never instructions. A bot that notices a page trying to instruct it reports it. The card is then flagged, and Apply stays off until you confirm the page.
5. **Every submission is recorded**, and the record can't be changed afterwards: fields, consent, the uploaded file with its hash, screenshots and the JD as it was. The export leaves out the approval token.
6. **Bots that break rules lose trust.** A guard block or a dry run that "submitted" moves the bot down a trust level, and Lead tells you. Only you can restore it.

## 7. Pre-dry-run live checklist

Do these in order, with the app stopped unless a step says otherwise. Each one uses your subscriptions a little and touches nothing outside the listed page. Results of the run by W4b on **2026-10-11** are recorded under each check.

Two things that make these checks flaky (found by W4b):
- **One Claude session on Chrome at a time.** Close other Claude Code sessions (and the app) before a `--chrome` check; the extension serves one session, and a second one makes the calls time out (§5.3).
- **Keep `--strict-mcp-config` and `--setting-sources ""`** on every manual `--chrome` command, as written below. Without them your own MCP servers and settings load too, so the check no longer matches what the app runs and may hang on a server prompt.

### Check 1: Claude in Chrome is connected
```bash
claude -p "Call mcp__claude-in-chrome__tabs_context_mcp once WITHOUT createIfEmpty, then reply CONNECTED <n tabs> or NOT_CONNECTED <error>. Call nothing else." \
  --chrome --setting-sources "" --strict-mcp-config --tools "" \
  --allowedTools mcp__claude-in-chrome__tabs_context_mcp \
  --no-session-persistence --permission-prompts none --model haiku < /dev/null
```
- **Expected:** `CONNECTED <n>`. This lists the session's tab group only; it opens nothing.
- **2026-10-11 (W4b): blocked, needs Ba.**
  - Chrome was running with the extension installed, and the CLI saw the `claude-in-chrome` server as "connected".
  - The tab call timed out ("did not respond in time … Chrome may be waiting for the user"). One probe listed the browser as `inUse: true`; the next listed no browser at all. The capture check then got "Browser extension is not connected".
  - **Ba:** do §5.3 steps 1–3, then run this check again.

### Check 2: screenshot capture (image format, file, transcript)
```bash
pnpm --filter @bs-job-agents/orchestrator live:screenshot
```
- **What it does:**
  - opens ONE new tab in its own group and goes to `https://example.com` (the site guard allows only `example.com`);
  - takes one screenshot, closes its tabs, and lists what is left.
  - Every output line goes through the runner's own capture code, exactly as in an Apply task.
- **Expected:**
  - `PASS`;
  - `captured 1.png` (or `.jpg`) with an `ss_…` id, and `manifest: …/screenshots/1-1/manifest.json`;
  - `transcript keeps base64: no`.
- **Compare with the fixture:** the `image blocks seen` lines show the real block shape. Compare it with the synthetic fixture in `apps/orchestrator/src/runner/__fixtures__/screenshots.ts` (`{type:"image", source:{type:"base64", media_type, data}}`, plus the MCP form `{type:"image", data, mimeType}`). If the shape differs, save the printed line as a fixture and file it for a fix.
- **2026-10-11 (W4b): blocked by check 1** ("Browser extension is not connected"; nothing was opened). The script and its output format are in place.

### Check 3: tab cleanup
- **What to look at:** the last line of check 2 (`LEFT <n>`), and your Chrome window after it.
- **Expected:** `LEFT 0`, and no leftover tab group or empty "New Tab" from the check.
- **If a tab is left:** close it by hand and note it here. The bots' prompts tell them to close every tab they open, including the group's empty one.
- **2026-10-11 (W4b): blocked by check 1.**

### Check 4: Figma bridge live export
Open Figma desktop with the CV file and start the Desktop Bridge plugin (§1). Then:
```bash
pnpm --filter @bs-job-agents/orchestrator bridges:live-check
```
- **What it does:** read-only on Chrome (it reads the process list only). In Figma it fingerprints the protected pages, exports the Drafts frame `SPIKE_TEST_EN_v1` to a temp PDF, and fingerprints the pages again.
- **Expected:**
  - `figma: connected …`;
  - `pdfInfo: 1 page(s), 595×842 pt, one-page A4: true`;
  - readable text with no `wit h` splits;
  - `protected pages: unchanged`, and exit code 0.
- **Then check `needs_figma` → resume:**
  1. Close the plugin.
  2. Ask Lead for a scan with one job. When a CV step waits, Chat says Figma isn't running.
  3. Start the plugin again. The step starts by itself.
- **2026-10-11 (W4b): blocked, needs Ba.** Figma desktop was running, but the Desktop Bridge plugin was not ("not_connected after 20 s"). Chrome check: running, with Claude in Chrome and ChatGPT for Chrome installed.

### Check 5: Codex with `node_repl` off, and `cua_repl` network
- **Only needed if Research goes back to Codex** (owner decision E1 option B or C).
- With option A (current), no bot uses Codex's Chrome plugin, so this check is skipped.
- If you ever pick B or C:
  1. Run a `codex exec` browser-setup session that lists its tools only.
  2. Confirm `node_repl` is off.
  3. Ask it to `fetch('http://127.0.0.1:4100/health')` from `cua_repl`. If that works, stop: B and C are not safe.
- **2026-10-11 (W4b): not needed (option A applied).**

### Check 6: Codex's sandbox can't reach the API
With an orchestrator running on 4100, run:
```bash
/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex exec --json --skip-git-repo-check \
  --ignore-user-config --disable apps --sandbox read-only -c 'web_search="disabled"' --ephemeral \
  'Run exactly: curl -sS -m 5 http://127.0.0.1:4100/health ; echo EXIT=$? . Reply with its output.' < /dev/null
```
- **Expected:** `curl: (7) Failed to connect …`, `EXIT=7`, while `curl http://127.0.0.1:4100/health` from your own terminal answers `{"ok":true}`.
- **2026-10-11 (W4b): passed.**
  - A throwaway orchestrator (FakeRunner, temp data folder) was listening on `127.0.0.1:4100`, and the host's `curl` got `{"ok":true}` before and after.
  - Inside Codex's read-only sandbox (the flags QA consult runs with): `curl: (7) Failed to connect to 127.0.0.1 port 4100 after 0 ms`, `EXIT=7`.
  - QA on Codex therefore can't reach the API (E1 context).

### Check 7: E1, Research runs on Claude
- **What to confirm:**
  - `bots/research/bot.json` has `"engine": "claude"`;
  - the Bots screen shows Research on Claude with no residual-risk note;
  - Research can read its skills and nothing else:
    ```bash
    cd bots/research && claude -p "Read ./skills/source-topcv/SKILL.md and give its first heading; then Read ../lead/ROLE.md. Reply SKILL: … and OUTSIDE: …" \
      --setting-sources "" --strict-mcp-config --tools "Read,WebSearch" \
      --allowedTools "WebSearch" "Read(./skills/source-*)" "Read(./skills/source-*/**)" \
      --no-session-persistence --permission-prompts none --model haiku < /dev/null
    ```
- **Expected:** `SKILL: # TopCV (topcv.vn)` and `OUTSIDE:` denied.
- **2026-10-11 (W4b): passed.**
  - `engine` is `claude`.
  - The Bots screen, as served by the real orchestrator, shows no residual-risk note (e2e `live-shape/bots.spec.ts`).
  - The skill was read (`# TopCV (topcv.vn)`), and `../lead/ROLE.md` was denied, listed in `permission_denials`.
  - Research gets `--chrome` with the site guard only for `scan` and `single`; `fit`, `company` and `file` run without Chrome (`engine/bots.ts` `BROWSER_TASK_KEYS`, runner drops Chrome when `usesBrowser` is false).

## 8. Dry-run acceptance

Required before the first real submission (spec §12). It needs checks 1–4 to pass. Do it on a job you **actually want** to apply to, because the dry run is followed by the real application.

The app enforces this: until one dry run has finished on your data folder, **Approve & submit** without **Dry run** is refused with "Do a dry run first …", and nothing is approved or sent. A dry run is always allowed, on any job. A dry run that reported "submitted" does not count until you have checked it and marked it Failed.

1. **Start clean:** `BSJA_API_MODE=live pnpm dev`, Chrome open with Claude in Chrome connected, Figma open with the Desktop Bridge plugin running. Check that there is no **Sample data** badge.
2. **Find the job:** ask Lead, e.g. "Find frontend jobs in HCM", or paste the job's link into Chat. Wait for its review card.
3. **Read the card:** the fit reasons, the company profile, the QA score and, in the viewer, the CV PDF (one A4 page, your facts only). Edit the intro if you want.
4. **Approve as a dry run:**
   - Click **Approve & submit**, then read the dialog: it names the site, the file to upload and the consent box.
   - Tick **Dry run**, then click **Approve dry run**.
5. **Watch Apply** in your Chrome (its own tab group). It opens the posting, fills the form, uploads the approved PDF, ticks the consent box and takes screenshots. It must **never click submit**. If the form asks something it doesn't know, the question appears in Chat. Answer it there.
6. **Check the result:**
   - Chat says the dry run finished and nothing was sent.
   - The card is back in the queue with **Approve live & submit**, using the same CV.
   - **Applications** has a row marked **dry run**, in status **Needs check**. Its record panel shows the filled fields, the consent text, the uploaded CV with its SHA-256 and the **Before submit** screenshot (open it: it shows the filled form). The JD snapshot is there too. No confirmation screenshot, because nothing was submitted.
   - **Export all (ZIP)** leaves the dry run out.
   - In your Chrome, the employer's site shows no submitted application, and no tab from the bot is left.
7. **If anything is wrong** (it submitted, it went to another site, a field is wrong): stop. Mark the row Failed after checking, and report what happened, with the record and transcript.
8. **Go live (optional, when happy):** on the card, click **Approve live & submit**. Apply fills the form again and submits once. The application shows **Submitted**, with both screenshots (before submit and confirmation) and the confirmation text, and the card leaves the queue.

## 9. Automated test lanes (for developers)

None of these call a real CLI, Chrome or Figma.

| Command | What it runs |
|---|---|
| `pnpm -w test` | Vitest in every package. |
| `pnpm e2e` | Playwright on the web app's **mock** backend: every screen's behaviour, the §11 rules, and **light/dark screenshot comparisons** against `apps/web/e2e/__screenshots__/` (frozen clock, ≤ 1% differing pixels). After an intended UI change, review the diff in the report, then run `pnpm --filter @bs-job-agents/web e2e:screenshots` to refresh the baselines. Baselines are taken on macOS. |
| `pnpm e2e:live-shape` | Playwright with the web app in **live** mode against the **real orchestrator** (built `dist/`, real API, SSE, Lead's MCP server, engine and scan checker) on a throwaway data folder. FakeRunner stands in for the CLIs, and fakes stand in for Chrome and Figma (`apps/orchestrator/e2e/live-shape-launcher.ts`, test only). It covers: chat → run card, the canvas following the run, dry run → approve live → record and viewer, request changes, skip, a UC-12 question, the usage pause with auto-resume, the criteria and schedule proposals, schedules, the export ZIP, the Bots locks, and §12's "dry run before the first live submission" gate (the launcher keeps that gate off unless a test resets with it on). Ports: web 3399, orchestrator 4199, control 4198 (`E2E_LIVE_PORT`, `E2E_ORCH_PORT`, `E2E_CONTROL_PORT`). |
