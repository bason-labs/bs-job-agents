// Browser bridge check (spec §4.2, §4.4, §10.3): before a browser task starts, Chrome must be
// running and the engine's extension installed; otherwise the task waits as `needs_browser`.
//
// What it can see: whether the main Google Chrome process runs, and whether each extension's
// native messaging host is installed (manifest + executable). It cannot see whether the
// extension is enabled and signed in; a runner that gets "extension not connected" from the
// CLI should also pause the task as `needs_browser`.
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { Engine } from "@bs-job-agents/shared";

/** Native messaging hosts of the two extensions (spec §1.4). */
export const NATIVE_HOSTS: Record<Engine, string> = {
  claude: "com.anthropic.claude_code_browser_extension",
  codex: "com.openai.codexextension",
};

const EXTENSION_NAMES: Record<Engine, string> = {
  claude: "Claude in Chrome",
  codex: "ChatGPT for Chrome",
};

/** Basename of the main browser process; helpers are "Google Chrome Helper (…)". */
const CHROME_PROCESS = "Google Chrome";

export interface BrowserProbes {
  homeDir: string;
  /** Executable paths of running processes. */
  listProcesses(): Promise<string[]>;
  /** File contents, or null when the file does not exist. */
  readFile(path: string): Promise<string | null>;
  isExecutable(path: string): Promise<boolean>;
}

const execFileAsync = promisify(execFile);

export const defaultBrowserProbes: BrowserProbes = {
  homeDir: homedir(),
  async listProcesses() {
    const { stdout } = await execFileAsync("ps", ["-axo", "comm="], { maxBuffer: 16 * 1024 * 1024 });
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "");
  },
  async readFile(path) {
    try {
      return await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  },
  async isExecutable(path) {
    try {
      await access(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
};

export function nativeHostManifestPath(homeDir: string, hostName: string): string {
  return join(homeDir, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts", `${hostName}.json`);
}

export type BrowserNotReadyReason = "chrome_not_running" | "native_host_missing" | "native_host_invalid" | "probe_failed";

export interface NativeHostStatus {
  name: string;
  manifestPath: string;
  installed: boolean;
  hostPath: string | null;
  hostExecutable: boolean;
  /** The host process runs (informational: Claude in Chrome starts it per session). */
  hostRunning: boolean;
  error: string | null;
}

export interface EngineBrowserStatus {
  engine: Engine;
  ready: boolean;
  reason: BrowserNotReadyReason | null;
  /** Short explanation for Ba (needs_browser detail, sidebar status). */
  message: string;
  nativeHost: NativeHostStatus;
}

export interface BrowserBridgeStatus {
  chromeRunning: boolean;
  engines: Record<Engine, EngineBrowserStatus>;
  /** Set when a probe itself failed. */
  error: string | null;
  checkedAt: string;
}

async function checkNativeHost(engine: Engine, probes: BrowserProbes, processes: readonly string[]): Promise<NativeHostStatus> {
  const name = NATIVE_HOSTS[engine];
  const manifestPath = nativeHostManifestPath(probes.homeDir, name);
  const status: NativeHostStatus = {
    name,
    manifestPath,
    installed: false,
    hostPath: null,
    hostExecutable: false,
    hostRunning: false,
    error: null,
  };
  let raw: string | null;
  try {
    raw = await probes.readFile(manifestPath);
  } catch (err) {
    return { ...status, error: `cannot read the manifest: ${(err as Error).message}` };
  }
  if (raw === null) return status;
  status.installed = true;

  let manifest: unknown;
  try {
    manifest = JSON.parse(raw);
  } catch {
    return { ...status, error: "the manifest is not valid JSON" };
  }
  const m = manifest as { name?: unknown; path?: unknown };
  if (m.name !== name) return { ...status, error: `the manifest name is ${JSON.stringify(m.name)}, expected ${name}` };
  if (typeof m.path !== "string" || !m.path.startsWith("/")) return { ...status, error: "the manifest has no absolute host path" };
  status.hostPath = m.path;
  status.hostExecutable = await probes.isExecutable(m.path);
  status.hostRunning = processes.includes(m.path);
  if (!status.hostExecutable) status.error = `the host program ${m.path} is not found or not executable`;
  return status;
}

function engineStatus(engine: Engine, chromeRunning: boolean, probeFailed: boolean, host: NativeHostStatus): EngineBrowserStatus {
  const ext = EXTENSION_NAMES[engine];
  const notReady = (reason: BrowserNotReadyReason, message: string): EngineBrowserStatus => ({
    engine,
    ready: false,
    reason,
    message,
    nativeHost: host,
  });
  if (probeFailed) return notReady("probe_failed", "Could not check whether Chrome is running.");
  if (!chromeRunning) return notReady("chrome_not_running", "Chrome is not running. Open Google Chrome; browser tasks start when it is back.");
  if (!host.installed) return notReady("native_host_missing", `The ${ext} extension is not installed (no native host ${host.name}).`);
  if (host.error) return notReady("native_host_invalid", `The ${ext} extension's native host is broken: ${host.error}.`);
  return { engine, ready: true, reason: null, message: `Chrome is running and ${ext} is installed.`, nativeHost: host };
}

export interface CheckBrowserBridgeOptions {
  probes?: Partial<BrowserProbes>;
  now?: () => Date;
}

export async function checkBrowserBridge(opts: CheckBrowserBridgeOptions = {}): Promise<BrowserBridgeStatus> {
  const probes: BrowserProbes = { ...defaultBrowserProbes, ...opts.probes };
  let processes: string[] = [];
  let error: string | null = null;
  try {
    processes = await probes.listProcesses();
  } catch (err) {
    error = `process list failed: ${(err as Error).message}`;
  }
  const chromeRunning = processes.some((p) => basename(p) === CHROME_PROCESS);
  const [claude, codex] = await Promise.all([
    checkNativeHost("claude", probes, processes),
    checkNativeHost("codex", probes, processes),
  ]);
  return {
    chromeRunning,
    engines: {
      claude: engineStatus("claude", chromeRunning, error !== null, claude),
      codex: engineStatus("codex", chromeRunning, error !== null, codex),
    },
    error,
    checkedAt: (opts.now ?? (() => new Date()))().toISOString(),
  };
}

/** Whether a browser task on `engine` can start now (otherwise: pause it as `needs_browser`). */
export function browserReadyFor(status: BrowserBridgeStatus, engine: Engine): boolean {
  return status.engines[engine].ready;
}
