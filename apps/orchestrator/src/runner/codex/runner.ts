// CodexRunner: `codex exec --json` for Codex bots (spec §5.5, spikes S1/S2/S4).
import { readFile } from "node:fs/promises";
import { codexPluginsToDisable, codexUserMcpServers, type RunnerConfig } from "../config.js";
import { CliRunner, stderrTail, type AttemptReport, type EngineSession, type Phase, type PreparedTask, type RunnerDeps } from "../cli-runner.js";
import type { Invocation } from "../invocation.js";
import { runCli } from "../process.js";
import { isSessionId } from "../sessions.js";
import { codexToolConfig } from "../tools.js";
import { buildCodexDeleteInvocation, buildCodexInvocation, buildCodexRepairInvocation, codexPaths } from "./argv.js";
import { CodexStreamParser } from "./stream.js";

/** Printed by `codex exec` whenever stdin is closed; never an error. */
const STDIN_NOTICE = /^Reading additional input from stdin/;
const DELETE_TIMEOUT_MS = 15_000;

export class CodexRunner extends CliRunner {
  readonly engine = "codex" as const;

  constructor(config: RunnerConfig, deps: RunnerDeps = {}) {
    super(config, deps);
  }

  protected initialSessionId(): null {
    return null;
  }

  protected initialInvocation(p: PreparedTask): Invocation {
    const browser = codexToolConfig(p.plan).browser;
    const listPlugins = this.deps.codexPluginsToDisable ?? (() => codexPluginsToDisable(this.config));
    const listServers = this.deps.codexMcpServersToDisable ?? (() => codexUserMcpServers(this.config));
    return buildCodexInvocation({
      bot: p.task.bot,
      plan: p.plan,
      prompt: p.prompt,
      schema: p.schema,
      workDir: p.workDir,
      config: this.config,
      pluginsToDisable: browser ? listPlugins() : [],
      mcpServersToDisable: browser ? listServers() : [],
    });
  }

  protected repairInvocation(p: PreparedTask, threadId: string, prompt: string): Invocation {
    return buildCodexRepairInvocation({ bot: p.task.bot, prompt, threadId, workDir: p.workDir, config: this.config });
  }

  protected openSession(p: PreparedTask, phase: Phase, pid: number | null): EngineSession {
    const parser = new CodexStreamParser({ pid, now: () => new Date(this.now()) });
    const outPath = phase === "initial" ? codexPaths(p.workDir).last : codexPaths(p.workDir).repair;
    return {
      push: (line) => parser.push(line),
      finish: async (exit, stderr): Promise<AttemptReport> => {
        let text: string | null;
        try {
          text = await readFile(outPath, "utf8");
        } catch {
          text = parser.lastMessage;
        }
        if (text !== null && text.trim() === "") text = null;
        let value: unknown = undefined;
        let parseError: string | null = null;
        if (text !== null) {
          try {
            value = JSON.parse(text) as unknown;
          } catch {
            parseError = "the final message is not valid JSON";
          }
        }
        const noise = stderr.filter((l) => !STDIN_NOTICE.test(l));
        const tail = noise.length > 0 ? `: ${stderrTail(noise)}` : "";
        let failure = parser.failure;
        if (!failure && exit.exitCode !== null && exit.exitCode !== 0) failure = `codex exited with code ${exit.exitCode}${tail}`;
        if (!failure && !parser.turnCompleted && value === undefined) failure = `codex ended without completing the turn${tail}`;
        return {
          sessionId: parser.threadId,
          value,
          raw: text,
          parseError,
          failure,
          limit: parser.limit ? { resetsAt: parser.limit.resetsAt } : null,
          denials: [],
        };
      },
    };
  }

  /** `codex delete --force <thread>`: the thread was persisted only for the repair prompt. */
  protected async deleteSession(threadId: string, cwd: string): Promise<void> {
    if (!isSessionId(threadId)) return;
    const inv = buildCodexDeleteInvocation(threadId, this.config);
    await runCli({
      command: inv.command,
      args: inv.args,
      cwd,
      env: this.config.env,
      spawn: this.spawn,
      killTree: this.killTree,
      deadline: Date.now() + DELETE_TIMEOUT_MS,
      killGraceMs: this.config.killGraceMs,
      onStdoutLine: () => undefined,
      onStderrLine: () => undefined,
    });
  }
}
