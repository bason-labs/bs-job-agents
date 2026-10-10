import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { fakeSpawn } from "./__fixtures__/fake-cli.js";
import { killProcessGroup, nodeSpawn, runCli, type CliChild, type RunCliOptions } from "./process.js";

function options(over: Partial<RunCliOptions> & Pick<RunCliOptions, "spawn">): RunCliOptions & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    command: "fake",
    args: ["--x"],
    cwd: "/tmp",
    env: { PATH: "/usr/bin" },
    killTree: (child: CliChild, signal: NodeJS.Signals) => child.kill(signal),
    deadline: Date.now() + 5_000,
    killGraceMs: 50,
    onStdoutLine: (l) => out.push(l),
    onStderrLine: (l) => err.push(l),
    ...over,
    out,
    err,
  };
}

describe("runCli", () => {
  it("passes command, args and cwd to spawn and splits output into lines", async () => {
    const { spawn, calls } = fakeSpawn([{ stdout: ['{"a":1}', '{"b":2}'], stderr: ["warn"], exitCode: 0 }]);
    const o = options({ spawn });
    const exit = await runCli(o);
    expect(exit).toMatchObject({ exitCode: 0, timedOut: false, cancelled: false, spawnError: null, pid: 10_000 });
    expect(o.out).toEqual(['{"a":1}', '{"b":2}']);
    expect(o.err).toEqual(["warn"]);
    expect(calls[0]).toMatchObject({ command: "fake", args: ["--x"], options: { cwd: "/tmp", env: { PATH: "/usr/bin" } } });
  });

  it("joins chunks split mid-line, strips CR and flushes a last line without newline", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const fake = Object.assign(new EventEmitter(), { pid: 1, stdout, stderr, kill: () => true }) as unknown as CliChild;
    const o = options({ spawn: () => fake });
    const done = runCli(o);
    stdout.write('{"par');
    stdout.write('t":1}\r\n{"b"');
    stdout.write(":2}");
    stdout.end();
    stderr.end();
    setTimeout(() => (fake as unknown as EventEmitter).emit("close", 0, null), 10);
    await done;
    expect(o.out).toEqual(['{"part":1}', '{"b":2}']);
  });

  it("times out: SIGTERM to the process group at the deadline", async () => {
    const { spawn, calls } = fakeSpawn([{ hang: true }]);
    const killTree = vi.fn((child: CliChild, signal: NodeJS.Signals) => child.kill(signal));
    const exit = await runCli(options({ spawn, killTree, deadline: Date.now() + 30 }));
    expect(exit).toMatchObject({ timedOut: true, cancelled: false });
    expect(killTree).toHaveBeenCalledWith(calls[0]!.child, "SIGTERM");
  });

  it("escalates to SIGKILL after the grace period", async () => {
    const { spawn, calls } = fakeSpawn([{ hang: true, ignoreSigterm: true }]);
    const exit = await runCli(options({ spawn, deadline: Date.now() + 20, killGraceMs: 30 }));
    expect(exit.timedOut).toBe(true);
    expect(calls[0]!.child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("cancels on AbortSignal", async () => {
    const { spawn, calls } = fakeSpawn([{ hang: true }]);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    const exit = await runCli(options({ spawn, signal: ac.signal }));
    expect(exit).toMatchObject({ cancelled: true, timedOut: false });
    expect(calls[0]!.child.signals).toEqual(["SIGTERM"]);
  });

  it("does not spawn when already cancelled or past the deadline", async () => {
    const { spawn, calls } = fakeSpawn([{ stdout: [] }]);
    const ac = new AbortController();
    ac.abort();
    expect(await runCli(options({ spawn, signal: ac.signal }))).toMatchObject({ cancelled: true, pid: null });
    expect(await runCli(options({ spawn, deadline: Date.now() - 1 }))).toMatchObject({ timedOut: true, pid: null });
    expect(calls).toHaveLength(0);
  });

  it("reports a spawn error (missing binary)", async () => {
    const { spawn } = fakeSpawn([{ spawnError: "spawn /nope ENOENT" }]);
    expect(await runCli(options({ spawn }))).toMatchObject({ spawnError: "spawn /nope ENOENT", exitCode: null });
  });

  it("reports an async spawn error from the real spawn", async () => {
    const exit = await runCli(options({ spawn: nodeSpawn, killTree: killProcessGroup, command: "/definitely/not/a/binary", args: [] }));
    expect(exit.spawnError).toMatch(/ENOENT/);
  });

  it("kills the whole process group of a real child (CLI plus its MCP servers)", async () => {
    // A node parent that starts a grandchild (like claude starting an MCP server), prints its pid, then hangs.
    const script = [
      "const { spawn } = require('node:child_process');",
      "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "console.log(String(g.pid));",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const out: string[] = [];
    const exit = await runCli(
      options({
        spawn: nodeSpawn,
        killTree: killProcessGroup,
        command: process.execPath,
        args: ["-e", script],
        env: process.env,
        deadline: Date.now() + 1_500,
        killGraceMs: 500,
        onStdoutLine: (l) => out.push(l),
      }),
    );
    expect(exit.timedOut).toBe(true);
    const grandchild = Number(out[0]);
    expect(grandchild).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(grandchild, 0)).toThrow();
  }, 10_000);
});
