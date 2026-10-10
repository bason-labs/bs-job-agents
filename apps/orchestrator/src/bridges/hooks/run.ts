// Runs a guard as a PreToolUse hook: read stdin, decide, log, return the exit code.
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { isRecord, PreToolUseInputSchema, type GuardDecision, type PreToolUseCall } from "./protocol.js";

export interface HookStreams {
  stdin: AsyncIterable<Buffer | string>;
  stderr: { write(chunk: string): unknown };
}

export interface RunHookOptions {
  /** Short guard name for messages ("Blocked by <name> guard: …") and logs, e.g. "site", "figma". */
  guard: string;
  /** Append one JSON line per decision here (audit trail for safety events, spec §10.2 rule 8). */
  logFile?: string;
  /** Inputs above this size are blocked (default 8 MiB). */
  maxInputBytes?: number;
  now?: () => Date;
}

export type HookExitCode = 0 | 2;

const DEFAULT_MAX_INPUT_BYTES = 8 * 1024 * 1024;

class InputTooLarge extends Error {}

async function readAll(stdin: AsyncIterable<Buffer | string>, max: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stdin) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += buf.length;
    if (size > max) throw new InputTooLarge();
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function writeLog(file: string, entry: Record<string, unknown>): Promise<void> {
  try {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, JSON.stringify(entry) + "\n");
  } catch {
    // The decision stands even when the audit line cannot be written.
  }
}

export async function runPreToolUseHook(
  evaluate: (call: PreToolUseCall) => GuardDecision,
  io: HookStreams,
  opts: RunHookOptions,
): Promise<HookExitCode> {
  const block = (message: string): HookExitCode => {
    io.stderr.write(message.endsWith("\n") ? message : `${message}\n`);
    return 2;
  };

  let raw: string;
  try {
    raw = await readAll(io.stdin, opts.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES);
  } catch (err) {
    return block(
      err instanceof InputTooLarge
        ? `Blocked by ${opts.guard} guard: the tool input is too large to check.`
        : `Blocked by ${opts.guard} guard: could not read the hook input.`,
    );
  }

  let parsed: ReturnType<typeof PreToolUseInputSchema.safeParse>;
  try {
    parsed = PreToolUseInputSchema.safeParse(JSON.parse(raw));
  } catch {
    return block(`Blocked by ${opts.guard} guard: could not read the hook input (not JSON).`);
  }
  if (!parsed.success) return block(`Blocked by ${opts.guard} guard: could not read the hook input (no tool name).`);
  const input = parsed.data;
  if (input.hook_event_name !== undefined && input.hook_event_name !== "PreToolUse") return 0;

  const call: PreToolUseCall = {
    toolName: input.tool_name,
    toolInput: isRecord(input.tool_input) ? input.tool_input : {},
    ...(input.session_id !== undefined ? { sessionId: input.session_id } : {}),
    ...(input.tool_use_id !== undefined ? { toolUseId: input.tool_use_id } : {}),
  };

  let decision: GuardDecision;
  try {
    decision = evaluate(call);
  } catch (err) {
    decision = {
      allow: false,
      rule: "guard_error",
      reason: `Blocked: ${opts.guard} guard failed: ${(err as Error).message}`,
    };
  }

  if (opts.logFile) {
    const now = (opts.now ?? (() => new Date()))();
    await writeLog(opts.logFile, {
      ts: now.toISOString(),
      guard: opts.guard,
      tool: call.toolName,
      decision: decision.allow ? "allow" : "block",
      ...(decision.allow ? {} : { rule: decision.rule, reason: decision.reason, ...(decision.target ? { target: decision.target } : {}) }),
      ...(call.sessionId ? { sessionId: call.sessionId } : {}),
      ...(call.toolUseId ? { toolUseId: call.toolUseId } : {}),
    });
  }

  return decision.allow ? 0 : block(decision.reason);
}
