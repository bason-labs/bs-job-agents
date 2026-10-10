# Technical spikes S1–S4: findings (2026-10-10)

All spike code was throwaway and lived in the session scratchpad. Nothing was submitted anywhere. Versions tested: Claude Code `2.1.296`; Codex CLI `0.162.0-alpha.17.2` (bundled with ChatGPT.app).

| Spike | Result |
|---|---|
| S1 CLI flags, tools, MCP, JSON, usage limits | ✅ Works on both engines (details below) |
| S2 Drive Ba's real Chrome headlessly | ✅ Claude and Codex both work; Claude also uploaded a local PDF (SHA-256 matched) |
| S3 Figma from a headless session | ❌ Figma's hosted MCP is capped on the Starter plan → ✅ **S3b: local bridge works** (owner chose option A) |
| S4 `codex exec --output-schema` | ✅ Works; the schema must be in OpenAI "strict" form |

---

## S1: Claude runner

**Verified command** (cwd `bots/<name>/`):

```
claude -p "<prompt>" \
  --output-format stream-json --verbose \
  --setting-sources "" --disable-slash-commands \
  --tools "<built-ins, e.g. Read or ''>" \
  --allowedTools <tool patterns...> \
  --mcp-config bots/<name>/mcp.json --strict-mcp-config \
  --settings '<json: hooks, e.g. the site guard>' \
  --json-schema '<strict JSON Schema>' \
  --no-session-persistence --permission-prompts none \
  --model <alias> [--chrome] [--add-dir <dir>] < /dev/null
```

| Finding | Consequence for the build |
|---|---|
| `--setting-sources ""` drops Ba's personal plugins, hooks, CLAUDE.md and auto mode (`permissionMode` becomes `default`). `--settings` and `--mcp-config` still apply. | Bots are isolated from Ba's own setup. |
| `--bare` is **not usable**: it accepts only `ANTHROPIC_API_KEY` or an apiKeyHelper. `--safe-mode` is **not usable**: it also drops `--mcp-config` servers. | Use `--setting-sources ""` instead. |
| `--tools` limits the built-in tools (verified: only `Read` and `StructuredOutput` appeared). `--allowedTools` decides what runs without asking. With `--permission-prompts none`, anything else is **auto-denied** and listed in `result.permission_denials[]`. | The trust guard maps directly: L0 = tool not allowed → denial → Lead asks Ba. |
| `permission_denials[]` **also lists tool calls that simply errored** (a `get_page_text` call on a page that had not loaded yet was listed). | The runner checks the matching `tool_result.is_error` text before treating an entry as a real permission denial. |
| `--json-schema` makes the model call a `StructuredOutput` tool. `result.structured_output` holds the validated object. | Skip the "parse last message" step; repair prompt only if missing. |
| Per-bot MCP via `--mcp-config <file> --strict-mcp-config` works (`mcp_servers[].status: "connected"`). | One `mcp.json` per bot. |
| Without `< /dev/null`, `-p` waits 3 s for stdin and prints a warning. | The runner always closes stdin. |
| Stream events: `system/init` (tools, MCP status, model), `assistant` (tool_use), `user` (tool_result), `rate_limit_event`, `result` (`structured_output`, `is_error`, `num_turns`, `duration_ms`, `usage`). | Transcript + `task.progress` events come straight from these. |
| **Usage:** every run emits `rate_limit_event.rate_limit_info` with `status` (`allowed`), `resetsAt` (epoch s), `rateLimitType`, and `unifiedWindows.five_hour/seven_day.utilization` (0–1). | Usage-limit watcher can pause **before** hitting the wall (e.g. at ≥ 0.95) and resume at `resetsAt`, and the sidebar usage meter gets real numbers. The exact payload when `status` is not `allowed` was not observed (we would have to exhaust the limit); treat `status != "allowed"` or a limit error in `result` as limited and wait for `resetsAt`. |
| Speed: a small read + structured output took about 7 s. | |

## S1: Codex runner

**Verified command, non-browser bots** (cwd `bots/<name>/`):

```
/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex exec \
  --json --ephemeral --skip-git-repo-check --ignore-user-config \
  --sandbox read-only|workspace-write \
  --output-schema bots/<name>/schema.json -o <taskdir>/last.json \
  -c 'mcp_servers.<srv>.command="..."' -c 'mcp_servers.<srv>.args=[...]' \
  -c 'mcp_servers.<srv>.default_tools_approval_mode="approve"' \
  "<prompt>" < /dev/null
```

| Finding | Consequence |
|---|---|
| `--ignore-user-config` keeps the ChatGPT login but drops Ba's plugins and skills. | Clean bot sessions for QA. |
| MCP tool calls **fail** in `exec` unless approval is configured: "required approval, but approval is disabled". `default_tools_approval_mode="approve"` fixes it (`enabled_tools` / `disabled_tools` also exist per server). | Per-bot MCP allowlist goes in these `-c` keys. |
| `--sandbox read-only` blocked a file write, as expected. | QA runs read-only. |
| JSONL events: `thread.started`, `turn.started`, `item.started/completed` (`agent_message`, `command_execution`, `mcp_tool_call` with `server`, `tool`, `status`, `result`), `turn.completed` (`usage`), `error`, `turn.failed`. | Transcript mapping. |
| No rate-limit info appears in `exec --json`. The binary contains `usage_limit_reached` / `resets_at`, so a limit arrives as an `error` / `turn.failed` message. Not observed. | Watcher parses `turn.failed` for `usage_limit_reached` and `resets_at`; if not parseable, retry every 30 min (already in UC-16). |
| `-c mcp_servers.X.enabled=false` for a plugin-provided server makes config loading **fail** ("invalid transport"). | Disable plugins, not their servers. |

## S4: Codex structured output

- `--output-schema <file>` works, and `-o <file>` writes the final JSON.
- The schema must be in **strict** form: every object needs `"additionalProperties": false` and must list **all** properties in `required` (optional = nullable type).
- A non-strict schema fails immediately: `400 invalid_json_schema`, `turn.failed`, exit code 1.
- **Consequence:** one shared Zod → strict JSON Schema converter in `packages/shared`, used by both engines. Claude's `--json-schema` accepts the strict form too.

---

## S2: Ba's real Chrome

### Claude in Chrome (`claude -p --chrome`)
- **Works headlessly.** Reading the first 3 TopCV listings took about 31 s (10 turns).
- Tools: `mcp__claude-in-chrome__*` (`navigate`, `get_page_text`, `read_page`, `find`, `computer`, `form_input`, `file_upload`, `javascript_tool`, `tabs_*`, …).
- **Tab isolation:** every session gets its own **tab group** (`tabGroupId` returned). The bot closed its tab, but each run leaves one empty "New Tab" in its group. The runner adds a cleanup step.
- No site-permission prompts appeared.
- **Site allowlist: verified, enforced in code.** A `PreToolUse` hook passed through `--settings` on `mcp__claude-in-chrome__navigate` blocked `example.com` with our message, and allowed `127.0.0.1`.
  - Do not match `tabs_create_mcp`: it opens a blank tab with no URL, and blocking it stops the bot.
  - Residual risk: `javascript_tool` can change `location`. **Apply** therefore runs without `javascript_tool`, and the hook also checks `javascript_tool` code for navigation.
- **File upload of a local PDF: verified.** The page computed the same SHA-256 as the local file (`d5707075…c33a`). This needs **both**:
  - `--add-dir <pdf dir>`
  - the `Read` tool enabled, with `Read(<pdf dir>/**)` in `--allowedTools`

  Without both: "only files this session is allowed to read can be uploaded". This fits the trust rule: Apply can read only the approved PDF's folder.

### ChatGPT for Chrome (Codex)
- **Works headlessly** through the `cua_repl` MCP server, e.g. `cua.createBrowserTab('chrome', url, {sessionName})`, which opens a named tab group. Reading the same listing took 21–37 s.
- It **needs Ba's user config**, because the `chrome@openai-bundled` plugin is configured there. With `--ignore-user-config`, no Chrome tool is available.
- Isolation that works:
  - `-c 'plugins."<id>".enabled=false'` for every other plugin
  - `--enable skip_host_skill_discovery --disable skill_search`

  Without these, the bot read Ba's personal skills and used 228k input tokens. With them it used 120k.

  `skip_host_skill_discovery` is marked *under development* and emits a warning `error` item. The runner ignores that warning.
- **No hook mechanism was verified for Codex**, so the site allowlist is enforced only by the prompt and the role.
  - **Recommendation:** browser bots that **write** (Apply) stay on Claude, where the allowlist is enforced in code (as the spec already says).
  - Research (read-only) can stay on Codex. The residual risk is noted in the bot settings UI.

---

## S3: Figma: blocked

- **What happened:** the first read-only call (`get_metadata` on file `kJFoXNrTfFOtkQ515c0jHk`) returned: *"You've reached the Figma MCP tool call limit on the Starter plan."* Nothing was duplicated or changed.
- **Why it blocks:** the cap is per Figma account, so Claude's Figma connector hits the same wall. A tailored CV needs dozens of calls per job (duplicate, edit texts, layout, export).
- Your earlier manual flow exported by clicking through Figma's UI in the browser. That works but is slow and fragile; it is not something to automate per job.
- **Figma desktop app:** not installed.

**Options:**

| | Option | Keeps Figma? | Cost | Robustness | Notes |
|---|---|---|---|---|---|
| **A** | **Local bridge plugin.** Install the Figma desktop app plus an open-source bridge plugin (e.g. `figma-console-mcp`, actively maintained, local WebSocket "Desktop Bridge"). The plugin runs Figma plugin code: duplicate frame, set text, `exportAsync({format:'PDF'})`. | Yes | Free | Good, but Figma desktop must be open with the plugin running (like Chrome for the browser bots) | Needs one more spike: install, verify duplicate + edit + PDF export, and check it needs no paid seat or token for these calls |
| **B** | **Paid Figma plan** (Professional + Dev or Full seat) for the official MCP's per-minute limits | Yes | Monthly Figma fee | Good | Keeps the spec as written |
| **C** | **HTML/CSS CV templates rendered to PDF in Chrome.** Templates in the repo, same layout freedom (fonts, columns, order, accent colour), and the same limits (A4, one page, real text). Figma stays a manual design reference. | No (only as a reference) | Free | Best: fast, testable, no app has to be open | QA's one-page check becomes exact (rendered page count) |

**Recommendation:**
- **A** if editing in Figma matters to you, since it keeps your Figma workflow at no cost.
- Otherwise **C**, which is the simplest and most reliable.
- Either way, the CV bot's contract (input: job + company + master data; output: PDF + frame/template name + change notes) stays the same.

---

## S3b: local Figma bridge (option A, chosen by Ba)

**Setup:**
- Figma desktop
- `figma-console-mcp@1.40.9` (MIT), run locally over stdio
- its Desktop Bridge plugin, imported once from `~/.figma-console-mcp/plugin/manifest.json`
- no Figma token, no cloud pairing

| Check | Result |
|---|---|
| Plugin connects | `figma_get_status {probe:true}` succeeded about 3 s after the server started. It reports file name and key. |
| Read pages/frames | Works. The file has pages `resume` (4 sections + 6 A4 CV frames, 595×842) and `components`. There was no `Drafts` page yet. |
| Duplicate + edit + export (script, no LLM) | Cloned "BA HUYNH — Software Engineer Resume \| Refreshed" (`459:1767`) to a new `Drafts` page as `SPIKE_TEST_EN_v1`, appended "[SPIKE EDIT]" to the name text, and exported a PDF via `exportAsync({format:'PDF'})` + `figma.base64Encode`. The whole call took **275 ms**. The PDF: 1.06 MB, PDF 1.7, **1 page, 595×842 (A4)**, real text layer, edit present, renders correctly. |
| Headless bot (`claude -p` + bridge via `--mcp-config`) | Changed the "Professional title" text in the copy via `figma_execute` in **11 s** (5 turns). Only `figma_get_status` and `figma_execute` were allowed. All 122 bridge tools are listed, but only allowed ones run. |
| PDF text quality | macOS PDFKit showed false word splits ("wit h", "per formance", "huynht hienba4"). Your earlier Figma-UI exports show the same splits, so this is not caused by the bridge. **pdfminer and pypdf extract the same PDF perfectly**, so the splits are a PDFKit quirk, not an ATS problem. Checks must use a pdfminer/PDF.js-style extractor. |
| Font swap across the whole CV | **Slow:** restyling 29 text nodes repeatedly hit the 30 s per-call cap (about 4 s per node). Fresh single text boxes in Inter, Arial, Be Vietnam Pro and Roboto exported cleanly. **Consequence:** font changes start from a template variant already in that font; long edits are chunked. |
| Template detail | The profile text has a double space ("engineer  with"). The CV bot's self-check should normalise whitespace. |

**Safety design that follows:**
- `figma_execute` runs arbitrary plugin code, so "Drafts only" is enforced in three ways:
  - the prompt
  - a hook that rejects code referencing other pages
  - an orchestrator before/after **fingerprint** of the protected pages; any change fails the task and alerts Ba
- One Figma task at a time (Figma lock).
- The orchestrator does the PDF export itself, which is deterministic and needs no LLM.

**Left in Ba's file:** page `Drafts` containing `SPIKE_TEST_EN_v1`, for Ba to look at; delete it any time. All other spike copies were removed.

## Spec changes these findings cause

1. §5.5 Runner: exact flags above, `structured_output`, the denial cross-check, closed stdin.
2. §4.4 Browser:
   - the site allowlist is a `PreToolUse` hook for Claude, and prompt-only for Codex
   - upload needs `--add-dir` + scoped `Read`
   - tab-group cleanup step
   - Codex needs user config with other plugins disabled
3. §10/UC-16 Usage limits: proactive pause from Claude's `rate_limit_event` utilization; Codex parses `turn.failed`. The sidebar meter uses real utilization.
4. §12 Testing: a strict-schema test for every output schema.
5. §6.2 / CV bot / §4.2 / UC-17 / §10.3 / §12: local Figma bridge, `needs_figma` wait, Figma lock, orchestrator export, protected-page fingerprint, and the text-extractor rule (done).
