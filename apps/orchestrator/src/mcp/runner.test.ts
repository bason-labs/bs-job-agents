// PM2 S17: each Lead spawn reaches the orchestrator MCP server with its own capability, which dies
// with the spawn; every other bot runs on the base runner.
import { join } from "node:path";
import { getBotOutputJsonSchema, type BotDefinition } from "@bs-job-agents/shared";
import { describe, expect, it } from "vitest";
import { loadBotDefinition } from "../runner/bots.js";
import { buildClaudeInvocation } from "../runner/claude/argv.js";
import { defaultBotsDir, resolveRunnerConfig } from "../runner/config.js";
import type { McpServerConfig, Runner, RunnerResult, RunnerTask } from "../runner/index.js";
import { planTools } from "../runner/tools.js";
import { CapabilityStore } from "./capabilities.js";
import { LeadMcpRunner, orchestratorServerConfig } from "./runner.js";
import type { OrchestratorMcpServer } from "./server.js";
import { ORCHESTRATOR_TOOLS } from "./tools.js";

const bot = (name: string): BotDefinition => loadBotDefinition(join(defaultBotsDir(), name));

const OK: RunnerResult = { status: "ok", output: {}, sessionId: null, durationMs: 1 };

function task(name: string, kind: string, input: unknown = { roomId: "7" }): RunnerTask {
  return { taskId: 42, runId: null, attempt: 1, bot: bot(name), kind, input, cwd: "/bots", transcriptPath: "/t.jsonl", timeoutMs: 600_000 };
}

const fakeServer: OrchestratorMcpServer = {
  url: (token) => `http://127.0.0.1:5555/mcp/${token}`,
  port: () => 5555,
  handle: async () => undefined,
  close: async () => undefined,
};

function recorder(onRun?: (t: RunnerTask) => void): Runner & { runs: RunnerTask[] } {
  const runs: RunnerTask[] = [];
  return {
    engine: "claude",
    runs,
    async run(t) {
      runs.push(t);
      onRun?.(t);
      return OK;
    },
  };
}

describe("LeadMcpRunner", () => {
  it("runs a bot without the orchestrator server on the base runner, with no capability", async () => {
    const caps = new CapabilityStore();
    const base = recorder();
    let spawned = 0;
    const r = new LeadMcpRunner(base, { capabilities: caps, server: () => fakeServer, spawnRunner: () => (spawned++, recorder()) });
    await r.run(task("research", "scan", { source: "itviec" }), () => undefined);
    expect(base.runs).toHaveLength(1);
    expect(spawned).toBe(0);
  });

  it("gives a Lead chat spawn its own capability URL, mapped to {lead, work} and its room, revoked when the spawn returns", async () => {
    const caps = new CapabilityStore();
    const configs: McpServerConfig[] = [];
    let during: ReturnType<CapabilityStore["resolve"]> = null;
    const r = new LeadMcpRunner(recorder(), {
      capabilities: caps,
      server: () => fakeServer,
      spawnRunner: (cfg) => {
        configs.push(cfg);
        const token = decodeURIComponent((cfg as { url: string }).url.split("/mcp/")[1]!);
        return recorder(() => {
          during = caps.resolve(token);
        });
      },
    });
    await r.run(task("lead", "chat"), () => undefined);
    await r.run(task("lead", "chat"), () => undefined);
    expect(during).toMatchObject({ taskId: 42, caller: { botName: "lead", mode: "work" }, roomId: 7 });
    const urls = configs.map((c) => (c as { url: string }).url);
    expect(urls[0]).not.toBe(urls[1]);
    expect(configs[0]).toMatchObject({ knownTools: [...ORCHESTRATOR_TOOLS] });
    expect(caps.size()).toBe(0);
  });

  it("revokes the capability even when the spawn throws", async () => {
    const caps = new CapabilityStore();
    const r = new LeadMcpRunner(recorder(), {
      capabilities: caps,
      server: () => fakeServer,
      spawnRunner: () => ({
        engine: "claude",
        run: async () => {
          throw new Error("boom");
        },
      }),
    });
    await expect(r.run(task("lead", "chat"), () => undefined)).rejects.toThrow("boom");
    expect(caps.size()).toBe(0);
  });

  it("a Lead room reply (discussion) maps to discussion mode, never work (rule 1)", async () => {
    const caps = new CapabilityStore();
    let mode: string | null = null;
    const r = new LeadMcpRunner(recorder(), {
      capabilities: caps,
      server: () => fakeServer,
      spawnRunner: (cfg) => {
        const token = decodeURIComponent((cfg as { url: string }).url.split("/mcp/")[1]!);
        return recorder(() => {
          mode = caps.resolve(token)?.caller.mode ?? null;
        });
      },
    });
    await r.run(task("lead", "discussion"), () => undefined);
    expect(mode).toBe("discussion");
  });

  it("fails the task (no spawn) when the MCP server is not running", async () => {
    const r = new LeadMcpRunner(recorder(), { capabilities: new CapabilityStore(), server: () => null, spawnRunner: () => recorder() });
    expect((await r.run(task("lead", "chat"), () => undefined)).status).toBe("failed");
  });
});

describe("Lead's CLI invocation with the per-spawn server (rule 5)", () => {
  it("puts the capability URL in mcp.json (never argv) and allows only the six orchestrator tools", () => {
    const lead = bot("lead");
    const url = "http://127.0.0.1:5555/mcp/SECRET-capability-token-value";
    const config = resolveRunnerConfig({ mcpServers: { orchestrator: orchestratorServerConfig(url) } }, { HOME: "/Users/ba" });
    const inv = buildClaudeInvocation({
      bot: lead,
      plan: planTools(lead),
      prompt: "p",
      schema: getBotOutputJsonSchema("LeadOutput"),
      sessionId: "00000000-0000-4000-8000-000000000000",
      workDir: "/tmp/w",
      readDirs: [],
      config,
    });
    expect(inv.args.join(" ")).not.toContain("SECRET");
    expect(JSON.parse(inv.files["/tmp/w/mcp.json"]!)).toEqual({ mcpServers: { orchestrator: { type: "http", url } } });
    const allowed = inv.args.slice(inv.args.indexOf("--allowedTools") + 1, inv.args.indexOf("--mcp-config"));
    expect(allowed.filter((a) => !a.startsWith("--")).sort()).toEqual(ORCHESTRATOR_TOOLS.map((t) => `mcp__orchestrator__${t}`).sort());
    // No browser, file-write or shell tool for Lead.
    expect(inv.args[inv.args.indexOf("--tools") + 1]).not.toMatch(/Bash|Write|Edit/);
    expect(inv.args).not.toContain("--chrome");
  });
});
