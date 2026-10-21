import { describe, expect, it } from "vitest";
import { InvalidAllowlistError } from "./allowlist.js";
import { buildSiteGuardSettings, siteGuardHookCommand } from "./settings.js";

describe("buildSiteGuardSettings", () => {
  it("routes each guarded Chrome tool to the hook with the same command", () => {
    const settings = buildSiteGuardSettings({ allowedSites: ["topcv.vn", "*.itviec.com"], nodePath: "/opt/node" });
    const matchers = settings.hooks.PreToolUse.map((m) => m.matcher);
    expect(matchers).toEqual([
      "mcp__claude-in-chrome__navigate",
      "mcp__claude-in-chrome__javascript_tool",
      "mcp__claude-in-chrome__browser_batch",
      "mcp__claude-in-chrome__shortcuts_execute",
      "mcp__claude-in-chrome__switch_browser",
      "mcp__claude-in-chrome__select_browser",
      "mcp__claude-in-chrome__computer",
    ]);
    expect(matchers.some((m) => m.includes("tabs_create"))).toBe(false);
    const commands = new Set(settings.hooks.PreToolUse.flatMap((m) => m.hooks.map((h) => h.command)));
    expect(commands.size).toBe(1);
    const hook = settings.hooks.PreToolUse[0]?.hooks[0];
    expect(hook).toMatchObject({ type: "command", timeout: 15 });
    expect(hook?.command).toContain("'--allow' 'topcv.vn' '--allow' 'itviec.com'");
    expect(hook?.command.startsWith("'/opt/node' ")).toBe(true);
    expect(hook?.command.endsWith(" || exit 2")).toBe(true);
  });

  it("is plain JSON for --settings", () => {
    const settings = buildSiteGuardSettings({ allowedSites: ["topcv.vn"], logFile: "/data/transcripts/12-1.guard.jsonl" });
    const roundTrip = JSON.parse(JSON.stringify(settings)) as unknown;
    expect(roundTrip).toEqual(settings);
    expect(settings.hooks.PreToolUse[0]?.hooks[0]?.command).toContain("'--log' '/data/transcripts/12-1.guard.jsonl'");
  });

  it("refuses an empty or invalid allowlist at spawn time", () => {
    expect(() => buildSiteGuardSettings({ allowedSites: [] })).toThrow(InvalidAllowlistError);
    expect(() => buildSiteGuardSettings({ allowedSites: ["https://topcv.vn/jobs"] })).toThrow(InvalidAllowlistError);
  });

  it("passes a custom tool prefix through to the hook", () => {
    const cmd = siteGuardHookCommand({ allowedSites: ["topcv.vn"], toolPrefix: "mcp__chrome__" });
    expect(cmd).toContain("'--tool-prefix' 'mcp__chrome__'");
    const settings = buildSiteGuardSettings({ allowedSites: ["topcv.vn"], toolPrefix: "mcp__chrome__" });
    expect(settings.hooks.PreToolUse[0]?.matcher).toBe("mcp__chrome__navigate");
  });
});

describe("live 2026-10-20: the chosen Chrome browser", () => {
  it("is passed to the hook as --browser; an id that is not a plain device id is refused", () => {
    expect(siteGuardHookCommand({ allowedSites: ["itviec.com"], browserId: "3e83d913-aaaa-4bbb-8ccc-1234567890ab" })).toMatch(/--browser'? '?3e83d913-aaaa-4bbb-8ccc-1234567890ab/);
    expect(siteGuardHookCommand({ allowedSites: ["itviec.com"] })).not.toContain("--browser");
    expect(() => siteGuardHookCommand({ allowedSites: ["itviec.com"], browserId: "x; rm -rf /" })).toThrow(InvalidAllowlistError);
  });
});
