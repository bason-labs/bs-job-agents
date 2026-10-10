import { describe, expect, it } from "vitest";
import { buildHookCommand, resolveHookEntry, shellQuote } from "./command.js";
import { mergeHookSettings, type ClaudeHookSettings } from "./settings.js";

describe("shellQuote", () => {
  it("single-quotes and escapes embedded quotes", () => {
    expect(shellQuote("plain")).toBe("'plain'");
    expect(shellQuote("/Library/Application Support/x")).toBe("'/Library/Application Support/x'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote("$(rm -rf /)")).toBe("'$(rm -rf /)'");
  });
});

describe("resolveHookEntry", () => {
  it("runs the compiled entry when the caller is compiled JavaScript", () => {
    expect(resolveHookEntry("file:///app/dist/bridges/chrome/site-guard/settings.js", "hook")).toEqual({
      path: "/app/dist/bridges/chrome/site-guard/hook.js",
      runtime: "dist",
    });
  });

  it("runs the TypeScript entry through tsx when the caller is source", () => {
    expect(resolveHookEntry("file:///app/src/bridges/chrome/site-guard/settings.ts", "hook")).toEqual({
      path: "/app/src/bridges/chrome/site-guard/hook.ts",
      runtime: "source",
    });
  });
});

describe("buildHookCommand", () => {
  it("builds a fail-closed node command for a compiled entry", () => {
    const cmd = buildHookCommand({ path: "/app/dist/hook.js", runtime: "dist" }, ["--allow", "topcv.vn"], {
      nodePath: "/usr/local/bin/node",
    });
    expect(cmd).toBe("'/usr/local/bin/node' '/app/dist/hook.js' '--allow' 'topcv.vn' || exit 2");
  });

  it("loads tsx for a source entry", () => {
    const cmd = buildHookCommand({ path: "/app/src/hook.ts", runtime: "source" }, [], { nodePath: "node" });
    expect(cmd).toMatch(/^'node' '--import' 'file:\/\/\/.+\/tsx\/dist\/loader\.mjs' '\/app\/src\/hook\.ts' \|\| exit 2$/);
  });

  it("defaults to the node binary running the orchestrator", () => {
    const cmd = buildHookCommand({ path: "/app/dist/hook.js", runtime: "dist" }, []);
    expect(cmd.startsWith(shellQuote(process.execPath))).toBe(true);
  });
});

describe("mergeHookSettings", () => {
  it("concatenates PreToolUse matchers from several guards", () => {
    const a: ClaudeHookSettings = {
      hooks: { PreToolUse: [{ matcher: "mcp__a__x", hooks: [{ type: "command", command: "a", timeout: 10 }] }] },
    };
    const b: ClaudeHookSettings = {
      hooks: { PreToolUse: [{ matcher: "mcp__b__.*", hooks: [{ type: "command", command: "b", timeout: 10 }] }] },
    };
    expect(mergeHookSettings(a, b).hooks.PreToolUse.map((m) => m.matcher)).toEqual(["mcp__a__x", "mcp__b__.*"]);
    expect(mergeHookSettings().hooks.PreToolUse).toEqual([]);
  });
});
