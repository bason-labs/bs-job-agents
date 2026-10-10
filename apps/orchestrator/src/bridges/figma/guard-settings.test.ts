import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFingerprint } from "./fingerprint.js";
import type { FigmaGuardPolicy } from "./guard.js";
import {
  buildFigmaGuardSettings,
  figmaGuardHookCommand,
  prepareFigmaGuard,
  readFigmaGuardConfig,
  writeFigmaGuardConfig,
} from "./guard-settings.js";

const KEY = "kJFoXNrTfFOtkQ515c0jHk";
const policy: FigmaGuardPolicy = {
  draftsPageName: "Drafts",
  draftsPageId: "2:3",
  protectedPageNames: ["resume", "components"],
  protectedPageIds: ["0:1", "1:2"],
  protectedNodeIds: ["459:1767"],
  fileKey: KEY,
};

function runHook(command: string, input: unknown): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

const execute = (code: string, fileKey: string | undefined = KEY) => ({
  hook_event_name: "PreToolUse",
  tool_name: "mcp__figma__figma_execute",
  tool_input: { code, timeout: 5000, ...(fileKey ? { fileKey } : {}) },
});

describe("Figma guard config and settings", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "bridges-figma-guard-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes and reads the policy", async () => {
    const path = join(dir, "nested", "figma-guard.json");
    await writeFigmaGuardConfig(path, policy, { serverName: "figma" });
    expect(readFigmaGuardConfig(path)).toEqual({ policy, serverName: "figma", allowedTools: null });
  });

  it("rejects a malformed config", async () => {
    const path = join(dir, "bad.json");
    await writeFile(path, JSON.stringify({ policy: { draftsPageName: 3 } }));
    expect(() => readFigmaGuardConfig(path)).toThrow(/Figma guard config/);
  });

  it("routes every tool of the Figma server through the hook", () => {
    const settings = buildFigmaGuardSettings({ configPath: "/data/tasks/7/figma-guard.json", logFile: "/data/tasks/7/figma-guard.jsonl", nodePath: "/opt/node" });
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    const [entry] = settings.hooks.PreToolUse;
    expect(entry?.matcher).toBe("mcp__figma__.*");
    expect(entry?.hooks[0]).toMatchObject({ type: "command", timeout: 15 });
    expect(entry?.hooks[0]?.command).toContain("'--config' '/data/tasks/7/figma-guard.json' '--log' '/data/tasks/7/figma-guard.jsonl'");
    expect(entry?.hooks[0]?.command.endsWith(" || exit 2")).toBe(true);
    expect(buildFigmaGuardSettings({ configPath: "/x.json", serverName: "figma.local" }).hooks.PreToolUse[0]?.matcher).toBe("mcp__figma\\.local__.*");
  });

  it("prepares a guard from a fingerprint in one step", async () => {
    const fp = buildFingerprint({
      fileKey: KEY,
      draftsPageName: "Drafts",
      takenAt: "2026-10-11T00:00:00.000Z",
      resources: null,
      pages: [{ id: "0:1", name: "resume", nodes: [{ id: "459:1767", type: "FRAME", name: "T", parentId: "0:1", index: 0 }] }],
    });
    const prepared = await prepareFigmaGuard({ fingerprint: fp, dir: join(dir, "task-9"), draftsPageId: "2:3" });
    expect(prepared.configPath).toBe(join(dir, "task-9", "figma-guard.json"));
    expect(prepared.policy.protectedNodeIds).toEqual(["459:1767"]);
    expect(JSON.parse(await readFile(prepared.configPath, "utf8"))).toMatchObject({ policy: { fileKey: KEY } });
    expect(prepared.settings.hooks.PreToolUse[0]?.hooks[0]?.command).toContain(prepared.configPath);
  });
});

describe("Figma guard hook as a child process", () => {
  let dir: string;
  let configPath: string;
  let logFile: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "bridges-figma-hook-"));
    configPath = join(dir, "figma-guard.json");
    logFile = join(dir, "figma-guard.jsonl");
    await writeFigmaGuardConfig(configPath, policy);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("allows Drafts work, blocks writes to templates with exit 2, and logs", async () => {
    const command = figmaGuardHookCommand({ configPath, logFile });
    const ok = await runHook(command, execute(`const f = await figma.getNodeByIdAsync("601:1"); f.name = "x";`));
    expect(ok).toEqual({ code: 0, stderr: "" });

    const blocked = await runHook(command, execute(`(await figma.getNodeByIdAsync("459:1767")).remove();`));
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toMatch(/^Blocked by Figma guard: `\(await figma.getNodeByIdAsync\("459:1767"\)\).remove\(\)` changes a node outside the Drafts page/);

    const otherFile = await runHook(command, execute("return 1", "someOtherFile"));
    expect(otherFile.code).toBe(2);

    const lines = (await readFile(logFile, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { decision: string; guard: string });
    expect(lines.map((l) => l.decision)).toEqual(["allow", "block", "block"]);
    expect(lines[0]?.guard).toBe("figma");
  }, 60_000);

  it("blocks everything when the config is missing", async () => {
    const command = figmaGuardHookCommand({ configPath: join(dir, "missing.json") });
    const result = await runHook(command, execute("return 1"));
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/Figma guard/);
  }, 30_000);
});
