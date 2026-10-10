// ClaudeRunner: `claude -p` for Claude bots (spec §5.5, spike S1/S2).
import type { RunnerConfig } from "../config.js";
import { CliRunner, stderrTail, type AttemptReport, type EngineSession, type Phase, type PreparedTask, type RunnerDeps } from "../cli-runner.js";
import type { Invocation } from "../invocation.js";
import { removeClaudeSession } from "../sessions.js";
import { buildClaudeInvocation, buildClaudeRepairInvocation } from "./argv.js";
import { ClaudeStreamParser } from "./stream.js";

export class ClaudeRunner extends CliRunner {
  readonly engine = "claude" as const;

  constructor(config: RunnerConfig, deps: RunnerDeps = {}) {
    super(config, deps);
  }

  protected initialSessionId(): string {
    return this.uuid();
  }

  protected initialInvocation(p: PreparedTask): Invocation {
    return buildClaudeInvocation({
      bot: p.task.bot,
      plan: p.plan,
      prompt: p.prompt,
      schema: p.schema,
      sessionId: p.sessionId ?? this.uuid(),
      workDir: p.workDir,
      readDirs: p.readDirs,
      allowedSites: p.allowedSites,
      config: this.config,
    });
  }

  protected repairInvocation(p: PreparedTask, sessionId: string, prompt: string): Invocation {
    return buildClaudeRepairInvocation({ bot: p.task.bot, prompt, schema: p.schema, sessionId, config: this.config });
  }

  protected openSession(_p: PreparedTask, _phase: Phase, pid: number | null): EngineSession {
    const parser = new ClaudeStreamParser({ pid, usageThreshold: this.config.usagePauseUtilization });
    return {
      push: (line) => parser.push(line),
      finish: async (exit, stderr): Promise<AttemptReport> => {
        const value = parser.structuredOutput;
        const result = parser.result;
        let failure: string | null = null;
        if (!result) {
          const how = exit.exitCode !== null ? `code ${exit.exitCode}` : `signal ${exit.signal ?? "?"}`;
          failure = `claude exited with ${how} without a result${stderr.length > 0 ? `: ${stderrTail(stderr)}` : ""}`;
        } else if (result.isError) {
          failure = parser.errorText() ?? (stderr.length > 0 ? stderrTail(stderr) : `claude reported ${result.subtype ?? "an error"}`);
        }
        return {
          sessionId: parser.sessionId,
          value,
          raw: value === undefined ? (result?.text ?? null) : JSON.stringify(value),
          parseError: null,
          failure,
          limit: parser.limit ? { resetsAt: parser.limit.resetsAt } : null,
          denials: parser.realDenials(),
        };
      },
    };
  }

  protected removeSession(_p: PreparedTask, sessionId: string): Promise<void> {
    return removeClaudeSession(this.config.claudeConfigDir, sessionId);
  }
}
