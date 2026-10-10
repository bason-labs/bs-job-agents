// Spawning one CLI process (spec §5.5 step 2). Injected `spawn` so tests never start a real CLI.
// - stdin is closed (spike S1: `claude -p` otherwise waits 3 s for it).
// - The child leads its own process group (detached), so a kill reaches the MCP servers and
//   shells it started. On a timeout or cancel: SIGTERM to the group, SIGKILL after a grace period.
import { spawn } from "node:child_process";

export interface SpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** The part of a ChildProcess the runner uses. */
export interface CliChild {
  readonly pid?: number | undefined;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: "error", listener: (err: Error) => void): unknown;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => CliChild;
export type KillTreeFn = (child: CliChild, signal: NodeJS.Signals) => void;

/** Real spawn: stdin closed, stdout/stderr piped, own process group. */
export const nodeSpawn: SpawnFn = (command, args, options) =>
  spawn(command, [...args], { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"], detached: true });

/** Signal the child's whole process group; fall back to the child alone. */
export const killProcessGroup: KillTreeFn = (child, signal) => {
  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // group already gone or not a group leader: try the child itself
    }
  }
  try {
    child.kill(signal);
  } catch {
    // already exited
  }
};

export interface RunCliOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  spawn: SpawnFn;
  killTree: KillTreeFn;
  /** Epoch ms after which the process is killed (`timedOut`). */
  deadline: number;
  signal?: AbortSignal;
  killGraceMs: number;
  onStdoutLine: (line: string) => void;
  onStderrLine: (line: string) => void;
  onSpawn?: (pid: number | null) => void;
}

export interface CliExit {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  /** Set when the binary could not be started (e.g. ENOENT). */
  spawnError: string | null;
  pid: number | null;
}

/** Splits a byte stream into lines; strips a trailing CR; `flush` emits a last unterminated line. */
class LineSplitter {
  private buffer = "";
  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: Buffer | string): void {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let nl = this.buffer.indexOf("\n");
    while (nl >= 0) {
      this.emit(this.buffer.slice(0, nl));
      this.buffer = this.buffer.slice(nl + 1);
      nl = this.buffer.indexOf("\n");
    }
  }

  flush(): void {
    if (this.buffer.length > 0) this.emit(this.buffer);
    this.buffer = "";
  }

  private emit(line: string): void {
    this.onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  }
}

/** Run one CLI process to completion (or timeout / cancel). Never rejects. */
export function runCli(o: RunCliOptions): Promise<CliExit> {
  const base: CliExit = { exitCode: null, signal: null, timedOut: false, cancelled: false, spawnError: null, pid: null };
  if (o.signal?.aborted) return Promise.resolve({ ...base, cancelled: true });
  if (Date.now() >= o.deadline) return Promise.resolve({ ...base, timedOut: true });

  let child: CliChild;
  try {
    child = o.spawn(o.command, o.args, { cwd: o.cwd, env: o.env });
  } catch (err) {
    return Promise.resolve({ ...base, spawnError: err instanceof Error ? err.message : String(err) });
  }

  return new Promise<CliExit>((resolve) => {
    const state: CliExit = { ...base, pid: child.pid ?? null };
    o.onSpawn?.(state.pid);
    const out = new LineSplitter(o.onStdoutLine);
    const err = new LineSplitter(o.onStderrLine);
    child.stdout?.on("data", (d: Buffer | string) => out.push(d));
    child.stderr?.on("data", (d: Buffer | string) => err.push(d));

    let settled = false;
    let graceTimer: NodeJS.Timeout | undefined;
    const kill = () => {
      if (graceTimer) return;
      o.killTree(child, "SIGTERM");
      graceTimer = setTimeout(() => o.killTree(child, "SIGKILL"), o.killGraceMs);
    };
    const deadlineTimer = setTimeout(
      () => {
        state.timedOut = true;
        kill();
      },
      Math.max(0, o.deadline - Date.now()),
    );
    const onAbort = () => {
      state.cancelled = true;
      kill();
    };
    o.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      if (graceTimer) clearTimeout(graceTimer);
      o.signal?.removeEventListener("abort", onAbort);
      out.flush();
      err.flush();
      // A cancel wins over a timeout that fired while the kill was in flight, and vice versa only once.
      if (state.cancelled) state.timedOut = false;
      resolve(state);
    };
    child.once("error", (e: Error) => {
      state.spawnError = e.message;
      finish();
    });
    child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
      state.exitCode = code;
      state.signal = signal;
      finish();
    });
  });
}
