// Test fixture: a stand-in for figma-console-mcp over stdio. It never talks to Figma.
// FAKE_FIGMA_MODE=connected (default) | disconnected
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const connected = (process.env.FAKE_FIGMA_MODE ?? "connected") === "connected";
const server = new McpServer({ name: "fake-figma-console-mcp", version: "0.0.0" });

const text = (value, isError = false) => ({ content: [{ type: "text", text: JSON.stringify(value) }], ...(isError ? { isError } : {}) });

server.tool("figma_get_status", "Fake status", { probe: z.boolean().optional() }, async ({ probe }) =>
  text({
    mode: "local",
    currentFileName: connected ? "Resume (Community) V2" : "(unable to retrieve - Desktop Bridge may need to be opened)",
    currentFileKey: connected ? "kJFoXNrTfFOtkQ515c0jHk" : undefined,
    transport: { active: connected ? "websocket" : "none", websocket: { available: connected, serverRunning: true } },
    setup: { valid: connected, probeResult: probe ? { success: connected, latencyMs: 4 } : undefined },
  }),
);

server.tool(
  "figma_execute",
  "Fake execute",
  { code: z.string(), timeout: z.number().optional(), fileKey: z.string().optional() },
  async ({ code, timeout, fileKey }) =>
    connected
      ? text({
          success: true,
          result: { codeLength: code.length, timeout: timeout ?? null, fileKey: fileKey ?? null },
          fileContext: { fileName: "Resume (Community) V2", fileKey: "kJFoXNrTfFOtkQ515c0jHk" },
        })
      : text({ error: "Cannot connect to Figma Desktop.", message: "Failed to execute code in Figma plugin context" }, true),
);

await server.connect(new StdioServerTransport());
process.stderr.write("fake figma-console-mcp ready\n");
