// The real stdio MCP client against a fake figma-console-mcp server process (never Figma).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FIGMA_CONSOLE_MCP_VERSION } from "./constants.js";
import { connectFigmaConsoleMcp, resolveFigmaConsoleMcp } from "./mcp.js";

const FAKE_SERVER = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "fake-figma-mcp-server.mjs");

const textOf = (r: { content: Array<{ text?: string }> }) => JSON.parse(r.content[0]?.text ?? "null") as Record<string, unknown>;

describe("resolveFigmaConsoleMcp", () => {
  it("finds the pinned figma-console-mcp entry point", () => {
    const { serverPath, version } = resolveFigmaConsoleMcp();
    expect(version).toBe(FIGMA_CONSOLE_MCP_VERSION);
    expect(serverPath.endsWith(join("figma-console-mcp", "dist", "local.js"))).toBe(true);
    expect(existsSync(serverPath)).toBe(true);
  });

  it("matches the exact version pinned in package.json", () => {
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["figma-console-mcp"]).toBe(FIGMA_CONSOLE_MCP_VERSION);
  });
});

describe("connectFigmaConsoleMcp over stdio", () => {
  it("calls tools, forwards stderr and closes the server", async () => {
    let stderr = "";
    const client = await connectFigmaConsoleMcp({ args: [FAKE_SERVER], onStderr: (s) => (stderr += s) });
    try {
      const status = textOf(await client.callTool("figma_get_status", { probe: true }));
      expect(status).toMatchObject({ currentFileKey: "kJFoXNrTfFOtkQ515c0jHk", setup: { probeResult: { success: true } } });

      const exec = await client.callTool("figma_execute", { code: "return 1", timeout: 5000, fileKey: "k" }, { timeoutMs: 10_000 });
      expect(exec.isError).toBeUndefined();
      expect(textOf(exec)).toMatchObject({ success: true, result: { codeLength: 8, timeout: 5000, fileKey: "k" } });
      expect(stderr).toContain("fake figma-console-mcp ready");
      expect(client.closed).toBe(false);
    } finally {
      await client.close();
    }
    expect(client.closed).toBe(true);
    await expect(client.callTool("figma_get_status", {})).rejects.toThrow();
  }, 30_000);

  it("passes isError replies through", async () => {
    const client = await connectFigmaConsoleMcp({ args: [FAKE_SERVER], env: { FAKE_FIGMA_MODE: "disconnected" } });
    try {
      const exec = await client.callTool("figma_execute", { code: "return 1" });
      expect(exec.isError).toBe(true);
      expect(textOf(exec)).toMatchObject({ error: "Cannot connect to Figma Desktop." });
    } finally {
      await client.close();
    }
  }, 30_000);

  it("rejects when the server does not start, with its last stderr lines", async () => {
    await expect(
      connectFigmaConsoleMcp({ args: ["-e", "process.stderr.write('boom: no plugin dir\\n'); process.exit(3)"], connectTimeoutMs: 5000 }),
    ).rejects.toThrow(/figma-console-mcp did not start/);
  }, 30_000);
});
