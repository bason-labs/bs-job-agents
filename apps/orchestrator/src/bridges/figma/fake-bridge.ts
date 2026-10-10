// Test support: a fake figma-console-mcp client. Replies have the exact shapes of
// figma-console-mcp 1.40.9. `figma_execute` code is answered by a scripted handler for its
// bridge op (see plugin-code.ts), or run against a FakeFigmaApi document when one is given.
// Use it with `new FigmaBridge({ connect: async () => fake })`.
import { DEFAULT_CV_FILE_KEY } from "./constants.js";
import { runPluginCode, type FakeFigmaApi } from "./fake-figma-api.js";
import type { FigmaMcpClient, McpToolResult } from "./mcp.js";
import { bridgeOpOf } from "./plugin-code.js";

export interface FakeFigmaFile {
  fileKey: string;
  fileName: string;
  active?: boolean;
}

export interface FakeFigmaMcpOptions {
  /** Document mode: figma_execute runs the code against this fake document. */
  api?: FakeFigmaApi;
  /** Figma desktop open with the Desktop Bridge plugin running (default true). */
  connected?: boolean;
  fileKey?: string;
  fileName?: string;
  /** Other files with the plugin open. */
  otherFiles?: FakeFigmaFile[];
}

export type FakeExecuteHandler = (code: string, args: Record<string, unknown>) => unknown;

const json = (value: unknown, isError = false): McpToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  ...(isError ? { isError: true } : {}),
});

export class FakeFigmaMcp implements FigmaMcpClient {
  /** Figma desktop and the plugin are reachable. */
  connected: boolean;
  /** The plugin runs in the CV file (false: only `otherFiles` are open). */
  cvFileOpen = true;
  otherFiles: FakeFigmaFile[];
  readonly fileKey: string;
  readonly fileName: string;
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  private isClosed = false;
  private readonly ops = new Map<string, FakeExecuteHandler>();
  private readonly tools = new Map<string, (args: Record<string, unknown>) => McpToolResult | Promise<McpToolResult>>();
  private readonly failures: Error[] = [];

  constructor(private readonly opts: FakeFigmaMcpOptions = {}) {
    this.connected = opts.connected ?? true;
    this.fileKey = opts.fileKey ?? opts.api?.fileKey ?? DEFAULT_CV_FILE_KEY;
    this.fileName = opts.fileName ?? opts.api?.root.name ?? "Resume (Community) V2";
    this.otherFiles = opts.otherFiles ?? [];
  }

  get closed(): boolean {
    return this.isClosed;
  }

  /** Scripted figma_execute reply for one bridge op ("export-pdf", …) or "custom" for other code. Throw to fail the call. */
  onOp(op: string, handler: FakeExecuteHandler): this {
    this.ops.set(op, handler);
    return this;
  }

  /** Raw reply for a whole tool, replacing the default behaviour. */
  onTool(name: string, handler: (args: Record<string, unknown>) => McpToolResult | Promise<McpToolResult>): this {
    this.tools.set(name, handler);
    return this;
  }

  /** The next callTool rejects with this error (e.g. a transport failure or request timeout). */
  failNextCall(err: Error): this {
    this.failures.push(err);
    return this;
  }

  /** figma_execute calls with their bridge op. */
  executeCalls(): Array<{ op: string; code: string; args: Record<string, unknown> }> {
    return this.calls
      .filter((c) => c.name === "figma_execute")
      .map((c) => ({ op: bridgeOpOf(String(c.args.code)) ?? "custom", code: String(c.args.code), args: c.args }));
  }

  private files(): FakeFigmaFile[] {
    if (!this.connected) return [];
    const others = this.otherFiles;
    const cv = this.cvFileOpen ? [{ fileKey: this.fileKey, fileName: this.fileName, active: !others.some((f) => f.active) }] : [];
    return [...cv, ...others];
  }

  private statusReply(probe: boolean): McpToolResult {
    const files = this.files();
    const active = files.find((f) => f.active) ?? files[0];
    return json({
      mode: "local",
      currentFileName: active?.fileName ?? "(unable to retrieve - Desktop Bridge may need to be opened)",
      currentFileKey: active?.fileKey,
      transport: {
        active: files.length > 0 ? "websocket" : "none",
        websocket: {
          available: files.length > 0,
          serverRunning: true,
          port: "9223",
          connectedFiles: files.length > 0 ? files.map((f) => ({ fileName: f.fileName, fileKey: f.fileKey, isActive: f === active })) : undefined,
        },
      },
      setup: {
        valid: files.length > 0,
        failureLayer: files.length > 0 ? null : 2,
        probeResult: probe ? { success: files.length > 0, latencyMs: 7 } : undefined,
        message: files.length > 0 ? "✅ Connected to Figma Desktop via WebSocket Bridge" : "❌ No connection to Figma Desktop",
      },
      initialized: files.length > 0,
      timestamp: Date.now(),
    });
  }

  private async executeReply(args: Record<string, unknown>): Promise<McpToolResult> {
    const files = this.files();
    if (files.length === 0) {
      return json(
        {
          error: "Cannot connect to Figma Desktop.\n\nOpen the Desktop Bridge plugin in Figma (Plugins → Development → Figma Desktop Bridge).",
          message: "Failed to execute code in Figma plugin context",
          hint: "Make sure the Desktop Bridge plugin is running in Figma",
        },
        true,
      );
    }
    const target = typeof args.fileKey === "string" ? files.find((f) => f.fileKey === args.fileKey) : (files.find((f) => f.active) ?? files[0]);
    if (!target) {
      return json(
        {
          error: "No WebSocket client connected. Make sure the Desktop Bridge plugin is open in Figma.",
          message: "Failed to execute code in Figma plugin context",
        },
        true,
      );
    }
    const code = String(args.code ?? "");
    const op = bridgeOpOf(code) ?? "custom";
    const handler = this.ops.get(op);
    let result: unknown;
    try {
      if (handler) result = await handler(code, args);
      else if (this.opts.api && target.fileKey === this.fileKey) result = await runPluginCode(this.opts.api, code);
      else throw new Error(`FakeFigmaMcp: no reply scripted for op "${op}"`);
    } catch (err) {
      const e = err as Error;
      return json({ success: false, error: `${e.name ?? "Error"}: ${e.message}`, timestamp: Date.now() });
    }
    return json({
      success: true,
      result,
      resultAnalysis: { type: typeof result, isNull: result === null, isUndefined: result === undefined, isEmpty: false, warning: null },
      fileContext: { fileName: target.fileName, fileKey: target.fileKey },
      timestamp: Date.now(),
    });
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    if (this.isClosed) throw new Error("Not connected");
    this.calls.push({ name, args });
    const failure = this.failures.shift();
    if (failure) throw failure;
    const scripted = this.tools.get(name);
    if (scripted) return scripted(args);
    if (name === "figma_get_status") return this.statusReply(args.probe === true);
    if (name === "figma_execute") return this.executeReply(args);
    return json({ error: `FakeFigmaMcp: unknown tool ${name}` }, true);
  }

  async close(): Promise<void> {
    this.isClosed = true;
  }
}
