// The orchestrator MCP server for Lead (spec §3 rule 5, §4.2; PM2 S17): MCP Streamable HTTP,
// stateless, JSON responses, on its own loopback listener (127.0.0.1, a free port), apart from the
// web API and its browser rules.
// - The only route is POST /mcp/<capability>. The capability is minted per Lead spawn (see
//   capabilities.ts) and is the only credential; an unknown, revoked or expired one is a 404.
// - Host must be this listener's loopback address (DNS rebinding); any Origin header is refused
//   (the CLI sends none, a web page always does on a POST); bodies are JSON, at most 256 KB.
// - One MCP Server per request, bound to the request's capability, so a call can only act as the
//   spawn that holds the token.
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "../engine/index.js";
import type { Capability, CapabilityStore } from "./capabilities.js";
import { TOOL_DEFINITIONS, callTool, type ToolDeps } from "./tools.js";

export const MCP_PATH_PREFIX = "/mcp/";
export const MCP_BODY_LIMIT = 256 * 1024;
export const MCP_SERVER_NAME = "orchestrator";

export interface McpServerDeps {
  capabilities: CapabilityStore;
  /** Late-bound: the engine exists only after the runners (which need this server's URL). */
  tools: () => ToolDeps | null;
  log?: Logger;
}

export interface OrchestratorMcpServer {
  /** http://127.0.0.1:<port>/mcp/<token> for one capability. */
  url(token: string): string;
  port(): number;
  /** The request handler, for tests that drive it without a listener. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  close(): Promise<void>;
}

function send(req: IncomingMessage, res: ServerResponse, status: number, message: string): void {
  if (!req.readableEnded) req.resume();
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MCP_BODY_LIMIT) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** An MCP Server bound to one capability: it lists Lead's tools and runs them as that caller. */
function mcpServerFor(cap: Capability, deps: ToolDeps): Server {
  const server = new Server({ name: MCP_SERVER_NAME, version: "1.0.0" }, { capabilities: { tools: {} } });
  const work = cap.caller.botName === "lead" && cap.caller.mode === "work";
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: work ? TOOL_DEFINITIONS.map((t) => ({ ...t })) : [] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = callTool(deps, cap, request.params.name, request.params.arguments ?? {});
    return { content: result.content, ...(result.isError ? { isError: true } : {}) };
  });
  return server;
}

export async function startMcpServer(deps: McpServerDeps, opts: { host?: "127.0.0.1"; port?: number } = {}): Promise<OrchestratorMcpServer> {
  const host = opts.host ?? "127.0.0.1";
  let port = 0;
  const allowedHosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = req.url ?? "";
      if (!url.startsWith(MCP_PATH_PREFIX)) return send(req, res, 404, "not found");
      const reqHost = (req.headers.host ?? "").toLowerCase();
      if (!allowedHosts().has(reqHost)) return send(req, res, 403, "this server answers only on its loopback address");
      if (req.headers.origin !== undefined) return send(req, res, 403, "browser requests are refused");
      let token: string;
      try {
        token = decodeURIComponent(url.slice(MCP_PATH_PREFIX.length).split("?")[0] ?? "");
      } catch {
        return send(req, res, 404, "not found");
      }
      const cap = deps.capabilities.resolve(token);
      if (!cap) return send(req, res, 404, "not found");
      if (req.method !== "POST") return send(req, res, 405, "only POST (stateless Streamable HTTP)");
      const type = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
      if (type !== "application/json") return send(req, res, 415, "send JSON");
      const text = await readBody(req);
      if (text === null) return send(req, res, 413, "request too large");
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return send(req, res, 400, "invalid JSON");
      }
      const tools = deps.tools();
      if (!tools) return send(req, res, 503, "the orchestrator engine is not running");
      const server = mcpServerFor(cap, tools);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      deps.log?.warn(`orchestrator MCP request failed: ${err instanceof Error ? err.message : String(err)}`);
      send(req, res, 500, "internal error");
    }
  };

  const http: HttpServer = createServer((req, res) => void handle(req, res));
  http.requestTimeout = 120_000;
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(opts.port ?? 0, host, () => {
      http.off("error", reject);
      resolve();
    });
  });
  port = (http.address() as AddressInfo).port;

  return {
    url: (token) => `http://${host}:${port}${MCP_PATH_PREFIX}${encodeURIComponent(token)}`,
    port: () => port,
    handle,
    close: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}
