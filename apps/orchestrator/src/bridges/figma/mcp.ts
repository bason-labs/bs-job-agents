// MCP stdio client for the local figma-console-mcp server (spec §6.2, spike S3b).
// The orchestrator runs its own server instance; the Desktop Bridge plugin in Figma desktop
// connects to every server on ports 9223–9232, so it can coexist with a CV bot's instance.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface McpToolContent {
  type: string;
  text?: string;
}

export interface McpToolResult {
  content: McpToolContent[];
  isError?: boolean;
}

/** The seam the bridge talks to: the real stdio client, or a fake in tests. */
export interface FigmaMcpClient {
  callTool(name: string, args: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<McpToolResult>;
  close(): Promise<void>;
  readonly closed: boolean;
}

export function resolveFigmaConsoleMcp(): { serverPath: string; version: string } {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve("figma-console-mcp/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string; bin?: string | Record<string, string> };
  const bin = typeof pkg.bin === "string" ? pkg.bin : (pkg.bin?.["figma-console-mcp"] ?? "dist/local.js");
  return { serverPath: join(dirname(pkgPath), bin), version: pkg.version };
}

export interface ConnectFigmaMcpOptions {
  /** Program to run (default: this node binary). */
  command?: string;
  /** Arguments (default: figma-console-mcp's dist/local.js). Tests point this at a fake server. */
  args?: string[];
  /** Extra environment for the server. */
  env?: Record<string, string>;
  /** Receives the server's stderr (its logs). The last 16 KiB are kept for error messages either way. */
  onStderr?: (chunk: string) => void;
  /** Handshake time limit (default 20 s). */
  connectTimeoutMs?: number;
}

const STDERR_TAIL = 16 * 1024;

export async function connectFigmaConsoleMcp(opts: ConnectFigmaMcpOptions = {}): Promise<FigmaMcpClient> {
  const args = opts.args ?? [resolveFigmaConsoleMcp().serverPath];
  const transport = new StdioClientTransport({
    command: opts.command ?? process.execPath,
    args,
    // Only the basics plus what we set: the server needs no token (local bridge, no cloud).
    env: { ...getDefaultEnvironment(), LOG_LEVEL: "warn", ...opts.env },
    stderr: "pipe",
  });
  let stderrTail = "";
  // Always drain stderr: an unread pipe would eventually block the server.
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    const text = chunk.toString();
    stderrTail = (stderrTail + text).slice(-STDERR_TAIL);
    opts.onStderr?.(text);
  });

  const client = new Client({ name: "bs-job-agents-orchestrator", version: "0.0.1" });
  let closed = false;
  client.onclose = () => {
    closed = true;
  };
  try {
    await client.connect(transport, { timeout: opts.connectTimeoutMs ?? 20_000 });
  } catch (err) {
    closed = true;
    await transport.close().catch(() => undefined);
    const tail = stderrTail.trim().split("\n").slice(-5).join("\n");
    throw new Error(`figma-console-mcp did not start: ${(err as Error).message}${tail ? `\n${tail}` : ""}`, { cause: err });
  }

  return {
    get closed() {
      return closed;
    },
    async callTool(name, toolArgs, callOpts) {
      const result = await client.callTool(
        { name, arguments: toolArgs },
        undefined,
        callOpts?.timeoutMs ? { timeout: callOpts.timeoutMs } : undefined,
      );
      const content = Array.isArray(result.content) ? (result.content as McpToolContent[]) : [];
      return { content, ...(result.isError === true ? { isError: true } : {}) };
    },
    async close() {
      closed = true;
      await client.close();
    },
  };
}
