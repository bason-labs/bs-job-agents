import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CODEX_BIN,
  codexPluginsToDisable,
  defaultBotsDir,
  hookCommandLine,
  listCodexPlugins,
  resolveRunnerConfig,
  shellQuote,
} from "./config.js";

const CONFIG_TOML = `model = "gpt-6-sol"

[plugins."codex-app-tools@openai-bundled"]
enabled = true

[plugins."chrome@openai-bundled"]
enabled = true

[plugins."superpowers@claude-plugins-official"]
enabled = true

[mcp_servers.node_repl]
command = "/x/node_repl"
`;

describe("runner config", () => {
  it("defaults: CLIs per spec §1.4, the pinned Figma bridge, cleanup on", () => {
    const c = resolveRunnerConfig({}, { HOME: "/Users/ba" });
    expect(c.claudeBin).toBe("/Users/ba/.local/bin/claude");
    expect(c.codexBin).toBe(DEFAULT_CODEX_BIN);
    expect(c.claudeConfigDir).toBe("/Users/ba/.claude");
    expect(c.codexUserConfigPath).toBe("/Users/ba/.codex/config.toml");
    expect(c.mcpServers.figma).toEqual({ command: "npx", args: ["-y", "figma-console-mcp@1.40.9"] });
    expect(c.mcpServers.orchestrator).toBeUndefined();
    expect(c.cleanupSessions).toBe(true);
    expect(c.usagePauseUtilization).toBe(0.95);
  });

  it("env and explicit overrides win; MCP servers merge with the defaults", () => {
    const c = resolveRunnerConfig(
      { mcpServers: { orchestrator: { url: "http://127.0.0.1:4100/mcp" } }, hooks: { siteGuard: { command: "node", args: ["/g.js"] } } },
      { HOME: "/h", CLAUDE_BIN: "/opt/claude", CODEX_BIN: "/opt/codex", CLAUDE_CONFIG_DIR: "/cfg", CODEX_HOME: "/ch" },
    );
    expect([c.claudeBin, c.codexBin, c.claudeConfigDir, c.codexUserConfigPath]).toEqual(["/opt/claude", "/opt/codex", "/cfg", "/ch/config.toml"]);
    expect(Object.keys(c.mcpServers).sort()).toEqual(["figma", "orchestrator"]);
    expect(c.hooks.siteGuard).toEqual({ command: "node", args: ["/g.js"] });
  });

  it("lists Codex plugins and keeps only Chrome enabled for browser bots (§4.4)", () => {
    expect(listCodexPlugins(CONFIG_TOML)).toEqual([
      "codex-app-tools@openai-bundled",
      "chrome@openai-bundled",
      "superpowers@claude-plugins-official",
    ]);
    const dir = mkdtempSync(join(tmpdir(), "bsja-codex-"));
    try {
      writeFileSync(join(dir, "config.toml"), CONFIG_TOML);
      expect(codexPluginsToDisable({ codexUserConfigPath: join(dir, "config.toml"), codexChromePlugin: "chrome@openai-bundled" })).toEqual([
        "codex-app-tools@openai-bundled",
        "superpowers@claude-plugins-official",
      ]);
      expect(codexPluginsToDisable({ codexUserConfigPath: join(dir, "missing.toml"), codexChromePlugin: "x" })).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("quotes hook command lines for the shell", () => {
    expect(shellQuote("topcv.vn,itviec.com")).toBe("topcv.vn,itviec.com");
    expect(shellQuote("/Users/ba/My Apps/guard.js")).toBe("'/Users/ba/My Apps/guard.js'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(hookCommandLine({ command: "node", args: ["/g dir/site-guard.js"] }, ["--sites", "topcv.vn"])).toBe(
      "node '/g dir/site-guard.js' --sites topcv.vn",
    );
  });

  it("finds the repo's bots folder", () => {
    const bots = defaultBotsDir();
    expect(bots.endsWith("/bots")).toBe(true);
    expect(existsSync(join(bots, "..", "pnpm-workspace.yaml"))).toBe(true);
  });
});
