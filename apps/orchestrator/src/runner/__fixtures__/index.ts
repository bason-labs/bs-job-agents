// CLI output fixtures for the runner's parser tests (PM S7, spec §12 FakeRunner).
//
// Real captures: recorded live on 2026-10-11 from a temp dir outside the repo, stdin closed,
// with the runner's flags. Claude Code 2.1.296 (`--model haiku` = claude-haiku-5-5);
// Codex CLI 0.162.0-alpha.17.2 (`-m gpt-6-luna -c model_reasoning_effort="low"`).
// Redacted: temp paths → /tmp/bsja-live, home → /Users/ba, thinking signatures, long
// search results trimmed. Nothing else was changed.
//
// Synthetic (never observed live; built from the real shapes next to them):
// - claude/usage-limit.synthetic.jsonl: rate_limit_event status "rejected" + the API-error
//   assistant message + result is_error 429 (shape of claude/api-error.jsonl).
// - claude/high-utilization.synthetic.jsonl: structured-ok.jsonl with the 5-hour window at 0.96
//   and status "allowed_warning".
// - codex/usage-limit.synthetic.jsonl: error + turn.failed with the CLI's "You've hit your usage
//   limit … try again at 3:45 PM." text (strings in the 0.162 binary).
// - codex/usage-limit-json.synthetic.jsonl: the same events carrying the API body
//   (type usage_limit_reached, resets_at), shaped like codex/turn-failed.jsonl.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));

export const CAPTURED_WITH = {
  date: "2026-10-11",
  claude: "Claude Code 2.1.296, claude-haiku-5-5",
  codex: "codex-cli 0.162.0-alpha.17.2, gpt-6-luna (reasoning low)",
} as const;

export const CLAUDE_FIXTURES = {
  /** ConsultOutput via StructuredOutput, no tools, no MCP; rate_limit_event status allowed. */
  structuredOk: "claude/structured-ok.jsonl",
  /** Read: outside path denied (system/permission_denied), missing file errors, cwd and --add-dir reads work. */
  permissionDenied: "claude/permission-denied.jsonl",
  /** MCP echo allowed, MCP wipe auto-denied, Read blocked by a PreToolUse hook (decision source "hook"). */
  mcpAndHookDenied: "claude/mcp-and-hook-denied.jsonl",
  /** Schema-valid but Zod-invalid output (reply ""), session persisted with --session-id. */
  invalidOutput: "claude/invalid-output.jsonl",
  /** Repair turn: --resume <id> --no-session-persistence --tools "" in the same session; valid output. */
  repairOk: "claude/repair-ok.jsonl",
  /** --resume after --no-session-persistence: error_during_execution, exit 1 (stderr below). */
  resumeNotFound: "claude/resume-not-found.jsonl",
  /** Read + MCP tool, then Zod-invalid output. */
  toolsInvalidOutput: "claude/tools-invalid-output.jsonl",
  /** Repair of the run above with tools stripped: valid shape, but the model marked its self-check failed. */
  repairSelfCheckFailed: "claude/repair-self-check-failed.jsonl",
  /** Unknown model: API-error assistant message, result is_error, api_error_status 404, exit 1. */
  apiError: "claude/api-error.jsonl",
  /** init only, --chrome --strict-mcp-config --tools "": the 22 Claude in Chrome tools. */
  chromeInit: "claude/chrome-init.jsonl",
  /** init only, as above plus --disallowedTools javascript_tool browser_batch: both hidden. */
  chromeInitDisallowed: "claude/chrome-init-disallowed.jsonl",
  /** SYNTHETIC: subscription limit hit. */
  usageLimit: "claude/usage-limit.synthetic.jsonl",
  /** SYNTHETIC: successful run with the 5-hour window at 0.96. */
  highUtilization: "claude/high-utilization.synthetic.jsonl",
} as const;

export const CODEX_FIXTURES = {
  /** ConsultOutput; first item is the skip_host_skill_discovery warning (type error) the runner ignores. */
  structuredOk: "codex/structured-ok.jsonl",
  /** Two mcp_tool_call items (default_tools_approval_mode="approve"). */
  mcpTools: "codex/mcp-tools.jsonl",
  /** enabled_tools=["echo"]: the other tool is not offered; an interim agent_message. */
  mcpAllowlist: "codex/mcp-allowlist.jsonl",
  /** command_execution item; a second command blocked by the read-only sandbox emitted no item. */
  shell: "codex/shell.jsonl",
  /** web_search item with -c web_search="live". */
  webSearch: "codex/web-search.jsonl",
  /** Without --disable apps, the built-in codex_apps MCP server searched the web although web_search was disabled. */
  appsConnectorSearch: "codex/apps-connector-search.jsonl",
  /** Zod-invalid output (reply ""), non-ephemeral thread. */
  invalidOutput: "codex/invalid-output.jsonl",
  /** Repair turn via `codex exec resume <thread_id>`; same thread id, valid output. */
  repairOk: "codex/repair-ok.jsonl",
  /** Shell + MCP tool, then Zod-invalid output. */
  toolsInvalidOutput: "codex/tools-invalid-output.jsonl",
  /** Repair of the run above with MCP servers and search stripped; valid output. */
  repairAfterTools: "codex/repair-after-tools.jsonl",
  /** Non-strict schema: error + turn.failed (400 invalid_json_schema), exit 1. */
  turnFailed: "codex/turn-failed.jsonl",
  /** SYNTHETIC: usage limit as the CLI's text. */
  usageLimit: "codex/usage-limit.synthetic.jsonl",
  /** SYNTHETIC: usage limit as the API body with resets_at. */
  usageLimitJson: "codex/usage-limit-json.synthetic.jsonl",
} as const;

export type ClaudeFixture = keyof typeof CLAUDE_FIXTURES;
export type CodexFixture = keyof typeof CODEX_FIXTURES;

function readLines(rel: string): string[] {
  return readFileSync(join(DIR, rel), "utf8").split("\n").filter((l) => l.length > 0);
}

export function claudeLines(name: ClaudeFixture): string[] {
  return readLines(CLAUDE_FIXTURES[name]);
}

export function codexLines(name: CodexFixture): string[] {
  return readLines(CODEX_FIXTURES[name]);
}

/** Text of the last completed agent_message: what `codex exec -o <file>` wrote for that run. */
export function codexLastMessage(lines: readonly string[]): string | null {
  let last: string | null = null;
  for (const line of lines) {
    const e = JSON.parse(line) as { type?: string; item?: { type?: string; text?: string } };
    if (e.type === "item.completed" && e.item?.type === "agent_message" && typeof e.item.text === "string") last = e.item.text;
  }
  return last;
}

/** Real stderr lines from the same captures. */
export const STDERR = {
  claudeResumeNotFound: "No conversation found with session ID: bc2cace4-863a-4786-8c6f-175d1727370a",
  claudeUnknownModel: '[claude-code:unrecognized_model] {"model":"claude-nonexistent-model-x","query_source":"sdk"}',
  codexStdinNotice: "Reading additional input from stdin...",
  codexResumeEphemeral:
    "Error: thread/resume: thread/resume failed: no rollout found for thread id 01a126dd-0c64-7ed1-9ceb-3568cca620b6 (code -32600)",
} as const;
