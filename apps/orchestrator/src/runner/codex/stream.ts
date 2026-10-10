// Parser for `codex exec --json` JSONL (spike S1/S4; fixtures in __fixtures__/codex).
// Events: thread.started, turn.started, item.started/updated/completed (agent_message,
// command_execution, mcp_tool_call, web_search, reasoning, error), turn.completed, error,
// turn.failed. Codex reports no rate-limit info; a limit arrives as error / turn.failed.
import type { RunnerEvent } from "../types.js";
import { detectCodexUsageLimit, type CodexLimit } from "../usage.js";
import { clip, summarizeToolInput } from "../text.js";

export interface CodexStreamOptions {
  pid: number | null;
  now: () => Date;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** The warning `--enable skip_host_skill_discovery` emits as an error item (spike S2); not a failure. */
const IGNORED_WARNING = /under-development features enabled/i;
const PROGRESS_MAX = 500;

export class CodexStreamParser {
  private _threadId: string | null = null;
  private _lastMessage: string | null = null;
  private _failure: string | null = null;
  private _lastError: string | null = null;
  private _limit: CodexLimit | null = null;
  private _turnCompleted = false;
  private _tokenUsage: Json | null = null;
  private started = false;

  constructor(private readonly opts: CodexStreamOptions) {}

  get threadId(): string | null {
    return this._threadId;
  }

  /** Text of the last completed agent_message (what `-o` writes). */
  get lastMessage(): string | null {
    return this._lastMessage;
  }

  /** The turn.failed message, else the last error event (null when the turn completed cleanly). */
  get failure(): string | null {
    return this._failure ?? (this._turnCompleted ? null : this._lastError);
  }

  get limit(): CodexLimit | null {
    return this._limit;
  }

  get turnCompleted(): boolean {
    return this._turnCompleted;
  }

  /** turn.completed usage (tokens); informational only. */
  get tokenUsage(): Json | null {
    return this._tokenUsage;
  }

  push(line: string): RunnerEvent[] {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return [];
    let e: unknown;
    try {
      e = JSON.parse(trimmed);
    } catch {
      return [];
    }
    if (!isObj(e)) return [];
    switch (e.type) {
      case "thread.started": {
        this._threadId = str(e.thread_id) ?? this._threadId;
        if (this.started) return [];
        this.started = true;
        return [{ type: "started", engine: "codex", sessionId: this._threadId, pid: this.opts.pid }];
      }
      case "item.started":
      case "item.updated":
      case "item.completed":
        return isObj(e.item) ? this.onItem(e.type, e.item) : [];
      case "turn.completed":
        this._turnCompleted = true;
        this._tokenUsage = isObj(e.usage) ? e.usage : null;
        return [];
      case "turn.failed": {
        const message = isObj(e.error) ? str(e.error.message) : null;
        this._failure = message ?? "turn failed";
        return this.checkLimit(this._failure);
      }
      case "error": {
        const message = str(e.message) ?? "error";
        this._lastError = message;
        return [{ type: "progress", text: clip(`Codex error: ${message}`, PROGRESS_MAX) }, ...this.checkLimit(message)];
      }
      default:
        return [];
    }
  }

  private checkLimit(message: string): RunnerEvent[] {
    if (this._limit) return [];
    const limit = detectCodexUsageLimit(message, this.opts.now());
    if (!limit.limited) return [];
    this._limit = limit;
    return [{ type: "usage", engine: "codex", usage: { fiveHour: null, sevenDay: null, resetsAt: limit.resetsAt }, limited: true }];
  }

  private onItem(phase: string, item: Json): RunnerEvent[] {
    const completed = phase === "item.completed";
    switch (item.type) {
      case "agent_message": {
        if (!completed) return [];
        const text = str(item.text) ?? "";
        this._lastMessage = text;
        // The final message is the structured JSON; only prose is progress.
        return text.trim() && !text.trim().startsWith("{") ? [{ type: "progress", text: clip(text, PROGRESS_MAX) }] : [];
      }
      case "command_execution": {
        if (phase === "item.updated") return [];
        const failed = item.status === "failed" || (typeof item.exit_code === "number" && item.exit_code !== 0);
        const status = !completed ? "started" : failed ? "error" : "done";
        return [{ type: "tool", name: "shell", status, summary: summarizeToolInput(str(item.command)) }];
      }
      case "mcp_tool_call": {
        if (phase === "item.updated") return [];
        const name = `mcp__${str(item.server) ?? "unknown"}__${str(item.tool) ?? "unknown"}`;
        const error = isObj(item.error) ? str(item.error.message) ?? "error" : null;
        const failed = item.status === "failed" || error !== null;
        if (!completed) return [{ type: "tool", name, status: "started", summary: summarizeToolInput(item.arguments) }];
        return [{ type: "tool", name, status: failed ? "error" : "done", summary: failed ? clip(error ?? "failed", 160) : summarizeToolInput(item.arguments) }];
      }
      case "web_search": {
        if (phase === "item.updated") return [];
        const query = str(item.query);
        return [{ type: "tool", name: "web_search", status: completed ? "done" : "started", summary: query ? clip(query, 160) : null }];
      }
      case "file_change": {
        if (!completed) return [];
        const changes = Array.isArray(item.changes) ? item.changes.filter(isObj).map((c) => str(c.path)).filter(Boolean) : [];
        return [{ type: "tool", name: "file_change", status: item.status === "failed" ? "error" : "done", summary: changes.join(", ") || null }];
      }
      case "error": {
        const message = str(item.message) ?? "";
        if (!completed || IGNORED_WARNING.test(message)) return [];
        return [{ type: "progress", text: clip(`Codex warning: ${message}`, PROGRESS_MAX) }];
      }
      default:
        return [];
    }
  }
}
