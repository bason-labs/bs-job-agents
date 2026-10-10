import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  browserReadyFor,
  checkBrowserBridge,
  defaultBrowserProbes,
  NATIVE_HOSTS,
  nativeHostManifestPath,
  type BrowserProbes,
} from "./status.js";

const HOME = "/Users/ba";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const HELPER =
  "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/154.0/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)";
const CLAUDE_HOST = "/Users/ba/.claude/chrome/chrome-native-host";
const CODEX_HOST = "/Users/ba/.codex/plugins/cache/openai-bundled/chrome/latest/extension-host/macos/arm64/ChatGPT for Chrome";

const manifest = (name: string, path: string) =>
  JSON.stringify({ name, description: "x", path, type: "stdio", allowed_origins: ["chrome-extension://abc/"] });

function probes(overrides: Partial<BrowserProbes> & { files?: Record<string, string>; executables?: string[] } = {}): BrowserProbes {
  const files: Record<string, string> = overrides.files ?? {
    [nativeHostManifestPath(HOME, NATIVE_HOSTS.claude)]: manifest(NATIVE_HOSTS.claude, CLAUDE_HOST),
    [nativeHostManifestPath(HOME, NATIVE_HOSTS.codex)]: manifest(NATIVE_HOSTS.codex, CODEX_HOST),
  };
  const executables = new Set(overrides.executables ?? [CLAUDE_HOST, CODEX_HOST]);
  return {
    homeDir: HOME,
    listProcesses: overrides.listProcesses ?? (() => Promise.resolve([CHROME, HELPER, CODEX_HOST, "/usr/sbin/cfprefsd"])),
    readFile: overrides.readFile ?? ((p) => Promise.resolve(files[p] ?? null)),
    isExecutable: overrides.isExecutable ?? ((p) => Promise.resolve(executables.has(p))),
  };
}

const now = () => new Date("2026-10-11T02:00:00.000Z");

describe("checkBrowserBridge", () => {
  it("is ready for both engines when Chrome runs and both native hosts are installed", async () => {
    const status = await checkBrowserBridge({ probes: probes(), now });
    expect(status.chromeRunning).toBe(true);
    expect(status.checkedAt).toBe("2026-10-11T02:00:00.000Z");
    expect(status.engines.claude).toMatchObject({ ready: true, reason: null });
    expect(status.engines.codex).toMatchObject({ ready: true, reason: null });
    expect(status.engines.claude.nativeHost).toMatchObject({
      name: "com.anthropic.claude_code_browser_extension",
      manifestPath: "/Users/ba/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.anthropic.claude_code_browser_extension.json",
      installed: true,
      hostPath: CLAUDE_HOST,
      hostExecutable: true,
      hostRunning: false,
    });
    expect(status.engines.codex.nativeHost.hostRunning).toBe(true);
    expect(browserReadyFor(status, "claude")).toBe(true);
  });

  it("is not ready when only Chrome helper processes are left", async () => {
    const status = await checkBrowserBridge({ probes: probes({ listProcesses: () => Promise.resolve([HELPER]) }), now });
    expect(status.chromeRunning).toBe(false);
    expect(status.engines.claude).toMatchObject({ ready: false, reason: "chrome_not_running" });
    expect(status.engines.claude.message).toMatch(/Chrome is not running/);
    expect(browserReadyFor(status, "codex")).toBe(false);
  });

  it("reports a missing native host per engine", async () => {
    const files = { [nativeHostManifestPath(HOME, NATIVE_HOSTS.codex)]: manifest(NATIVE_HOSTS.codex, CODEX_HOST) };
    const status = await checkBrowserBridge({ probes: probes({ files }), now });
    expect(status.engines.claude).toMatchObject({ ready: false, reason: "native_host_missing" });
    expect(status.engines.claude.message).toMatch(/Claude in Chrome/);
    expect(status.engines.codex.ready).toBe(true);
  });

  it("reports a broken manifest: bad JSON, wrong name, missing host binary", async () => {
    const claudeManifest = nativeHostManifestPath(HOME, NATIVE_HOSTS.claude);
    const codexManifest = nativeHostManifestPath(HOME, NATIVE_HOSTS.codex);

    const badJson = await checkBrowserBridge({ probes: probes({ files: { [claudeManifest]: "{oops", [codexManifest]: manifest("com.other", CODEX_HOST) } }), now });
    expect(badJson.engines.claude).toMatchObject({ ready: false, reason: "native_host_invalid" });
    expect(badJson.engines.codex).toMatchObject({ ready: false, reason: "native_host_invalid" });
    expect(badJson.engines.codex.nativeHost.error).toMatch(/name/);

    const noBinary = await checkBrowserBridge({ probes: probes({ executables: [CODEX_HOST] }), now });
    expect(noBinary.engines.claude).toMatchObject({ ready: false, reason: "native_host_invalid" });
    expect(noBinary.engines.claude.nativeHost.error).toMatch(/not found or not executable/);
  });

  it("treats a failing process probe as not ready", async () => {
    const status = await checkBrowserBridge({
      probes: probes({ listProcesses: () => Promise.reject(new Error("ps: not permitted")) }),
      now,
    });
    expect(status.chromeRunning).toBe(false);
    expect(status.error).toMatch(/ps: not permitted/);
    expect(status.engines.claude).toMatchObject({ ready: false, reason: "probe_failed" });
  });
});

describe("defaultBrowserProbes", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bridges-chrome-status-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads files, tells executables apart and lists processes (no Chrome involved)", async () => {
    const file = join(dir, "m.json");
    await writeFile(file, "{}");
    const script = join(dir, "host");
    await writeFile(script, "#!/bin/sh\n");
    await chmod(script, 0o755);

    expect(await defaultBrowserProbes.readFile(file)).toBe("{}");
    expect(await defaultBrowserProbes.readFile(join(dir, "missing.json"))).toBeNull();
    expect(await defaultBrowserProbes.isExecutable(script)).toBe(true);
    expect(await defaultBrowserProbes.isExecutable(file)).toBe(false);
    const processes = await defaultBrowserProbes.listProcesses();
    expect(processes.length).toBeGreaterThan(0);
  });
});
