// Test kit for the engine runners: temp folders, tasks, a configurable test bot, transcript reading.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotDefinitionSchema, type BotDefinition, type BotDefinitionInput } from "@bs-job-agents/shared";
import { loadBotDefinition } from "../bots.js";
import { defaultBotsDir, resolveRunnerConfig, type RunnerConfig } from "../config.js";
import type { RunnerEvent, RunnerTask } from "../types.js";

export const BOTS_DIR = defaultBotsDir();

export interface Kit {
  root: string;
  tmpRoot: string;
  claudeConfigDir: string;
  transcriptPath: string;
  config(over?: Partial<RunnerConfig>): RunnerConfig;
  /** A bot folder with ROLE.md and memory.md for a custom definition. */
  customBot(over: Partial<BotDefinitionInput> & Pick<BotDefinitionInput, "name">): { def: BotDefinition; cwd: string };
  realBot(name: string): { def: BotDefinition; cwd: string };
  task(def: BotDefinition, cwd: string, over?: Partial<RunnerTask>): RunnerTask;
  transcriptLines(): Array<Record<string, unknown>>;
  workDirsLeft(): string[];
  dir(name: string): string;
  dispose(): void;
}

export function makeKit(): Kit {
  const root = mkdtempSync(join(tmpdir(), "bsja-runner-"));
  const tmpRoot = join(root, "tmp");
  const claudeConfigDir = join(root, "claude-config");
  mkdirSync(tmpRoot);
  mkdirSync(claudeConfigDir);
  const transcriptPath = join(root, "data", "transcripts", "42-1.jsonl");
  return {
    root,
    tmpRoot,
    claudeConfigDir,
    transcriptPath,
    config: (over = {}) =>
      resolveRunnerConfig(
        {
          claudeBin: "/fake/claude",
          codexBin: "/fake/codex",
          tmpRoot,
          claudeConfigDir,
          codexUserConfigPath: join(root, "codex-config.toml"),
          killGraceMs: 20,
          mcpServers: { orchestrator: { url: "http://127.0.0.1:4100/mcp" } },
          hooks: { siteGuard: { command: "node", args: ["/fake/site-guard.js"] }, figmaGuard: { command: "node", args: ["/fake/figma-guard.js"] } },
          ...over,
        },
        { HOME: root, PATH: "/usr/bin" },
      ),
    customBot: (over) => {
      const def = BotDefinitionSchema.parse({
        displayName: "Scout",
        role: "Test bot.",
        engine: "claude",
        model: null,
        trustLevel: 2,
        allowedTools: ["read"],
        outputSchema: "ConsultOutput",
        selfCheck: ["Tried every call once"],
        promptVersion: 1,
        ...over,
      });
      const cwd = join(root, "bots", def.name);
      mkdirSync(cwd, { recursive: true });
      writeFileSync(join(cwd, "ROLE.md"), `You are ${def.displayName}, a test bot.\n`);
      writeFileSync(join(cwd, "memory.md"), "");
      return { def, cwd };
    },
    realBot: (name) => ({ def: loadBotDefinition(join(BOTS_DIR, name)), cwd: join(BOTS_DIR, name) }),
    task: (def, cwd, over = {}) => ({
      taskId: 42,
      runId: 7,
      attempt: 1,
      bot: def,
      kind: "probe",
      input: { note: "test" },
      cwd,
      transcriptPath,
      timeoutMs: 5_000,
      ...over,
    }),
    transcriptLines: () =>
      existsSync(transcriptPath)
        ? readFileSync(transcriptPath, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l) as Record<string, unknown>)
        : [],
    workDirsLeft: () => readdirSync(tmpRoot),
    dir: (name) => {
      const d = join(root, name);
      mkdirSync(d, { recursive: true });
      return d;
    },
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Collects runner events. */
export function eventLog() {
  const events: RunnerEvent[] = [];
  return { events, onEvent: (e: RunnerEvent) => events.push(e) };
}

/** A conversation input (consult / discussion). */
export const CONSULT_INPUT = { roomId: "room_1", messageId: "msg_1", text: "Which engine do you run on?", history: [], uploadIds: [] };
