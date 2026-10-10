// Production wiring (Phase 3/4, W3a): adapters from W2b's runner and W2c's bridges to the
// engine's ports, and one call that builds the whole engine. Tests use ./testing instead.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FigmaBridge, browserReadyFor, buildSiteGuardSettings, checkBrowserBridge, extractText, prepareFigmaGuard } from "../bridges/index.js";
import { appendMemoryChange, type Db } from "../db/index.js";
import { appendMemoryNotes, loadBots, readBotPromptFiles, seedMemoryFiles } from "../runner/index.js";
import type { Runner } from "../runner/types.js";
import { EnginePaths, type EngineConfig } from "./config.js";
import type { ConversationSink } from "./conversations.js";
import { Engine } from "./engine.js";
import type {
  BotRegistry,
  BrowserStatusProbe,
  FigmaPort,
  GuardHooks,
  Logger,
  MasterCvSource,
  MemoryWriter,
  OrphanKiller,
  PdfTextExtractor,
  RolePromptSource,
  WorkflowSource,
} from "./ports.js";
import { nodeFileStore } from "./system.js";

/** Coordinator A: per-task Claude hook settings from W2c's builders. */
export const bridgeGuardHooks: GuardHooks = {
  siteGuard: (o) => buildSiteGuardSettings({ allowedSites: o.allowedSites, logFile: o.logFile }),
  figmaGuard: async (o) =>
    (await prepareFigmaGuard({ fingerprint: o.fingerprint, dir: o.dir, logFile: o.logFile, draftsPageId: o.draftsPageId })).settings,
};

/** Coordinator C: Chrome running with this engine's extension installed (it cannot see a sign-in). */
export const chromeBrowserProbe: BrowserStatusProbe = {
  isConnected: async (engine) => browserReadyFor(await checkBrowserBridge(), engine),
};

/** §6.2: pdfjs reading-order text (never macOS PDFKit). */
export const pdfTextExtractor: PdfTextExtractor = {
  extractText: async (path) => (await extractText(path)).text,
};

/** data/master-cv.yaml: missing → null (UC-01 c); its `version:` line, else 1. */
export function fileMasterCv(path: string): MasterCvSource {
  return {
    path,
    version: () => {
      if (!existsSync(path)) return null;
      const m = /^version:\s*(\d+)\s*$/m.exec(readFileSync(path, "utf8"));
      return m ? Number(m[1]) : 1;
    },
  };
}

/** bots/<name>/ROLE.md through W2b's reader: prompt_versions at start-up (PM brief). */
export function botPromptSource(botsDir: string): RolePromptSource {
  return { roleMd: (botName) => readBotPromptFiles(join(botsDir, botName)).roleMd };
}

/** bots/<name>/bot.json through W2b's loader (schema, safety rules, tool vocabulary). */
export function botRegistryFrom(botsDir: string): BotRegistry {
  const defs = loadBots(botsDir);
  const byName = new Map(defs.map((d) => [d.name, d]));
  return { get: (name) => byName.get(name), list: () => [...defs] };
}

/** Rule 2 (§5.4): W2b's appendMemoryNotes, recording each note in memory_changes. */
export function memoryWriter(db: Db, botsDir: string): MemoryWriter {
  return {
    append: async ({ botName, notes, runId, taskId }) => {
      await appendMemoryNotes({
        botDir: join(botsDir, botName),
        notes,
        runId,
        taskId,
        onNote: (note) => {
          appendMemoryChange(db, { botName, note, runId, taskId });
        },
      });
    },
    seed: async (botNames) => {
      await seedMemoryFiles(botsDir, botNames);
    },
  };
}

/** UC-18: stop a CLI group a crash left behind, only if its leader is still a claude or codex process (pids are reused). */
export const cliOrphanKiller: OrphanKiller = {
  killGroup(pid) {
    let command: string;
    try {
      command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
    } catch {
      return; // already gone
    }
    if (!/(^|\/|\s)(claude|codex)(\s|$)/.test(command.trim())) return;
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // The group ended in the meantime.
    }
  },
};

export interface ProductionEngineOptions {
  db: Db;
  /** Absolute data/ and bots/ folders. */
  dataDir: string;
  botsDir: string;
  /** `createRunners(config)` (W2b): the config names the orchestrator MCP server, the guard hooks and tmpRoot. */
  runners: Record<"claude" | "codex", Runner>;
  workflows: WorkflowSource;
  /** Default: W2c's FigmaBridge on the CV file (it satisfies FigmaPort as is). */
  figma?: FigmaPort;
  /** Default: chromeBrowserProbe (Chrome running with the engine's extension). */
  browser?: BrowserStatusProbe;
  config?: Partial<EngineConfig>;
  logger?: Logger;
  /** PM2 S2: W3a's chat flows (replies, handoffs), called in the settle transaction. */
  conversations?: ConversationSink;
}

export function createProductionEngine(opts: ProductionEngineOptions): Engine {
  return new Engine({
    db: opts.db,
    runners: opts.runners,
    bots: botRegistryFrom(opts.botsDir),
    workflows: opts.workflows,
    paths: new EnginePaths(opts.dataDir, opts.botsDir),
    files: nodeFileStore,
    browser: opts.browser ?? chromeBrowserProbe,
    figma: opts.figma ?? new FigmaBridge(),
    guards: bridgeGuardHooks,
    pdf: pdfTextExtractor,
    masterCv: fileMasterCv(join(opts.dataDir, "master-cv.yaml")),
    memory: memoryWriter(opts.db, opts.botsDir),
    processes: cliOrphanKiller,
    prompts: botPromptSource(opts.botsDir),
    ...(opts.config ? { config: opts.config } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
    ...(opts.conversations ? { conversations: opts.conversations } : {}),
  });
}
