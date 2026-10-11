import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIGMA_CONSOLE_MCP_VERSION } from "./constants.js";
import { resolveFigmaConsoleMcp } from "./mcp.js";
import { FIGMA_CONSOLE_MCP_TOOLS } from "./tools.js";

/** Every `.tool("name"` / `registerTool("name"` call in the installed package's dist (no Figma needed). */
function registeredTools(distDir: string): string[] {
  const names = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".js")) {
        for (const m of readFileSync(path, "utf8").matchAll(/(?:registerTool|\.tool)\(\s*"([a-z_]+)"/g)) names.add(m[1]!);
      }
    }
  };
  walk(distDir);
  return [...names].sort();
}

describe("figma-console-mcp tool list (PM2 S12)", () => {
  it("matches every tool the pinned package registers", () => {
    const { serverPath, version } = resolveFigmaConsoleMcp();
    expect(version).toBe(FIGMA_CONSOLE_MCP_VERSION);
    expect(registeredTools(dirname(serverPath))).toEqual([...FIGMA_CONSOLE_MCP_TOOLS].sort());
    expect(FIGMA_CONSOLE_MCP_TOOLS).toHaveLength(121);
  });

  it("includes CV's three tools", () => {
    for (const t of ["figma_get_status", "figma_execute", "figma_capture_screenshot"]) expect(FIGMA_CONSOLE_MCP_TOOLS).toContain(t);
  });
});
