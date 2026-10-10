// Fake CLI processes for runner tests: no real claude / codex is ever started (phases.md rule 1).
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import type { CliChild, SpawnFn, SpawnOptions } from "../process.js";

export interface FakeScript {
  /** stdout lines to print (a trailing newline is added to each). */
  stdout?: readonly string[];
  stderr?: readonly string[];
  exitCode?: number | null;
  /** Never exit on its own; only a kill ends it. */
  hang?: boolean;
  /** Ignore SIGTERM (only SIGKILL ends it). */
  ignoreSigterm?: boolean;
  /** Delay before printing, ms. */
  delayMs?: number;
  /** Throw from spawn() like a missing binary (ENOENT). */
  spawnError?: string;
  /** Files to write before exiting (e.g. Codex `-o last.json`), keyed by a function of the args. */
  writeFiles?: (args: readonly string[]) => Record<string, string>;
}

export interface SpawnCall {
  command: string;
  args: string[];
  options: SpawnOptions;
  child: FakeChild;
}

export class FakeChild extends EventEmitter implements CliChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: string[] = [];
  private exited = false;

  constructor(
    readonly pid: number,
    private readonly script: FakeScript,
  ) {
    super();
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    this.signals.push(String(signal));
    if (signal === "SIGTERM" && this.script.ignoreSigterm) return true;
    this.finish(null, String(signal) as NodeJS.Signals);
    return true;
  }

  finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => {
      this.emit("exit", code, signal);
      this.emit("close", code, signal);
    });
  }

  get hasExited(): boolean {
    return this.exited;
  }
}

/**
 * A SpawnFn that plays one script per call, in order (the last script repeats).
 * `scripts` may also be a function of the call (command + args) to pick the script.
 */
export function fakeSpawn(scripts: readonly FakeScript[] | ((command: string, args: readonly string[]) => FakeScript)) {
  const calls: SpawnCall[] = [];
  let next = 0;
  const spawn: SpawnFn = (command, args, options) => {
    const script = typeof scripts === "function" ? scripts(command, args) : scripts[Math.min(next, scripts.length - 1)]!;
    next += 1;
    if (script.spawnError) {
      const err = new Error(script.spawnError) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }
    const child = new FakeChild(10_000 + calls.length, script);
    calls.push({ command, args: [...args], options, child });
    const play = () => {
      if (child.hasExited) return;
      for (const line of script.stdout ?? []) child.stdout.write(`${line}\n`);
      for (const line of script.stderr ?? []) child.stderr.write(`${line}\n`);
      for (const [path, content] of Object.entries(script.writeFiles?.(args) ?? {})) writeFileSync(path, content);
      if (!script.hang) child.finish(script.exitCode ?? 0, null);
    };
    if (script.delayMs) setTimeout(play, script.delayMs);
    else setImmediate(play);
    return child;
  };
  return { spawn, calls };
}

/** Value of `--flag <value>` (first occurrence) in an argv. */
export function argValue(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
