// The Figma guard as a Claude Code hook: its per-task config file and the `--settings` JSON.
// Flow per CV task (engine): fingerprint the protected pages → prepareFigmaGuard → run the CV bot
// with these settings → fingerprint again and diff.
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { buildHookCommand, resolveHookEntry } from "../hooks/command.js";
import type { ClaudeHookSettings } from "../hooks/settings.js";
import type { ProtectedPagesFingerprint } from "./fingerprint.js";
import { figmaGuardPolicyFromFingerprint, type FigmaGuardPolicy } from "./guard.js";

export const FigmaGuardConfigSchema = z.object({
  policy: z.object({
    draftsPageName: z.string().min(1),
    draftsPageId: z.string().nullable().default(null),
    protectedPageNames: z.array(z.string()),
    protectedPageIds: z.array(z.string()),
    protectedNodeIds: z.array(z.string()),
    fileKey: z.string().nullable().default(null),
  }),
  /** MCP server name of figma-console-mcp in the bot's mcp.json. */
  serverName: z.string().min(1).default("figma"),
  /** Tools the bot may call on that server (default: figma_get_status, figma_execute, figma_capture_screenshot). */
  allowedTools: z.array(z.string()).nullable().default(null),
});
export type FigmaGuardConfig = z.infer<typeof FigmaGuardConfigSchema>;

export async function writeFigmaGuardConfig(
  path: string,
  policy: FigmaGuardPolicy,
  opts: { serverName?: string; allowedTools?: readonly string[] } = {},
): Promise<void> {
  const config: FigmaGuardConfig = FigmaGuardConfigSchema.parse({
    policy,
    serverName: opts.serverName,
    allowedTools: opts.allowedTools ? [...opts.allowedTools] : null,
  });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2));
}

export function readFigmaGuardConfig(path: string): FigmaGuardConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`cannot read the Figma guard config ${path}: ${(err as Error).message}`);
  }
  const parsed = FigmaGuardConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`invalid Figma guard config ${path}: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  return parsed.data;
}

export interface FigmaGuardSettingsOptions {
  configPath: string;
  /** JSONL audit log of every decision. */
  logFile?: string;
  /** MCP server name in the bot's mcp.json (default "figma"). */
  serverName?: string;
  nodePath?: string;
  /** Seconds Claude Code waits for the hook (default 15). */
  timeoutSec?: number;
}

export function figmaGuardHookCommand(opts: Pick<FigmaGuardSettingsOptions, "configPath" | "logFile" | "nodePath">): string {
  const args = ["--config", opts.configPath, ...(opts.logFile ? ["--log", opts.logFile] : [])];
  return buildHookCommand(resolveHookEntry(import.meta.url, "guard-hook"), args, { nodePath: opts.nodePath });
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `--settings` hooks: every tool of the Figma server goes through the guard. */
export function buildFigmaGuardSettings(opts: FigmaGuardSettingsOptions): ClaudeHookSettings {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: `mcp__${escapeRegex(opts.serverName ?? "figma")}__.*`,
          hooks: [{ type: "command", command: figmaGuardHookCommand(opts), timeout: opts.timeoutSec ?? 15 }],
        },
      ],
    },
  };
}

export interface PrepareFigmaGuardOptions {
  /** The "before" fingerprint of the CV task. */
  fingerprint: ProtectedPagesFingerprint;
  /** Task folder; the config is written to <dir>/figma-guard.json. */
  dir: string;
  draftsPageId?: string | null;
  serverName?: string;
  logFile?: string;
  nodePath?: string;
}

export async function prepareFigmaGuard(
  opts: PrepareFigmaGuardOptions,
): Promise<{ policy: FigmaGuardPolicy; configPath: string; settings: ClaudeHookSettings }> {
  const policy = figmaGuardPolicyFromFingerprint(opts.fingerprint, { draftsPageId: opts.draftsPageId ?? null });
  const configPath = join(opts.dir, "figma-guard.json");
  await writeFigmaGuardConfig(configPath, policy, { serverName: opts.serverName });
  const settings = buildFigmaGuardSettings({
    configPath,
    ...(opts.logFile ? { logFile: opts.logFile } : {}),
    ...(opts.serverName ? { serverName: opts.serverName } : {}),
    ...(opts.nodePath ? { nodePath: opts.nodePath } : {}),
  });
  return { policy, configPath, settings };
}
