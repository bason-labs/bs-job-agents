// Parser for `claude -p --output-format stream-json --verbose` (spike S1; fixtures in __fixtures__/claude).
// One instance per CLI process. `push(line)` returns the RunnerEvents for that line and keeps
// the state the runner needs afterwards: structured output, result, real denials, limits.
import type { PermissionDenial, RunnerEvent } from "../types.js";
import { isClaudeLimitMessage, readClaudeRateLimit, type ClaudeRateLimitInfo, type UsageReading } from "../usage.js";
import { clip, summarizeToolInput } from "../text.js";

export interface ClaudeResultInfo {
  subtype: string | null;
  isError: boolean;
  numTurns: number | null;
  durationMs: number | null;
  apiErrorStatus: number | null;
  terminalReason: string | null;
  /** `result.result`: the final text (an error message when isError). */
  text: string | null;
  sessionId: string | null;
}

/** A subscription limit seen in this run: the CLI said so, a window is at the threshold, or a limit error. */
export interface ClaudeLimitSignal {
  resetsAt: string | null;
  reason: "status" | "utilization" | "error";
}

export interface ClaudeStreamOptions {
  pid: number | null;
  usageThreshold?: number;
}

const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";
const PROGRESS_MAX = 500;
/** Texts of a tool_result that mean "not executed because of a permission rule or hook". */
const DENIAL_TEXT = /permission for this tool use was denied|requires approval|hook error|blocked by .*hook/i;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (isObj(c) && typeof c.text === "string" ? c.text : isObj(c) && typeof c.type === "string" ? `[${c.type}]` : ""))
      .filter(Boolean)
      .join("\n");
  }
  return content === undefined || content === null ? "" : JSON.stringify(content);
}

export class ClaudeStreamParser {
  private _sessionId: string | null = null;
  private _result: ClaudeResultInfo | null = null;
  private hasResultOutput = false;
  private resultOutput: unknown = undefined;
  private acceptedStructuredInput: unknown = undefined;
  private hasAcceptedStructured = false;
  private readonly calls = new Map<string, { name: string; input: unknown }>();
  private readonly outcomes = new Map<string, { isError: boolean; text: string }>();
  private readonly decisions = new Map<string, { decision: string | null; source: string | null }>();
  private readonly deniedEvents = new Map<string, { tool: string; message: string | null }>();
  private readonly listed: Array<{ id: string; tool: string; input: unknown }> = [];
  private _usage: UsageReading | null = null;
  private _limit: ClaudeLimitSignal | null = null;
  private _apiError: string | null = null;
  private apiErrorText: string | null = null;
  private started = false;
  initTools: string[] = [];
  mcpServers: Array<{ name: string; status: string }> = [];

  constructor(private readonly opts: ClaudeStreamOptions) {}

  get sessionId(): string | null {
    return this._sessionId;
  }

  get result(): ClaudeResultInfo | null {
    return this._result;
  }

  /** `result.structured_output`; if the result never arrived, the last accepted StructuredOutput call. */
  get structuredOutput(): unknown {
    if (this.hasResultOutput) return this.resultOutput;
    return this.hasAcceptedStructured ? this.acceptedStructuredInput : undefined;
  }

  get usage(): UsageReading | null {
    return this._usage;
  }

  get limit(): ClaudeLimitSignal | null {
    return this._limit;
  }

  /** API error code from an API-error assistant message, e.g. "model_not_found" or "rate_limit". */
  get apiError(): string | null {
    return this._apiError;
  }

  /** Best error text for a failed run. */
  errorText(): string | null {
    return this.apiErrorText ?? (this._result?.isError ? this._result.text : null);
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
      case "system":
        return this.onSystem(e);
      case "assistant":
        return this.onAssistant(e);
      case "user":
        return this.onUser(e);
      case "rate_limit_event":
        return this.onRateLimit(e);
      case "result":
        this.onResult(e);
        return [];
      default:
        return [];
    }
  }

  /**
   * Permission denials that really happened (spike S1, PM): `result.permission_denials` also
   * lists calls that ran and errored, so each entry is checked against its tool_result and the
   * CLI's permission decision. An entry with no tool_result at all counts (fail closed).
   */
  realDenials(): PermissionDenial[] {
    const ids: string[] = [];
    const inputs = new Map<string, { tool: string; input: unknown }>();
    const add = (id: string, tool: string, input: unknown) => {
      if (!inputs.has(id)) {
        ids.push(id);
        inputs.set(id, { tool, input });
      }
    };
    for (const d of this.listed) add(d.id, d.tool, d.input);
    for (const [id, ev] of this.deniedEvents) add(id, ev.tool, this.calls.get(id)?.input ?? null);
    for (const [id, d] of this.decisions) {
      if (d.decision === "reject") add(id, this.calls.get(id)?.name ?? "unknown", this.calls.get(id)?.input ?? null);
    }
    const out: PermissionDenial[] = [];
    for (const id of ids) {
      const outcome = this.outcomes.get(id);
      const decision = this.decisions.get(id);
      const event = this.deniedEvents.get(id);
      let real: boolean;
      if (event || decision?.decision === "reject") real = true;
      else if (!outcome) real = true;
      else real = outcome.isError && decision?.decision !== "accept" && DENIAL_TEXT.test(outcome.text);
      if (!real) continue;
      const hook = decision?.source === "hook" || /hook error/i.test(outcome?.text ?? "");
      const { tool, input } = inputs.get(id)!;
      out.push({ tool, input, source: hook ? "hook" : "permission", reason: event?.message ?? outcome?.text ?? null });
    }
    return out;
  }

  private onSystem(e: Json): RunnerEvent[] {
    if (e.subtype === "init") {
      this._sessionId = str(e.session_id) ?? this._sessionId;
      this.initTools = Array.isArray(e.tools) ? e.tools.filter((t): t is string => typeof t === "string") : [];
      this.mcpServers = Array.isArray(e.mcp_servers)
        ? e.mcp_servers.filter(isObj).map((s) => ({ name: String(s.name), status: String(s.status) }))
        : [];
      if (this.started) return [];
      this.started = true;
      return [{ type: "started", engine: "claude", sessionId: this._sessionId, pid: this.opts.pid }];
    }
    if (e.subtype === "permission_denied") {
      const id = str(e.tool_use_id);
      if (id) this.deniedEvents.set(id, { tool: str(e.tool_name) ?? "unknown", message: str(e.message) ?? str(e.decision_reason) });
    }
    return [];
  }

  private onAssistant(e: Json): RunnerEvent[] {
    const events: RunnerEvent[] = [];
    const message = isObj(e.message) ? e.message : {};
    const content = Array.isArray(message.content) ? message.content.filter(isObj) : [];
    if (e.is_api_error_message === true) {
      this._apiError = str(e.error) ?? "api_error";
      this.apiErrorText = content.map((c) => str(c.text)).filter(Boolean).join("\n") || this._apiError;
      if (!this._limit && (this._apiError === "rate_limit" || isClaudeLimitMessage(this.apiErrorText))) {
        this._limit = { resetsAt: null, reason: "error" };
      }
    }
    for (const c of content) {
      if (c.type === "text") {
        const text = str(c.text)?.trim();
        if (text) events.push({ type: "progress", text: clip(text, PROGRESS_MAX) });
      } else if (c.type === "tool_use") {
        const id = str(c.id);
        const name = str(c.name) ?? "unknown";
        if (id) this.calls.set(id, { name, input: c.input });
        if (name !== STRUCTURED_OUTPUT_TOOL) {
          events.push({ type: "tool", name, status: "started", summary: summarizeToolInput(c.input) });
        }
      }
    }
    return events;
  }

  private onUser(e: Json): RunnerEvent[] {
    for (const meta of Array.isArray(e.tool_result_meta) ? e.tool_result_meta.filter(isObj) : []) {
      const id = str(meta.id);
      const pd = isObj(meta.permission_decision) ? meta.permission_decision : null;
      if (id && pd) this.decisions.set(id, { decision: str(pd.decision), source: str(pd.source) });
    }
    const message = isObj(e.message) ? e.message : {};
    const content = Array.isArray(message.content) ? message.content.filter(isObj) : [];
    const events: RunnerEvent[] = [];
    for (const c of content) {
      if (c.type !== "tool_result") continue;
      const id = str(c.tool_use_id);
      if (!id) continue;
      const isError = c.is_error === true;
      const text = resultText(c.content);
      this.outcomes.set(id, { isError, text });
      const call = this.calls.get(id);
      if (call?.name === STRUCTURED_OUTPUT_TOOL) {
        if (!isError) {
          this.acceptedStructuredInput = call.input;
          this.hasAcceptedStructured = true;
        }
        continue;
      }
      const decision = this.decisions.get(id);
      const denied =
        this.deniedEvents.has(id) || decision?.decision === "reject" || (isError && decision?.decision !== "accept" && DENIAL_TEXT.test(text));
      const status = denied ? "denied" : isError ? "error" : "done";
      const summary = status === "done" ? summarizeToolInput(call?.input) : clip(text.split("\n")[0] ?? "", 160) || null;
      events.push({ type: "tool", name: call?.name ?? "unknown", status, summary });
    }
    return events;
  }

  private onRateLimit(e: Json): RunnerEvent[] {
    if (!isObj(e.rate_limit_info)) return [];
    const reading = readClaudeRateLimit(e.rate_limit_info as ClaudeRateLimitInfo, this.opts.usageThreshold);
    this._usage = reading;
    if (reading.limited && reading.reason && this._limit?.reason !== "status") {
      this._limit = { resetsAt: reading.usage.resetsAt, reason: reading.reason };
    }
    return [{ type: "usage", engine: "claude", usage: reading.usage, limited: reading.limited }];
  }

  private onResult(e: Json): void {
    this._sessionId = str(e.session_id) ?? this._sessionId;
    this._result = {
      subtype: str(e.subtype),
      isError: e.is_error === true,
      numTurns: num(e.num_turns),
      durationMs: num(e.duration_ms),
      apiErrorStatus: num(e.api_error_status),
      terminalReason: str(e.terminal_reason),
      text: str(e.result),
      sessionId: str(e.session_id),
    };
    if (Object.prototype.hasOwnProperty.call(e, "structured_output")) {
      this.hasResultOutput = true;
      this.resultOutput = e.structured_output;
    }
    for (const d of Array.isArray(e.permission_denials) ? e.permission_denials.filter(isObj) : []) {
      const id = str(d.tool_use_id);
      if (id) this.listed.push({ id, tool: str(d.tool_name) ?? "unknown", input: d.tool_input ?? null });
    }
    if (!this._limit && this._result.isError && (this._result.apiErrorStatus === 429 || isClaudeLimitMessage(this._result.text ?? ""))) {
      this._limit = { resetsAt: null, reason: "error" };
    }
  }
}
