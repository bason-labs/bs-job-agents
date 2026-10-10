# QA/QC report: Phase 2 (Engine, Runner, Bridges)

- **Branch:** `worktree-agent-a6044f608f8991375`, from `develop` at 4f08b31 (all Phase 2 merges: F1, W2b, W2c, W2a). 17 commits; every fix test-first.
- **Result:** the definition of done passes, uncached: install, typecheck, lint, test, build and e2e are all green.
- **Scope checked:**
  - the seams between the three parallel workers (W2a engine, W2b runner, W2c bridges), with the brief's six items (a)–(f)
  - spec §3, §4.2, §4.4, §5 (incl. §5.3, §5.5), §6.2, §7, §8 (the use cases the engine drives), §10, §12, line by line
  - one-off live checks of the real CLIs through the production wiring

## 1. Checks

| Check | Baseline (4f08b31) | Final (HEAD) |
|---|---|---|
| `pnpm install` | ✅ (peer warning: `@modelcontextprotocol/sdk` 1.26.0, ext-apps wants ^1.29.0) | ✅, no peer issues on a fresh resolution |
| `pnpm -w typecheck --force` | ✅ 4/4, 0 cached | ✅ 4/4, 0 cached |
| `pnpm -w lint --force` | ✅ 0 warnings | ✅ 0 warnings |
| `pnpm -w test --force` | ✅ 1,486 (shared 313, web 87, orchestrator 1,086) | ✅ 1,533 (shared 317, web 87, orchestrator 1,129) |
| `pnpm build --force` | ✅ 3/3 | ✅ 3/3 |
| `pnpm e2e` (`E2E_PORT=3177`) | ✅ 37/37 | ✅ 37/37 (web unchanged) |

Turbo's cache is shared across worktrees, so every run above used `--force`.

## 2. Seams and defects found and fixed

| # | Found | Fix | Commit |
|---|---|---|---|
| 1 | **(a) Guard hooks.** The engine built per-task hook settings (coordinator decision), but the runner ignored `RunnerTask.hookSettings` and built its own site guard from runner config as `<cmd> --sites a,b`. W2c's hook takes `--allow` (its strict `parseArgs` would throw, so every navigation would be blocked), and `createRunners()` has no hook config at all: **every Apply and CV spawn would have been refused in production.** | The runner merges the task's PreToolUse hooks into its base settings (only `hooks` is taken) and refuses a Claude task with Chrome tools whose hooks do not guard `navigate`, or with the Figma bridge whose hooks do not guard `figma_execute` (Claude Code's matcher rules: exact names, `\|`-lists, regexes, `*`, empty). `RunnerConfig.hooks`, `hookCommandLine` and the `--sites` hook are gone; `hookSettings` is typed `ClaudeHookSettings` (no cast). | ec8dbda |
| 2 | **Browser lock vs tools.** The engine takes the browser lock per task key (scan, single, submit), but the runner gave Chrome to every task of a browser bot: research.fit / company / file drove Ba's Chrome (Codex: user config with the Chrome plugin) outside the lock, so two Research tasks could drive Chrome at once (§10.3). | `RunnerTask.usesBrowser` (additive): false drops the Chrome tools (Codex then gets the clean non-browser setup). The engine passes the task's `uses_browser` and builds allowed sites and a site guard only for lock holders. | 274f07c |
| 3 | **(b) Prompt inputs.** cv.tailor inputs carry the engine's `templates`, which no schema described; every prompt schema except Apply's silently accepted unknown keys, so `promptInputSchemaFor` validated nothing beyond the known fields. | Shared `CvTemplateSchema` + `CvTailorInputSchema.templates` (optional). `BOT_TASK_PROMPT_INPUT_SCHEMAS` and `ConversationPromptInputSchema` are strict: the runner refuses an unknown key instead of sending it to a model. Engine-side task schemas still strip. | 45a8473 |
| 4 | **Orphaned CLI sessions (UC-18).** The runner persists each session only for the repair prompt and deletes it after the task; a crash skipped that, leaving Claude session files and Codex threads (prompt + Ba's data) in `~/.claude` / `~/.codex` (W2b residual risk). | `Runner.removeSession` (optional); ClaudeRunner/CodexRunner implement it. `Engine.start` removes the last spawned session of every interrupted task after stopping its process group; best effort; `StartReport.orphanSessions`. | e4c589d |
| 5 | **Figma on Codex.** Switching CV to Codex on the Bots screen would run `figma_execute` with no Drafts-only hook (Codex has none); only the after-the-fact fingerprint would notice. §6.2 requires the hook. | `checkBotSafety`: a bot with the Figma bridge must run on Claude (like S6 for browser bots that write). Loader, runner and trust guard refuse it. **PM to confirm** (Bots screen should disable CV's switch, like Apply's). | bf5ca5e |
| 6 | **Bots table never filled in production.** Only tests call `seedBots`; the Lead room, room members, `memory_changes` and `prompt_versions` reference `bots.name`. On a fresh database the scheduler's "Scheduled scan started", Apply's question cards and every memory note failed their foreign key (memory notes only with a logged warning). | `syncBotFromDefinition` (db) + `Engine.start` syncs every bot: missing rows as bot.json says; existing rows keep Ba's engine, trust level and enabled flag. | 8a1f142 |
| 7 | **prompt_versions never recorded** (PM brief to W2b/W2a: compare ROLE.md's hash at start-up and refuse a stale version). Neither side wired it, so sub-project C would have no prompt history. | `RolePromptSource` port (production: W2b's `readBotPromptFiles`): start-up stores each ROLE.md for its `promptVersion` and refuses to start when ROLE.md changed without a bump. | 8a1f142 |
| 8 | **(c) Folder convention.** The Figma guard's policy (`figma-guard.json`, protected ids) was written into `data/tasks/<id>/`, the CV bot's read folder, which by convention holds `master-cv.yaml` only. | `EnginePaths.guardDir` → `data/guards/<id>/`. | 870c60c |
| 9 | **CV's Figma MCP server via `npx -y figma-console-mcp@1.40.9`:** a PATH lookup a launchd service may fail, and a registry download on the first CV task. | The runner starts the copy the orchestrator already installs (same pin as its FigmaBridge) with `process.execPath`; npx only as a fallback. | 2f69c32 |
| 10 | **(e) MCP SDK** peer warning. | Pin 1.26.0 → 1.29.0 (the lowest in ext-apps' `^1.29.0`); figma-console-mcp's own `^1.26.0` dedupes to it. Live handshake with the real server: 121 tools. | 14f576b |
| 11 | **UC-04 b** ("show skipped"): the data layer could re-offer skipped jobs, but no job-scan param could ask for it. | `JobScanParams.showSkipped` (optional, additive) → the dedupe filter's `includeSkipped`. | 56527f9 |
| 12 | **FakeRunner fidelity.** Its default outputs came from shared fixtures whose self-check items do not match the real bot.json files (Research's per-kind lists): the real runner would have sent each of them a repair prompt. | Defaults report the task's real items (`resolveSelfCheckItems`). | 6312b2c |
| 13 | (d) `createProductionEngine` always used the real Chrome probe, so a test of it depended on whether Chrome runs on the machine. | Optional `browser` probe (default `chromeBrowserProbe`). | fb8a6b2 |
| 14 | Test hygiene: a schema-guard test opened two temp databases and removed one; each run left ~300 KB in `$TMPDIR` (25 had piled up). | Every temp folder is tracked and removed. A full orchestrator run now leaves nothing behind. | 4b46c23 |

## 3. Tests added: 47 (shared +4, orchestrator +43)

| File | Added | What it covers |
|---|---|---|
| `engine/runner-seam.test.ts` (new) | 13 | **(b)** The engine drives the REAL ClaudeRunner/CodexRunner (fake spawn answering per task), W2c's real guard builders, the real bots/*.json + ROLE.md, a real data folder: job-scan (VI+EN), apply-to-link, apply-to-file, approve → Apply, Lead chat, consult with every bot, room discussion. 16 task kinds, none refused, one CLI call each. Every input fits its strict prompt schema; flags per task (Chrome only under the lock, read dirs, Figma tools, Lead's MCP-only tools, read-only consult); transcripts at `data/transcripts/<task>-<attempt>.jsonl`; work dirs removed; **no approval token in any RunnerTask, argv, prompt, CLI file or transcript**; the merged hook commands run through `/bin/sh` as Claude Code does (site guard allows/blocks and logs; Figma guard blocks code outside Drafts). |
| `engine/production-wiring.test.ts` (new) | 6 | **(d)** `createProductionEngine` + `createRunners` + wiring.ts + W2c's `FigmaBridge` (FakeFigmaMcp running the bridge's plugin code on a FakeFigmaApi document), on a fresh database and real data folder: job-scan → review → approve → Apply → record. Real export into `data/pdf`, hash, pdf.js text for QA, verified copy `data/applications/<id>/BA_HUYNH_NOVAPAY_EN.pdf`, the record's hash, guard config, master-CV copy (read folder holds only it), memory note in `memory_changes`, bots table and prompt versions from start-up. |
| `engine/events.test.ts` (new) + harness | 2 (+ every engine test) | **(f)** The harness checks on every `t.idle()`: each row of a shared event type validates (else `toAppEvent` drops it from SSE silently), other rows are known audit-only types, and subscribers got exactly `replay(afterId)`, valid and in id order. All ~180 engine tests pass it. A busy run checks `replay(k)` as the suffix for several k; the checker catches a bad row and an unknown type. |
| `engine/startup.test.ts` (new) | 5 | Fresh database: bots synced (Lead room, memory notes, scheduler message work); Ba's Bots-screen changes kept; prompt versions stored, a stale ROLE.md refuses the start, a bump stores the new text. |
| `engine/spec-coverage.test.ts` (new) | 3 | Rule 4: an `ok` result with a failed self-check item fails the attempt and counts; §10.3: room replies and consult answers obey the caps and wait out a usage limit (UC-16); rule 6/§10.2: a permission denial is a `trust_level` safety event and a failed attempt. |
| `engine/recovery.test.ts` | 2 | UC-18 orphan session removal; a failing cleanup never stops the start-up. |
| `engine/queue.test.ts`, `job-scan.test.ts`, `trust-guard.test.ts`, `testing/fake-runner.test.ts` | 4 | Browser lock vs `usesBrowser`/site guard; UC-04 b show skipped; CV on Codex refused; FakeRunner self-check items. |
| `runner/argv.test.ts`, `claude/runner.test.ts`, `codex/runner.test.ts`, `config.test.ts` | 8 (net) | Hook merge/refusal and matcher rules, no `--sites`; Chrome dropped when `usesBrowser` is false; `removeSession` on both runners; the Figma MCP server default. |
| shared `runner-support.test.ts`, `workflow.test.ts` | 4 | Strict prompt schemas, cv.tailor templates, the Figma-on-Claude rule, `showSkipped`. |

## 4. Live checks (one-off, not in the suite)

Run from a temp dir outside the repo (`$TMPDIR/bsja-qa2-live-*`, a copy of bots/), through `createProductionEngine` + `createRunners` with the **real** spawn. Nothing drove Chrome or Figma (a dummy Figma port that throws; a Chrome probe that says no), nothing was submitted. Claude Code 2.1.296, codex-cli 0.162.0-alpha.17.2.

| Check | Result |
|---|---|
| `cv.consult` on **Claude, haiku** (bot.json model set in the copy only) | ✅ `done`, runner `ok`, 1 attempt; 4.5 s, $0.0016; reply within role; self-check passed. argv: `--tools Read`, base settings only, no MCP, `--session-id`. Session file **removed** from `~/.claude/projects`; transcript 12 lines ending `runner.result ok`; usage event 5 h 0.13 / 7 d 0.36. |
| `qa.consult` on **Codex, gpt-6-luna** | ✅ `done`, runner `ok`, 1 attempt; 17.8k input / 92 output tokens. argv: `--ignore-user-config --disable apps`, read-only, web search off. Thread **deleted** (nothing left in `~/.codex/sessions`); transcript 8 lines; work dir removed. |
| Start-up on the fresh live database | ✅ bots table filled, prompt versions stored for all five bots. |
| Real figma-console-mcp 1.40.9 on SDK 1.29.0 (initialize + `tools/list` only) | ✅ 121 tools incl. `figma_execute`, `figma_get_status`. |
| **Built (dist) hooks**, as production builds them (`dist/engine/wiring.js`) | ✅ commands point at `dist/bridges/chrome/site-guard/hook.js` and `dist/bridges/figma/guard-hook.js`, no tsx; six site-guard matchers. Site guard: `itviec.com` → exit 0, `mail.google.com` → exit 2 with the reason. Figma guard: `figma.root.children[0].remove()` → exit 2; code on the Drafts page by id → exit 0. In tests (source mode) the same builders run the `.ts` entries through tsx (seam test). |

## 5. Spec coverage (Phase 2 sections)

| Section | Status |
|---|---|
| §3 rules 1–6 | 1: consult/room bots refused (lead-tools), consult read-only (seam). 2: memory per bot, one at a time, `memory_changes` (production test). 3: workflows (W3a for proposals). 4: missing/failed items → repair/failed attempt (runner, engine, new rule-4 test). 5: Lead MCP-only (argv, seam, `checkBotSafety`), research.* only, no outward task. 6: trust guard + tokens (trust-guard tests); **demotion not implemented** (open item 2). |
| §4.2, §4.4 | Components present; site guard as a hook on Claude, prompt-only on Codex; upload needs `--add-dir` + `Read(dir/**)` (seam); `needs_browser` waits. **Tab-group cleanup missing** (open item 5). |
| §5.3, §5.5 | Trust levels per task (S1); runner steps 1–6 (W2b tests + seam + live); attempts vs rounds. "Lead reports it" (step 6): open item 4. |
| §6.2 | Status probe, `needs_figma`, Drafts, before/after fingerprint, guard hook (now merged), orchestrator export, Figma lock, pdf.js text (production test). |
| §7, §8 | Step types, the three workflows, scheduling (UC-02 a refined: open item 3). UC-01 c, 02, 03 a/c/d, 04 a/b, 05 a, 06 a/b/c, 07, 08, 09, 10, 11 a–f, 12, 14, 16, 18, 23 covered by engine tests; UC-17's Lead message and UC-25 a's handoff are open item 4. |
| §10.1 | Every row has a test; "with a screenshot" (adapter broken) and "Lead reports it" are open items 1 and 4. |
| §10.2 | Rules 1, 2, 4, 5, 6, 7, 8 tested (token, domain lock, untrusted blocks, injection flag, one per job, no cookies via the JS check, site guard, audit log + event invariants). Rule 7 "stops the task": open item 6. |
| §10.3 | Caps, browser lock (now also tool-level), Figma lock, `needs_browser`, room replies under the same caps. |
| §12 | Unit, integration, safety, Figma-bridge and form-filling rows covered; "both screenshots … files copied" is open item 1. |

## 6. Residual risks and open items for the PM

1. **Screenshots never reach disk (high).** Apply's `preSubmitScreenshot` / `confirmationScreenshot` / `jdSnapshot.pageScreenshot` are paths the bot names, but no tool writes a file: Claude in Chrome returns screenshots as images to the model, and the bot has no write tool. The §9.1 record would cite files that do not exist (§1.2 success 2, UC-11 steps 5–8, §12 "both screenshots … files copied"). Needs: the runner saving image `tool_result` blocks from stream-json into `data/applications/<id>/` (live-verify the format first; W2b/W2c handoff), the engine mapping the bot's names to those files, and a record check that they exist. Same for UC-03 b's "branch fails with a screenshot".
2. **§5.3 automatic demotion** (W2a open question): not implemented. The review decisions (`introEdited`, QA first-round pass) are stored for the promotion suggestion.
3. **UC-02 a refinement** (W2a): only a run still scanning, or paused, blocks the next fire; runs waiting for Ba's review do not. Spec says "while its previous run is still active".
4. **Lead's chat messages for engine events have no owner yet.** The engine posts only "Scheduled scan started", Apply's question cards and the protected-page alert. Missing: UC-17 "Lead asks Ba" for `needs_login` / `captcha` / `domain_confirm` (the shared `pause` card exists; nobody posts it), §5.5 step 6 / §10.1 "Lead reports it" for a failed task, UC-03 b "TopCV adapter broken", UC-02's summary and macOS notification, the prototype's usage-limit and Chrome messages, and UC-25 a's "Handed over from @Bot" (consult results are not processed by the engine). Decide: W3a posts them from events, or the engine does.
5. **Tab-group cleanup** after each browser task (§4.4) is not implemented; needs a live Chrome check (W2b/W2c handoff).
6. **Site-guard denials are retried once** (`denied` → retryable failed attempt). Spec §10.2 rule 7 says the navigation "stops the task"; the coordinator's decision E keeps the session running after a block. Decide whether a hook denial should fail the task without a retry.
7. **Confirm the new safety rule** "a bot with the Figma bridge runs on Claude" (item 5 in §2); W3c: disable CV's engine switch with the reason (like S10).
8. **Start-up refuses a stale ROLE.md** (PM brief): W3a must surface the error clearly; W4c must bump `promptVersion` with every ROLE.md change (tests already demand it).
9. **Contract changes for the coordinator** (all additive): `RunnerTask.usesBrowser`, `RunnerTask.hookSettings: ClaudeHookSettings`, `Runner.removeSession`, `StartReport.orphanSessions`, `EngineDeps.prompts`, `ProductionEngineOptions.browser`, `EnginePaths.guardDir`, shared `CvTemplateSchema`, `CvTailorInput.templates`, `ConversationPromptInputSchema`, `JobScanParams.showSkipped`, `FIGMA_MCP_SERVER_NAME`, db `syncBotFromDefinition`. Removed: `RunnerConfig.hooks`, `HookCommandConfig`, runner `hookCommandLine`/`shellQuote`.
10. **W3a handoffs:** `createRunners` must name the orchestrator MCP server (Lead fails without it); consult/discussion inputs must match `ConversationInput` exactly (strict); `lead.chat` has no prompt input schema yet; conversation tasks go through `createTask` (caps and limits apply, tested) but their results (reply, `handoffToLead`) need processing; the data folder path must not contain spaces, commas or parentheses (the runner refuses such read dirs: `Read(//dir/**)` rules), e.g. not `~/Library/Application Support`.
11. **Known residual risks (unchanged):** Codex Research's allowlist is prompt-only and its read-only sandbox can read the whole disk; Claude sees all 121 Figma tools (no `knownTools` list; only the allowed ones run and the guard blocks the rest); a click on an off-domain link is not a PreToolUse navigation (spike S2).
