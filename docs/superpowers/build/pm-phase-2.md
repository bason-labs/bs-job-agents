# PM review: Phase 2 (Engine, Runner, Bridges)

- **Reviewed:** `develop` at f26af2e (F1, W2b, W2c, W2a and the Phase 2 QA/QC fixes), in worktree branch `worktree-agent-a22951153ec236314`.
- **Read:** the spec, the spike findings, `stage0-prototype.html`, phases.md, progress.md, pm-phase-1.md, the four Phase 2 reports, qa-phase-2.md, and the code in `apps/orchestrator/src/{engine,runner,bridges,db}`, `drizzle/`, `packages/shared/src`, `bots/`.
- **Re-ran (uncached):** `pnpm install --frozen-lockfile`; `pnpm -w typecheck --force` 4/4; `pnpm -w lint --force` 4/4; `pnpm -w test --force`: 1,533 tests (shared 317, web 87, orchestrator 1,129). The QA numbers hold.
- **Probed** the real modules with throwaway scripts (not committed): the engine through `createTestEngine` and FakeRunner, the runners with a fake spawn, and the bridges directly. No live CLI, Chrome or Figma call was made. The results that drive this review:

| # | Probe | Result |
|---|---|---|
| P1 | Apply reports `submitted` with `preSubmitScreenshot: "/Users/bason/.ssh/id_ed25519"`, `confirmationScreenshot: "screenshot 3: confirmation page"` and a JD page screenshot of `../../../etc/passwd` | Application `submitted`. The immutable record stores `../Users/bason/.ssh/id_ed25519`, `screenshot 3: confirmation page` and `../../../etc/passwd`. No screenshot file exists anywhere. |
| P2 | Apply pauses `domain_confirm("vn")` (or `"com"`), and Ba confirms it | The token's domains become `["itviec.com","vn"]`. The respawned site guard allows `vietcombank.com.vn` (or, with `"com"`, `mail.google.com`). Apply can also ask for `google.com` without any guard block, and one confirm adds it. |
| P3 | argv of `research.scan` on Codex (browser), against Ba's real `~/.codex/config.toml` | No `--disable apps` and no `--ignore-user-config`. Only `[plugins.*]` entries are disabled, so three things reach the bot: his other `mcp_servers` (`node_repl` is enabled; `computer-use` is defined but disabled today), his ChatGPT connectors (`codex_apps`), and his `notify` program. |
| P4 | job-scan with itviec and linkedin; linkedin returns `needs_login` | itviec's scan is done, but the `scan` map waits for linkedin forever. No itviec job reaches review, the next three scheduled slots are skipped as `overlap`, and Ba gets no message. |
| P5 | Crash after a CV attempt changed a protected page | After restart, attempt 2 takes a new "before" fingerprint and passes. No `safety.denied`, no alert. |
| P6 | Prompt for apply.submit, cv.tailor, research.file | `jobUrl`, `answers[].label`, `savedAnswers[].label` (employer form labels), QA's `fixes` and the upload's `filename` sit in the trusted task JSON, not in UNTRUSTED_CONTENT blocks. |
| P7 | Engine flows | These match the spec: per-job branch independence, VI + EN gates (VI passed, EN escalated, card defaults to VI), request changes, usage-limit pause and auto-resume (including after a restart), crash recovery (Apply → `needs_check`, orphans killed), cancel, re-run rules, dry run → `needs_check` + safety event, Lead tool refusals, scheduler catch-up. No token appears in any prompt, task row, event or Lead tool result. |

## 1. Verdict

**Ready for Phase 3: yes, once M1–M5 have merged** (one fixer, F2). F2 also takes S1–S6 in the same batch. W3a builds on them, so W3a starts with REST, SSE, workflows and schedules and adds chat, consult and MCP once they merge.

- **What is solid:**
  - The engine is a well-built state machine on real SQLite. Every engine test also checks the event invariants. The apply path, with its token binding, copy + re-hash, never-retried Apply and `needs_check` on doubt, does what pm-phase-1 asked.
  - The runner fails closed: strict prompt inputs, no token in any prompt, hooks required for Chrome and Figma, and Chrome only for the task that holds the lock.
  - The site guard's URL handling and the Figma guard's code checks survive an adversarial pass. The gaps are in what an allowlist accepts (M2) and what the fingerprint compares (S9).
  - Test quality is high: behaviour-level tests with spec references, a seam test through the real runners, and a production-wiring test.
- **What must change first:** five defects. Four weaken a safety rule and one stalls scans. Bots drive Ba's real Chrome, so the allowlist and the record are the product's safety story.

## 2. MUST-FIX before Phase 3 (fixer F2)

### M1. The submission record stores whatever the bot names as a screenshot
- **What:** `writeSubmissionRecord` copies `preSubmitScreenshot`, `confirmationScreenshot` and `jdSnapshot.pageScreenshot` from Apply's output into the record through `relPath`, unchecked (probe P1). No tool writes these files (QA open item 1).
- **Where:** `apps/orchestrator/src/engine/apply.ts` l.543–558 (`writeSubmissionRecord`).
- **Why:**
  - §9.1: the record proves what was sent and is immutable, so a bad path can never be corrected.
  - Every real submission today would get a "complete" record whose screenshots do not exist.
  - The paths come from untrusted output. W3a's file viewer and UC-13b's export ZIP would read whatever they name, e.g. `~/.ssh/*`, and the ZIP is what Ba shares.
- **Acceptance:**
  - The record only cites files the orchestrator itself put in `data/applications/<id>/`: resolved inside that folder, existing, and an image (PNG/JPEG magic bytes). Anything else is stored as null.
  - A `submitted` result whose record has no pre-submit screenshot, or has neither a confirmation screenshot nor confirmation text, is recorded as `needs_check` with the note "screenshots not captured". It is never recorded as clean.
  - Probe P1 becomes a test: all three values end up null, and the application is `needs_check`.
  - Until S7 (the capture pipeline) lands, every real Apply therefore ends in `needs_check`. That is the intended fail-safe; no live submission happens before Phase 4 anyway.

### M2. Allowlists and approval domains accept public suffixes, and Ba confirms a domain the bot names
- **What:**
  - `DomainSchema`, `createApproval`/`addApprovalDomain` (`validDomains`) and the site guard's `normalizeAllowlist` accept single labels and public suffixes (`com`, `vn`, `com.vn`, `github.io`) as well as IPs and `localhost`. `hostAllowed` then allows every host under them (probe P2).
  - `domain_confirm`'s site comes from Apply's own output, and the engine offers it to Ba even when no navigation was blocked.
  - Site comparison is case-sensitive, and a site containing `)` corrupts the stored pause reason. Either way the pause gets stuck.
  - `UrlSchema` and `registrableHost` accept LAN hosts (`http://192.168.1.1/…`), so an approved card can send Apply to a router page in Ba's Chrome.
- **Where:**
  - shared `common/primitives.ts` l.20 (`DomainSchema`)
  - `db/repos/approvals.ts` (`validDomains` l.33, `addApprovalDomain` l.281)
  - `bridges/chrome/site-guard/allowlist.ts` l.23
  - `engine/queue.ts` l.477–496 (`selfPause`)
  - `engine/apply.ts` l.61 (`registrableHost`) and l.479–508 (`resumePausedTask`)
- **Why:** §10.2 rules 2 and 7, and UC-11 e. One click on a plausible-looking card ("Apply needs `vn` to continue") would let a bot act on Ba's bank and email while he is logged in.
- **Acceptance:**
  - One shared host rule is used by `DomainSchema` (or a new `PublicDomainSchema`), the approval repository and `normalizeAllowlist`. It refuses single labels, entries on the Public Suffix List (e.g. `tldts`, pinned), IP literals, `localhost`, `*.local` and private ranges.
  - Tests: each of `com`, `vn`, `com.vn`, `github.io`, `127.0.0.1`, `192.168.1.1` and `localhost` is refused by `createApproval`, `addApprovalDomain`, `normalizeAllowlist` and approve's job-URL check. `topcv.vn`, `itviec.com` and `acme.wd3.myworkdayjobs.com` are accepted.
  - The engine offers `domain_confirm` only for a host the site guard actually blocked in that attempt (the guard log's `target`), normalised to lowercase. A bot-named site with no matching block goes to `needs_check` with a `safety.denied` event.
  - Probe P2 becomes a test.

### M3. Codex browser sessions inherit Ba's Codex setup beyond the Chrome plugin
- **What:** a Codex browser bot (Research's scan and single kinds) runs with Ba's user config, and only `[plugins.*]` entries are disabled. Three things still reach the bot (probe P3):
  - his ChatGPT connectors (`codex_apps`; `--disable apps` is passed only to non-browser bots);
  - every user-config MCP server, including `node_repl`, which runs code and is enabled today, and `computer-use`, which operates the Mac's apps and would be inherited as soon as Ba enables it;
  - his `notify` program.
- **Where:** `apps/orchestrator/src/runner/codex/argv.ts` l.46–51; `runner/config.ts` (`codexPluginsToDisable`).
- **Why:** §4.4 says the Codex browser setup keeps the Chrome plugin and nothing else of Ba's. §5.2 makes Research read-only. Connectors can reach Ba's accounts, and a REPL runs code. Today a prompt-only allowlist is all that separates a job page from either.
- **Acceptance:**
  - Browser bots get `--disable apps`, `-c mcp_servers.<id>.enabled=false` for every MCP server in Ba's config, and `-c notify=[]`. Plugin-provided servers stay as the spike found: disable the plugin, not its server.
  - The argv test lists the extra flags.
  - One recorded live check that does not drive Chrome: `codex exec` with the browser setup, on Ba's real Codex config as in spike S2, and a prompt that only lists its tools. It shows the Chrome plugin's tools and web search, and nothing from connectors, `node_repl` or other servers.
  - If the Chrome plugin turns out to need `node_repl`, stop and report it: that becomes part of owner decision E1.

### M4. Fetched and bot-made content in the trusted task JSON (§10.2 rule 4)
- **What:** `UNTRUSTED_INPUT_FIELDS` misses fields that come from web pages, employer forms or other bots (probe P6):
  - apply.submit: `jobUrl`, `answers`, `savedAnswers` (their labels come from employer forms, and "remember this answer" carries one employer's label into every later Apply);
  - cv.tailor: `fixes` (QA output derived from the JD);
  - research.file: `filename`.
- **Where:** `apps/orchestrator/src/runner/prompt.ts` l.43–51.
- **Why:** rule 4 wraps all fetched content. A planted saved-answer label is a persistent injection into every future application.
- **Acceptance:**
  - Those fields go into UNTRUSTED_CONTENT blocks.
  - cv.tailor's intro says QA's fixes are suggestions to apply only where the master facts support them.
  - Prompt snapshots are updated. A test injects an instruction into each field and finds it only inside a block.

### M5. A source waiting for Ba stalls the whole scan and every later scheduled scan
- **What:** the `scan` map waits until every item settles (`workflow.ts` l.187). A source paused for `needs_login` or `captcha` never settles until Ba acts, so the join, dedupe, fit and every per-job branch wait for it. The scheduler counts the unfinished scan phase as overlap (`scheduler.ts` l.81), so later slots are skipped, and no message tells Ba (probe P4).
- **Where:** `engine/workflow.ts` (`advanceMapStep`, `advanceJoinStep`); `engine/scheduler.ts` (`overlaps`).
- **Why:**
  - UC-03 a: "that branch pauses (UC-17); the others continue."
  - §1.2 success 1 (a scheduled scan produces a review card without Ba) fails whenever one source's login expires, and LinkedIn sessions do expire.
- **Acceptance:**
  - The join continues with the settled sources once every other item has settled. A source paused for Ba is listed as `waiting for Ba`, not as a failure.
  - When Ba clicks Done and that scan finishes, its candidates get a follow-up pass in the same run (dedupe → fit → top → branches). If that is too invasive, they are stored as `new` and the next scan offers them (PM S3); the Lead card then says so.
  - A run whose scan phase waits only for Ba does not count as overlap.
  - The UC-17 card is posted (S1).
  - Probe P4 becomes a test: itviec's card appears while linkedin waits, and the next slot fires.

## 3. SHOULD-FIX

F2 does S1–S6 in the M batch: W3a builds on S1–S2, and S3–S6 are small changes in the same files. F3 is a second fixer that runs in parallel with Phase 3, owns the runner/bridge/engine items below, and must merge before W4b's dry run.

| # | Owner | Item | Why / acceptance |
|---|---|---|---|
| S1 | F2 | **Lead messages for engine events** (decision 4). Posted in the transaction of the state change, one per event class, never one per attempt. They cover: the UC-17 card for `needs_login`/`captcha`/`domain_confirm`; one note per wait for `needs_browser`/`needs_figma`; a task or branch that failed for good (§5.5 step 6); UC-03 b "<source> scan failed"; Apply `needs_check`, including after a crash; usage-limit pause and resume; and the run summary when a run's cards are ready or it ends (UC-02, UC-04 a). | Today only "Scheduled scan started", Apply's question cards and the protected-page alert exist (probe P7). Test: one message or card per class, and none repeated for a retry. |
| S2 | F2 | **Engine seams W3a needs:**<br>• `Engine.enqueueConversation({ bot, kind: chat\|consult\|discussion, input })`: validates the strict prompt schema, uses the effective engine, holds under a usage pause. Plus a `ConversationSink` port that the settle transaction calls with the output, so W3a posts replies and handoffs atomically.<br>• Shared `LeadChatInputSchema` (ConversationInput + `handoff: {fromBot, request} \| null`), with `history` and `handoff` untrusted in `prompt.ts`.<br>• `Engine.confirmInjection(jobId)` with an audited shared event (today `clearJobInjection` writes no event).<br>• `ApproveRequestSchema.dryRun?` (additive), and `ApproveResponseSchema.applicationId` nullable (the W2a handoff; the engine returns null for no apply link). | Without these, W3a would create tasks with raw `createTask` (as the tests do), bypassing validation and holds, and would process results after commit. |
| S3 | F2 | **Site-guard blocks are not retried** (decision 6): a Chrome site-guard denial fails the task with no retry, and is logged and reported (S1). | Spec §10.2 rule 7. Apply's `domain_confirm` stays a pause, and Figma-guard blocks keep their one retry. |
| S4 | F2 | **Persist the Figma "before" hash before every CV spawn** and compare it on the next spawn and at recovery. A mismatch → `protected_page_changed` + Lead alert. | Probe P5. Today only the `needs_figma` path keeps it. |
| S5 | F2 | **Runtime memory out of git:** gitignore `bots/*/memory.md` and `bots/*/memory.archive.md`, untrack the empty seeds, and have the runner create the file on its first append. | Ba's lessons would otherwise end up in commits, the same rule as `data/`. The spec path is unchanged. |
| S6 | F2 | **Prompt-version lock:** `bots/prompt-versions.json` (version + ROLE.md SHA-256 per bot), plus a test that fails when a ROLE.md changes without a `promptVersion` bump. | Today the stale-ROLE.md refusal only fires on Ba's machine at start-up (decision 8). |
| S7 | F3 | **Screenshot capture** (decision 1b): the runner writes each image block from Apply's tool results to `data/screenshots/<task>-<attempt>/<n>.png`, with a manifest (tool_use id, screenshot id, time), and returns it in `RunnerResult` (additive). The transcript keeps a file reference instead of base64 (410 KB per shot today). A PreToolUse rule refuses `computer` with `save_to_disk: true`. Apply names its screenshots by the id the tool showed; the engine copies the named ones into `data/applications/<id>/`, and M1's checks apply. | §1.2 success 2, UC-11 steps 5–8, §12. Capture the exact stream-json shape once live (screenshot of a page on `127.0.0.1`) and commit it as a fixture. Test: two screenshots → two files, the record cites only copies, and the transcript has no base64. |
| S8 | F3 | **§5.3 automatic demotion** (decision 2), including a Ba-made Figma change not counting as a bot violation (Lead copy: "changed during a CV task, by the bot or by you"; a "that was me" retry). | Spec §5.3. Test per trigger and per non-trigger. |
| S9 | F3 | **Fingerprint the visual properties:** fills, strokes, effects, opacity, fontName/fontSize/lineHeight/letterSpacing, style ids, layout fields, rotation, cornerRadius, description/componentProperties. | The guard misses ids built at run time, and the diff then reports "unchanged" after `n.fills=[]` on a template, which every later CV clones. Test: each property change is reported. |
| S10 | F3 | **Apply URL post-check:** `finalUrl`, and every page URL seen in Apply's tool results, must be on the approval's domains; otherwise `needs_check` + `safety.denied(off_allowlist)`. | A click that leaves the domain is not a `navigate` call (decision 10c). This catches it after the fact. |
| S11 | F3 + W4c | **Bots that read pages can flag an injection:** additive `injectionSuspected` (+ note) in ApplyOutput and ResearchScanOutput. Apply → `needs_check` + safety event; Research → the job is flagged (UC-07 b path). | §10.2 rule 4 says bots report attempts, but only QA has a field for it. |
| S12 | F3 | **Figma `knownTools`:** the pinned figma-console-mcp tool list (121 tools), so CV sees only its 3 tools. | Decision 10b. Test: the CV argv disallows the other 118. |
| S13 | F3 | **`copyFileVerified` refuses to follow a destination symlink:** remove, then copy with `COPYFILE_EXCL` or temp + rename. | Low: no bot can create links today. |
| S14 | F3 + W3c | **Memory-note hygiene:** drop notes naming hosts outside the bot's allowlist or phrased as overrides. W3c shows memory with delete on the Bots screen. | A poisoned note reaches every later prompt of that bot. |
| S15 | F3 + W3b | **Dry run → live:** a dry run that reported `submitted` counts as "already applied" until Ba settles it. After a settled dry run, the same card can be approved live (new token, same CV version). | Today a new apply-to-link run would retailor the CV, and a "submitted" dry run does not block a second application (§12 dry-run acceptance, pm-phase-1 FYI e). |
| S16 | F3 | **Company step:** a re-run bypasses the 30-day cache, and a company task that fails twice continues the branch with `company: null`, with the card flagged. | Low. Today the re-run is a no-op, and one failed company task drops a good job. |
| S17 | W3a | **Orchestrator MCP server:** all six tools (including `message_user` and `propose_workflow`). Each Lead spawn gets its own capability (a secret in the URL or a header) that maps to the caller (`LeadCaller`). `createRunners({ mcpServers: { orchestrator: { url, knownTools } } })`. Start-up refuses without it. | Today every `lead.chat` fails with RunnerConfigError, and a static URL cannot tell callers apart. |
| S18 | W3a | **API safety:** Host and Origin checks (DNS rebinding), JSON-only bodies, no CORS, and CSRF protection on every state-changing route (approve, answer, resume, confirm-injection, run control, bot update). Never return token values (`mappers.toSubmissionRecord().approvalToken`, `toApprovalToken`). Serve files by id only, resolved inside `data/`. List endpoints skip bad rows. | The approve route is Ba's human gate, and bots browse untrusted pages in Ba's own Chrome. Test: a cross-origin form POST and a request with a foreign `Host` are refused. |
| S19 | W3a | **Degraded start** (decision 8): if `engine.start()` throws, HTTP and SSE still serve, the engine stays stopped, and `/health` returns `{ ok: false, reason, detail }`. Also refuse a data folder whose path has spaces, commas or parentheses. | Covers `prompt_version_stale`, the schema guard and the read-dir rule. The UI shows the reason instead of "orchestrator unreachable". |
| S20 | W3a | **Chat flows on S2's seam:**<br>• the Lead chat;<br>• consult threads (UC-25 a: "Handed over from @Bot: …" in the Lead chat, a `lead.chat` task, an "Open Lead chat" card);<br>• room mentions (UC-15);<br>• uploads by id (UC-24);<br>• the macOS notification for UC-02's summary. | Decisions 4 and 9. |
| S21 | W3a | **Bot update API:** refuses Apply and CV on Codex (`checkBotSafety`) and Apply at L2 (S10 of Phase 1). It allows restoring a demoted bot one level, Apply up to L1 only. | Decision 7; S8. |
| S22 | W3a | **`workflows/*.yaml`:** the three shared fixtures (job-scan, apply-to-link, apply-to-file), each validated by `WorkflowDefinitionSchema`, behind a versioned `WorkflowSource`. Workflows Ba approves from `propose_workflow` go to the `workflows` table (rule 3). | `workflows/` is empty, so the production engine has no workflow. |
| S23 | W3a | **Schedules:** recompute `nextRunAt` on create and edit (`computeNextRunAt`), soft-delete + restore + purge, and call `engine.bus.flush()` after the API's own event writes. | The bus only delivers what it tails. |
| S24 | W3b | **Chat and review states:**<br>• the UC-17 pause card with Done and the UC-12 question card (Skip, Negotiable, "remember");<br>• question cards turn inert when their task ends;<br>• the review flags: an injection "confirm" button, `masterChanged`, `noApplyLink`, low-confidence company;<br>• an optional intro field, empty meaning Apply writes one;<br>• "approve again" after a denied or expired token, dry-run labels, and Phase 1's S8 pause banner.<br>Copy for an off-site domain: "Apply tried to open <host>, which is not the employer's job site. Allow it for this application?" | M2's confirm is only as good as its copy. |
| S25 | W3c | **Other screens:**<br>• Bots: Apply and CV engine switches disabled with the reason; Apply's promote disabled; restore after demotion; the Research residual-risk note (until E1); memory view with delete.<br>• Applications: `needs_check` highlighted, dry-run label, "not captured" for a missing screenshot.<br>• Record panel: approval time, CV version and sites, never the token. | Decisions 1, 2 and 7. |
| S26 | W4a | **Adapters:** define how they run (skill docs the bot reads, plus a code-level checker on scan output that does the layout-change detection). For UC-03 b's screenshot, use S7's pipeline on Claude; on Codex record "not captured" plus the page URL. | §12 source adapters. The runtime link between the bot and `src/adapters/**` is undefined today. |
| S27 | W4b | **Live prerequisites, in the dry-run runbook (`docs/runbook.md`):**<br>• the S7 capture shape;<br>• Codex Chrome works after M3;<br>• the Claude in Chrome extension's site permissions in headless mode (decision 10c);<br>• leftover tabs (decision 5).<br>Plus the §12 e2e rows. | §12 dry-run acceptance. |
| S28 | W4c | **ROLE.md:**<br>• Apply names screenshots the S7 way;<br>• every browser bot closes its tabs, including the group's empty New Tab;<br>• bots report injections (S11);<br>• bump `promptVersion` with each ROLE.md change and update the lock (S6). | Decisions 1, 5 and 8. |

## 4. Decisions on the QA open items

1. **Apply screenshots never reach disk (QA: high).**
   - **Decision:** two parts.
     - (a) M1 now (F2): the record never cites a path the bot names. This blocks Phase 3, because W3a's file serving and export are built on these columns.
     - (b) S7 (F3, parallel with Phase 3): the runner turns screenshot image blocks into files and the engine copies the named ones into the application folder. This blocks W4b's dry-run acceptance and any live submission, but not Phase 3.
   - **Why the runner:** stream-json already carries the image bytes (they land in the transcript as base64). The current Claude in Chrome `computer` tool also has a `save_to_disk` option, but it writes outside `data/` and returns a path the model would repeat. The runner is the only party that sees the bytes and is not a model. S7 blocks `save_to_disk`.
   - **JD page screenshot:** Chrome screenshots are viewport-only. Following pm-phase-1's fallback, the JD text is the full content, and the record cites a screenshot of the top of the page.

2. **§5.3 automatic demotion.**
   - **Decision:** implement it (S8, F3), with these triggers:
     - **Safety violation:** a violation by the bot's own conduct during a task:
       - a site-guard block the bot did not turn into a `domain_confirm` pause;
       - a Figma-guard block;
       - a protected-page change attributable to the task;
       - `page_mismatch`;
       - `dry_run_submitted`;
       - a runtime permission denial (`trust_level`).
     - **Hard fail:** a CV version that leaves the QA gate escalated with hard fails still present. Hard fails the loop fixes only reset the promotion streak, because the loop exists to catch them.
     - **Not triggers:** the orchestrator's own refusals before a spawn (token, SHA-256, injection flag, bot disabled).
   - **Effect:**
     - one level down (minimum L0), stored on `bots.trust_level`;
     - a `bot.updated` event;
     - a Lead message with the reason;
     - Ba restores the level on the Bots screen (S21, S25).
   - **In Phase 1** only Apply's L1 → L0 changes behaviour: every Apply task is refused until Ba restores it. That is the point. If Ba approved five cards and the first Apply misbehaved, the other four do not run.
   - Proposed §5.3 wording is in section 6.

3. **UC-02 a refinement** (only a still-scanning or paused run blocks the next fire).
   - **Decision:** accepted.
   - **Why:** under the literal rule, any card waiting for review would stop every later scheduled scan until Ba reviews it. Dedupe keeps the next scan from re-selecting the same jobs.
   - M5 fixes the one case where the refined rule still stalls: a source waiting for a login.
   - Owner FYI (section 5): cards can pile up if Ba does not review. The spec wording stays until the owner confirms (proposal in section 6).

4. **Lead messages for engine events have no owner.**
   - **Decision:** split by origin.
     - **Engine events → F2 (S1),** posted in the same transaction as the state change, so a crash cannot lose them. The engine already does this for three messages. This covers:
       - the UC-17 pause cards;
       - failed-task reports;
       - adapter-broken;
       - Apply `needs_check`;
       - usage pauses;
       - the run summary.
     - **Chat-originated flows → W3a (S20),** through S2's conversation seam:
       - Lead's replies and delegation trace;
       - consult and room replies;
       - UC-25 a handoffs.
     - **W3a also:** the macOS notification, sent by the server when a run's summary message appears.

5. **Tab-group cleanup** (§4.4).
   - **Decision:** no separate cleanup session. It would cost a CLI call per task and drive Chrome outside the task and its lock.
   - W4c's ROLE.md has every browser bot close all its tabs, including the empty New Tab of its group, with `tabs_close_mcp` before handing in.
   - W4b checks live during the dry run. Anything left over is listed in the runbook for Ba.
   - Proposed §4.4 wording is in section 6.

6. **Site-guard denials retried once vs "stops the task".**
   - **Decision:** follow the spec. A Chrome site-guard block fails the task without a retry, is logged and is reported (S3). The task ends when the session ends; the session is not stopped mid-call.
   - **Exceptions:**
     - Apply's `domain_confirm` (UC-11 e) stays a pause, now offered only for the host the guard actually blocked (M2).
     - Figma-guard blocks keep their one retry. The block prevented the change, the fingerprint is the backstop, and §6.2 does not say a block ends the task.
   - Only Claude browser bots are affected: Apply, which is never retried anyway, and Research if Ba moves it to Claude (E1).

7. **Figma bots must run on Claude.**
   - **Decision:** confirmed. §6.2 requires a PreToolUse hook on `figma_execute`, and hooks exist only on Claude (§4.4). This is the same reasoning the owner approved for Apply.
   - W3c disables CV's engine switch with the reason "CV edits Figma; its Drafts-only guard runs only on Claude". W3a's bot update API refuses the switch (S21).
   - The spec wording is aligned (section 6).

8. **Start-up refuses a stale ROLE.md.**
   - **UX for W3a (S19):** degraded start, with the reason in `/health` and the UI. The banner text is in W3b's shell: "bots/<name>/ROLE.md changed without a version bump. Bump promptVersion in bots/<name>/bot.json, then restart."
   - **Process for W4c (S28):** bump `promptVersion` in the same commit as every ROLE.md change. S6's lock test makes CI fail otherwise, so the refusal never reaches Ba's machine.

9. **W3a handoffs** (qa-phase-2 §6.10).
   - **Orchestrator MCP server:** `createRunners` gets the orchestrator MCP server, with a per-spawn capability and its `knownTools` (S17).
   - **Strict consult and discussion inputs:** W3a builds them only through `Engine.enqueueConversation` (S2), which validates them before anything is queued.
   - **`lead.chat` input schema:** F2 adds `LeadChatInputSchema` with untrusted `history` and `handoff` (S2). W3a fills it.
   - **Consult result processing:** through the `ConversationSink` port (S2, S20).
   - **Data folder path:** `data/` at the repo root (§4.3), checked at start-up (S19). Never `~/Library/Application Support`.

10. **Residual risks.**
    - (a) **Codex Research.** Its allowlist is prompt-only, its read-only sandbox can read the whole disk, and it runs shell commands. Even after M3, `cua_repl` gives it scripted control of Ba's Chrome with web search on. A job page that injects instructions could make it read local files and send them out through a navigation or a search query. **Owner escalation E1.**
    - (b) **No Figma `knownTools` list.** Accepted as low: `--allowedTools` plus the guard already stop the other tools. S12 hides them anyway.
    - (c) **New, from this review: click navigation is unguarded.** Apply's domain lock (§10.2 rule 2) covers `navigate`, not a click that takes the tab elsewhere. The spec's remaining layer is the extension's own site permissions (§10.2 rule 7).
      - W4b checks live how the Claude in Chrome extension enforces them headless (S27).
      - S10 adds an after-the-fact URL check.
      - The ROLE.md tells Apply to pause on any site change.
      - Owner FYI.

## 5. Owner escalations

**E1. Research's engine (decide before the first live scan in Phase 4; it does not block Phase 3).**
- **The risk:** Research reads untrusted job pages. On Codex its confinement is only the prompt:
  - its read-only sandbox reads any file on the Mac;
  - it runs shell commands;
  - its Chrome plugin is a scripting REPL with no site guard;
  - web search is live.

  After M3 its connectors and other MCP servers are gone, but a successful injection could still read, for example, `~/.codex/auth.json` and send it out through a navigation or a search query. If the Chrome plugin turns out to need `node_repl` (it ships in ChatGPT's `cua_node` folder), M3 cannot remove that REPL either. When the spec chose Codex for Research, it considered the prompt-only allowlist (spike S2), but not the full-disk read or the scripting REPL.
- **Option A (recommended): Research on Claude.**
  - Read is limited to its task folder, there is no shell, and the site guard covers `navigate`.
  - Chrome tools are read-only.
  - QA stays on Codex, so CV and QA still use different engines.
  - Cost: Research's scans, fit scores and company profiles share Claude's 2-session cap with CV, Apply and Lead, and use Claude subscription quota.
- **Option B: stay on Codex and accept the risk, with extra confinement.**
  - The orchestrator puts the master CV and the upload's text into the prompt.
  - It looks for a Codex switch that removes the shell tool (live check).
  - The Bots screen states the risk.
- **Option C: accept the risk as specified today.**

**FYIs (no decision needed unless you disagree):**
- **(a) UC-02 a:** a scheduled scan now runs while earlier cards wait for review (decision 3). If you would rather scans stop while, say, 10 or more cards wait, we add that setting.
- **(b) Demotion:** in Phase 1 it effectively pauses Apply after a safety violation until you restore it on the Bots screen (decision 2).
- **(c) Domain lock:** it covers navigation commands, not clicks. The extension's site permissions are the second layer and will be checked live before the dry run (decision 10c).
- **(d) Apply's self-check:** Apply runs as one session, so its "self-check before submit" is reported after the submit. The orchestrator can only send a failed item to `needs_check`; the dry run is the real check.
- **(e) Intro text:** no bot drafts the card's intro. If you leave it empty, Apply writes one from the master CV and records it, which matches the prototype. The card gets an optional intro field for UC-08 b.

## 6. Spec wording fixes

**Applied in this commit** (aligns the spec with decisions the owner already approved):
1. **§6.2 Write boundary:** CV runs on Claude, because the Drafts-only hook exists only there (§4.4: Codex has no hooks). The Bots screen keeps CV's engine switch disabled. This follows from the approved §4.4 and §6.2 text and mirrors Apply.

**Proposed, not applied** (they change the letter of a rule, so they need the owner's OK):
- **§7.4 and UC-02 a:** "A schedule never starts while its previous run is still scanning (a run-level step unfinished, other than a source waiting for Ba) or is paused; per-job branches waiting for Ba's review do not block the next scan."
- **§5.3 Demotion:** "automatic, back one level, on a safety violation by the bot (a guard block it did not turn into a pause, a protected-page change caused by its task, a page mismatch, a dry run that submitted, a tool outside its permissions) or, for CV, a version that leaves the QA gate with hard fails. Hard fails the QA loop fixes only reset the promotion streak."
- **§4.4 Isolation:** "Before handing in, the bot closes every tab it opened, including the empty tab of its group; Ba closes any that remain."
- **§10.2 rule 7:** "any navigation outside the list is blocked, fails the task without a retry and logs a safety event."
- **Still open from Phase 1:**
  - §5.5 step 6, the Apply exception;
  - §5.1, the Research `outputSchema` map;
  - UC-13b, where the auto-export control lives.
- **§9 `runs`:** the extra columns (`search_profile_version`, `search_profile_id`, `schedule_id`, `error`).

## 7. Briefing for the Phase 3 workers

### All workers
- **Checks:** run them with `--force` (the Turbo cache is shared across worktrees) and run e2e on your own `E2E_PORT`. Never call real CLIs, Chrome or Figma in tests.
- **Engine test kit:** `createTestEngine()` from `apps/orchestrator/src/engine/testing`. It includes:
  - FakeRunner scripts, for example `t.runner.script({ bot: "apply", kind: "submit", result: fake.applyPaused({ questions }) })`;
  - FakeClock (`t.clock.advance`);
  - fake Chrome, Figma and files;
  - `t.idle()`, which also checks the event invariants.
- **Safety:** treat everything a bot returns as untrusted: paths, sites, labels and URLs.

### W3a: API, SSE, MCP server, workflows
- **Build:**
  - `createProductionEngine({ db, dataDir, botsDir, runners: createRunners({ mcpServers: { orchestrator: … } }), workflows })`, then `await engine.start()` (it returns a `StartReport`).
  - If start throws, serve in degraded mode (S19).
  - Shut down with `engine.stop()` and `await engine.idle()`.
- **Engine API** (`src/engine/index.ts`). Every write goes through these, so events and audit rows are written:

  | Action | Call |
  |---|---|
  | Runs | `startWorkflow(input, { trigger, scheduleId? })` → Run; `pauseRun`, `resumeRun`, `cancelRun` (returns the aborted task ids), `rerunStep` |
  | Review | `approve(jobId, { cvVersionId, introText, dryRun? })` → `{ applicationId \| null, taskId, approval: { expiresAt, allowedDomains } \| null, reapproval }`; `requestChanges(jobId, comment)`; `skip(jobId, { reason, note })` |
  | Pauses | `answerQuestion(taskId, { field, mode: "answer" \| "skip" \| "negotiable", value, remember })` → `{ resumed, next }`; `resumeTask(taskId, { confirmDomain? })` |
  | Schedules | `runScheduleNow(id)` → `{ started, runId }` or `{ started: false, reason: "overlap" }` |
  | Lead's tools | `engine.lead.createTask / startWorkflow / getStatus / getResult(caller, raw)`, where `caller` is `{ botName, mode }` from the MCP capability (S17). Apply questions are answered only by Ba, never by Lead. |
  | After F2 | `enqueueConversation`, `confirmInjection`, the `ConversationSink` port |

  Reads (lists, details, the record panel) use the db repositories and `mappers` directly.
- **SSE:**
  - `engine.subscribe(listener)` for live events.
  - On reconnect, `engine.replay(lastEventId)`; the `events.id` is the SSE `id:`. Audit-only rows (`runner.spawned`) never stream.
  - When the API writes events itself (bot, schedule, master CV and upload changes), use `appendAppEvent`, then `engine.bus.flush()`.
- **Event types:**
  - `run.*`, `step.*`, `task.started/progress/paused/resumed/finished`;
  - `engine.paused/resumed/usage`;
  - `review.ready`, `application.updated`;
  - `message.created/delta`;
  - `bot.updated`, `schedule.fired/skipped`, `bridge.status`;
  - `safety.denied`, `export.ready`.

  The engine emits none of `bot.updated`, `message.delta` or `export.ready`; those are yours.
- **Errors:** `EngineError.code` is the shared `ApiErrorCode`.

  | Code | HTTP | Raised for |
  |---|---|---|
  | `validation_failed` | 400 | |
  | `not_found` | 404 | |
  | `conflict` | 409 | `details.reason`: `master_cv_missing`, `no_search_profile`, `prompt_version_stale` and `ApprovalRefusedError` reasons |
  | `forbidden` | 403 | injection not confirmed; Apply or record re-run; Lead outside the Lead chat |
  | `already_applied` | 409 | |
  | `internal` | 500 | |
- **Pitfalls:**
  - **Bot output is untrusted.** The record's screenshot columns hold only orchestrator files after M1; still resolve every stored path inside `data/` before serving.
  - **Tokens:** never send `approvalToken` values to the UI (S18). `approvalStatus()` in `engine/review.ts` gives expiry and domains only; F2 exports it from the engine index with S2.
  - **Schedules:** a schedule edit must reset `nextRunAt`; the scheduler only fills it when it is null.
  - **Bots:** a queued task keeps the engine it was queued on. Engine-switch checks happen at the API (S21) and again at spawn.
  - **Locks** live in memory. Never run two engines on one database.
  - **Data folder:** its path must not contain spaces, commas or parentheses (the runner's read-dir rule).
  - **Workflow YAML:** keep the step keys and templates of the shared fixtures, because the engine tests run on them. Workflow kinds are validated: `apply.submit` only in an `action` step.

### W3b: chat, flows, review, `lib/api`
- **Chat cards:** cards come in `message.created` events; `meta.cards` uses the shared card types (`run`, `review_link`, `job`, `question`, `fact_request`, `choice`, `handoff`, `delegation`, `pause`).
  - A question card stays live only while its task is `paused` with `needs_answer`.
  - A pause card's Done calls `/tasks/:id/resume`. A `domain_confirm` card sends `confirmDomain` and shows the host prominently, using S24's copy.
- **Flow canvas:**
  - `step.*` events with `branchKey`: per-language gates use `<jobId>:<lang>`.
  - `step.updated.counts` drives the stacked map node.
  - The action node starts `locked`. "approve again" is `locked` with `preview: "approve again"`.
  - Run status: `waiting` means it waits only for Ba, a bridge or a limit.
- **Review card:** `review.ready` carries the flags. After a denied or expired token, Approve issues a new token for the same application, and the response has `reapproval: true`.

### W3c: other screens
- **Bots:** engine switches for Apply and CV are disabled with the reason. Apply's promote is disabled. Show the Research residual-risk note.
- **Applications:**
  - Status changes go through the shared transition table with `"manual"`.
  - `needs_check` → `submitted` is allowed only for real (non-dry-run) applications.
  - Dry runs are labelled.
  - A missing screenshot shows "not captured".
- **Schedules:** "Run now" can answer `overlap`; show it as a toast.

## 8. Notes for Phase 4 (short)
- **W4a:** settle the adapter runtime first (S26). Research's `skill:source-*` maps to `Read(./skills/…)` on Claude; on Codex the skills are prompt-only, because Codex reads through its sandbox.
- **W4b:** do the live prerequisites (S27) before the dry run, and run the dry run on a job Ba wants to apply to anyway (pm-phase-1 FYI e). It needs S7, S15 and M1–M5 merged.
- **W4c:** `data.example/master-cv.yaml` does not exist yet. The ROLE.md items are in S28, and every change needs a `promptVersion` bump plus the S6 lock update.
