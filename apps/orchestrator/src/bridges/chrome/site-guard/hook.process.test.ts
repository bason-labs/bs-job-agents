// Runs the real hook command in a child process, through /bin/sh as Claude Code does.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildHookCommand } from "../../hooks/command.js";
import { siteGuardHookCommand } from "./settings.js";

function runHook(command: string, input: unknown): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr, stdout }));
    child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  });
}

const navigate = (url: string) => ({
  session_id: "s1",
  hook_event_name: "PreToolUse",
  tool_name: "mcp__claude-in-chrome__navigate",
  tool_input: { url, tabId: 7 },
});

describe("site guard hook as a child process", () => {
  let dir: string;
  let logFile: string;
  let command: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "bridges-site-guard-"));
    logFile = join(dir, "guard.jsonl");
    command = siteGuardHookCommand({ allowedSites: ["topcv.vn", "itviec.com"], logFile });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("allows an allowed site, blocks another one with exit 2, and logs both", async () => {
    const ok = await runHook(command, navigate("https://www.topcv.vn/viec-lam"));
    expect(ok).toMatchObject({ code: 0, stderr: "", stdout: "" });

    const blocked = await runHook(command, navigate("https://example.com/"));
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toMatch(/^Blocked by site guard: navigation goes to "example.com"/);

    const batch = await runHook(command, {
      hook_event_name: "PreToolUse",
      tool_name: "mcp__claude-in-chrome__browser_batch",
      tool_input: { actions: [{ name: "javascript_tool", input: { text: "location.assign('https://evil.example')" } }] },
    });
    expect(batch.code).toBe(2);

    const lines = (await readFile(logFile, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { decision: string; guard: string });
    expect(lines.map((l) => l.decision)).toEqual(["allow", "block", "block"]);
    expect(lines.every((l) => l.guard === "site")).toBe(true);
  }, 60_000);

  it("fails closed on garbage input", async () => {
    const result = await runHook(command, "not json");
    expect(result.code).toBe(2);
  }, 30_000);

  it("fails closed when the hook script cannot even start", async () => {
    const broken = buildHookCommand({ path: join(dir, "missing-hook.js"), runtime: "dist" }, []);
    const result = await runHook(broken, navigate("https://www.topcv.vn/"));
    expect(result.code).toBe(2);
  }, 30_000);
});
