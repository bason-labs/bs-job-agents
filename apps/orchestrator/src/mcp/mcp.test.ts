// PM2 S17: the orchestrator MCP server, driven over real loopback HTTP by the MCP SDK client while a
// FakeRunner Lead task runs (no CLI is ever spawned).
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { LeadChatInput } from "@bs-job-agents/shared";
import { afterEach, describe, expect, it } from "vitest";
import { getOrCreateLeadRoom, getRun, getTask, listMessages, listTasks } from "../db/index.js";
import { createTestEngine, defaultFakeResult, type TestEngine } from "../engine/testing/index.js";
import type { RunnerTask } from "../runner/index.js";
import { ProposalStore } from "../api/proposals.js";
import { CapabilityStore, type Capability } from "./capabilities.js";
import { startMcpServer, type OrchestratorMcpServer } from "./server.js";
import { MESSAGE_USER_CAP, ORCHESTRATOR_TOOLS } from "./tools.js";

interface Bed {
  t: TestEngine;
  caps: CapabilityStore;
  proposals: ProposalStore;
  mcp: OrchestratorMcpServer;
  dataDir: string;
  /** Run `fn` inside a running lead.chat task, with a capability minted for it. */
  duringLead(fn: (ctx: { client: Client; token: string; cap: Capability; task: RunnerTask }) => Promise<void>, opts?: { mode?: "work" | "consult" | "discussion" }): Promise<void>;
  close(): Promise<void>;
}

let bed: Bed | null = null;
afterEach(async () => {
  await bed?.close();
  bed = null;
});

async function connect(url: string): Promise<Client> {
  const client = new Client({ name: "test-lead", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

async function createBed(): Promise<Bed> {
  const t = await createTestEngine();
  const dataDir = mkdtempSync(join(tmpdir(), "bsja-mcp-"));
  const caps = new CapabilityStore();
  const proposals = new ProposalStore({ dataDir, now: () => t.clock.now(), workflows: () => t.engine.deps.workflows });
  const mcp = await startMcpServer({ capabilities: caps, tools: () => ({ engine: t.engine, proposals, capabilities: caps }) });
  const room = getOrCreateLeadRoom(t.db);
  const b: Bed = {
    t,
    caps,
    proposals,
    mcp,
    dataDir,
    async duringLead(fn, opts = {}) {
      let failure: unknown = null;
      t.runner.script({
        bot: "lead",
        kind: "chat",
        times: 1,
        result: async (task) => {
          const token = caps.mint({ taskId: task.taskId, attempt: task.attempt, caller: { botName: "lead", mode: opts.mode ?? "work" }, roomId: room.id, ttlMs: 60_000 });
          const client = await connect(mcp.url(token));
          try {
            await fn({ client, token, cap: caps.resolve(token)!, task });
          } catch (err) {
            failure = err;
          } finally {
            await client.close();
            caps.revoke(token);
          }
          return defaultFakeResult(task);
        },
      });
      const input: LeadChatInput = { roomId: String(room.id), messageId: "1", text: "hi", history: [], uploadIds: [], handoff: null };
      t.engine.enqueueConversation({ bot: "lead", kind: "chat", input });
      await t.idle();
      if (failure) throw failure;
    },
    async close() {
      t.engine.stop();
      await mcp.close();
      t.db.$client.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
  bed = b;
  return b;
}

const text = (r: unknown): string => ((r as { content: { text: string }[] }).content[0]?.text ?? "");
const json = (r: unknown): Record<string, unknown> => JSON.parse(text(r)) as Record<string, unknown>;

/** A raw HTTP request to the MCP listener (headers the SDK client would never send). */
function raw(port: number, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: opts.method ?? "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...opts.headers } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    if (opts.method === "GET") req.end();
    else req.end(opts.body ?? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
  });
}

describe("CapabilityStore (per-spawn capability)", () => {
  it("mints a distinct 256-bit token per spawn, resolves it to its caller, and forgets it on revoke or expiry", () => {
    let now = 1_000;
    const caps = new CapabilityStore({ now: () => now });
    const a = caps.mint({ taskId: 1, attempt: 1, caller: { botName: "lead", mode: "work" }, roomId: 3, ttlMs: 500 });
    const b = caps.mint({ taskId: 2, attempt: 1, caller: { botName: "lead", mode: "work" }, roomId: 3, ttlMs: 500 });
    expect(a).not.toBe(b);
    expect(Buffer.from(a, "base64url")).toHaveLength(32);
    expect(caps.resolve(a)).toMatchObject({ taskId: 1, caller: { botName: "lead", mode: "work" }, roomId: 3 });
    caps.revoke(a);
    expect(caps.resolve(a)).toBeNull();
    now += 500;
    expect(caps.resolve(b)).toBeNull();
    expect(caps.size()).toBe(0);
    expect(caps.resolve("not-a-token")).toBeNull();
  });
});

describe("orchestrator MCP server (S17)", () => {
  it("lists exactly Lead's six tools; there is no tool that answers Apply's questions or approves", async () => {
    const b = await createBed();
    await b.duringLead(async ({ client }) => {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([...ORCHESTRATOR_TOOLS].sort());
      expect(tools.map((t) => t.name)).not.toContain("answer_question");
    });
  });

  it("start_workflow starts a run as Lead and records it for the delegation trace", async () => {
    const b = await createBed();
    let taskId = 0;
    await b.duringLead(async ({ client, task }) => {
      taskId = task.taskId;
      const r = await client.callTool({ name: "start_workflow", arguments: { workflow: "job-scan", params: { searchProfileId: null, overrides: null } } });
      expect(r.isError).toBeFalsy();
      expect(json(r)).toEqual({ started: true, runId: "1" });
    });
    expect(getRun(b.t.db, 1)?.trigger).toBe("chat");
    expect(b.caps.takeActions(taskId)).toEqual([{ type: "start_workflow", workflow: "job-scan", runId: 1 }]);
  });

  it("PM3 S4: get_status lists a saved preset and start_workflow starts it by name with its params", async () => {
    const b = await createBed();
    const p = b.proposals.propose(
      { name: "danang-react", description: "React jobs in Đà Nẵng", basedOn: "job-scan", params: { searchProfileId: null, overrides: { locations: ["Đà Nẵng"] } } },
      { taskId: null },
    );
    b.proposals.approve(p.id, b.t.db);
    let taskId = 0;
    await b.duringLead(async ({ client, task }) => {
      taskId = task.taskId;
      const status = json(await client.callTool({ name: "get_status", arguments: {} })) as { presets: Array<{ name: string }> };
      expect(status.presets.map((x) => x.name)).toEqual(["danang-react"]);
      const r = await client.callTool({ name: "start_workflow", arguments: { workflow: "danang-react", params: {} } });
      expect(r.isError).toBeFalsy();
      expect(json(r)).toEqual({ started: true, runId: "1" });
    });
    expect(getRun(b.t.db, 1)).toMatchObject({ workflowName: "job-scan", presetName: "danang-react", params: { overrides: { locations: ["Đà Nẵng"] } } });
    expect(b.caps.takeActions(taskId)).toEqual([{ type: "start_workflow", workflow: "danang-react", runId: 1 }]);
  });

  it("start_workflow input is validated (a private URL is refused); nothing starts", async () => {
    const b = await createBed();
    await b.duringLead(async ({ client }) => {
      const r = await client.callTool({ name: "start_workflow", arguments: { workflow: "apply-to-link", params: { url: "http://192.168.1.1/job" } } });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/invalid/);
    });
    expect(getRun(b.t.db, 1)).toBeUndefined();
  });

  it("create_task makes research tasks only; an outward-facing task is refused with a safety event (rule 5)", async () => {
    const b = await createBed();
    await b.duringLead(async ({ client }) => {
      const ok = await client.callTool({ name: "create_task", arguments: { bot: "research", kind: "single", input: { url: "https://itviec.com/it-jobs/frontend-novapay" } } });
      expect(ok.isError).toBeFalsy();
      const apply = await client.callTool({ name: "create_task", arguments: { bot: "apply", kind: "submit", input: {} } });
      expect(apply.isError).toBe(true);
      expect(text(apply)).toMatch(/outward-facing/);
      const cv = await client.callTool({ name: "create_task", arguments: { bot: "cv", kind: "tailor", input: {} } });
      expect(cv.isError).toBe(true);
    });
    expect(b.t.tasks("apply.submit")).toEqual([]);
    expect(b.t.tasks("cv.tailor")).toEqual([]);
    expect(b.t.tasks("research.single")).toHaveLength(1);
    expect(b.t.events("safety.denied")).toEqual([expect.objectContaining({ botName: "lead", reason: "trust_level", action: "create_task apply.submit" })]);
  });

  it("get_status and get_result answer from stored data", async () => {
    const b = await createBed();
    await b.duringLead(async ({ client, task }) => {
      const status = json(await client.callTool({ name: "get_status", arguments: {} }));
      expect(status).toHaveProperty("runs");
      const result = json(await client.callTool({ name: "get_result", arguments: { taskId: String(task.taskId) } }));
      expect(result).toMatchObject({ taskId: String(task.taskId), status: "running", output: null });
    });
  });

  it("a consult or room capability lists no tools, and its calls are refused with a safety event (rule 1)", async () => {
    const b = await createBed();
    await b.duringLead(
      async ({ client }) => {
        expect((await client.listTools()).tools).toEqual([]);
        const r = await client.callTool({ name: "start_workflow", arguments: { workflow: "job-scan", params: { searchProfileId: null, overrides: null } } });
        expect(r.isError).toBe(true);
        const m = await client.callTool({ name: "message_user", arguments: { text: "hello" } });
        expect(m.isError).toBe(true);
      },
      { mode: "consult" },
    );
    expect(getRun(b.t.db, 1)).toBeUndefined();
    expect(b.t.events("safety.denied").map((e) => e.reason)).toEqual(["consult_mode", "consult_mode"]);
  });

  it("message_user posts a Lead message in the conversation's room, at most MESSAGE_USER_CAP per spawn", async () => {
    const b = await createBed();
    const room = getOrCreateLeadRoom(b.t.db);
    await b.duringLead(async ({ client }) => {
      for (let i = 0; i < MESSAGE_USER_CAP; i++) {
        const r = await client.callTool({ name: "message_user", arguments: { text: `step ${i}` } });
        expect(r.isError).toBeFalsy();
      }
      const over = await client.callTool({ name: "message_user", arguments: { text: "one too many" } });
      expect(over.isError).toBe(true);
    });
    const posted = listMessages(b.t.db, room.id).filter((m) => m.text.startsWith("step"));
    expect(posted.map((m) => [m.author, m.text])).toEqual(Array.from({ length: MESSAGE_USER_CAP }, (_, i) => ["lead", `step ${i}`]));
    expect(b.t.events("message.created").filter((e) => e.message.text.startsWith("step"))).toHaveLength(MESSAGE_USER_CAP);
  });

  it("propose_workflow keeps a proposal for Ba and runs nothing; a shipped workflow's name is refused", async () => {
    const b = await createBed();
    await b.duringLead(async ({ client }) => {
      const r = await client.callTool({
        name: "propose_workflow",
        arguments: { name: "weekly-hcm-react", description: "React jobs in HCM, weekly", basedOn: "job-scan", params: { searchProfileId: null, overrides: null } },
      });
      expect(r.isError).toBeFalsy();
      expect(json(r)).toMatchObject({ proposed: true, status: "pending" });
      const shipped = await client.callTool({ name: "propose_workflow", arguments: { name: "job-scan", description: "x", basedOn: "job-scan", params: {} } });
      expect(shipped.isError).toBe(true);
    });
    expect(b.proposals.list()).toEqual([expect.objectContaining({ name: "weekly-hcm-react", status: "pending", savedVersion: null })]);
    expect(getRun(b.t.db, 1)).toBeUndefined();
  });

  it("a call after the task ended is refused (the capability dies with its task)", async () => {
    const b = await createBed();
    let leaked: { token: string; taskId: number } | null = null;
    await b.duringLead(async ({ token, task }) => {
      leaked = { token, taskId: task.taskId };
    });
    expect(getTask(b.t.db, leaked!.taskId)?.status).toBe("done");
    expect(b.caps.resolve(leaked!.token)).toBeNull();
    // Even a capability that was not revoked is useless once its task is no longer running.
    const stale = b.caps.mint({ taskId: leaked!.taskId, attempt: 1, caller: { botName: "lead", mode: "work" }, roomId: null, ttlMs: 60_000 });
    const client = await connect(b.mcp.url(stale));
    const r = await client.callTool({ name: "start_workflow", arguments: { workflow: "job-scan", params: { searchProfileId: null, overrides: null } } });
    await client.close();
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/no longer running/);
    expect(listTasks(b.t.db).filter((t) => t.runId !== null)).toEqual([]);
  });

  it("refuses an unknown token (404), a browser Origin, a foreign Host (403) and GET (405)", async () => {
    const b = await createBed();
    const port = b.mcp.port();
    const token = b.caps.mint({ taskId: 1, attempt: 1, caller: { botName: "lead", mode: "work" }, roomId: null, ttlMs: 60_000 });
    expect(await raw(port, "/mcp/not-a-real-token-at-all")).toBe(404);
    expect(await raw(port, `/mcp/${token}`, { headers: { origin: "http://localhost:3000" } })).toBe(403);
    expect(await raw(port, `/mcp/${token}`, { headers: { host: `evil.example:${port}` } })).toBe(403);
    expect(await raw(port, `/mcp/${token}`, { method: "GET" })).toBe(405);
    expect(await raw(port, "/other")).toBe(404);
    // A malformed capability is just not found (no 500, nothing logged as a server error).
    expect(await raw(port, "/mcp/%E0%A4%A")).toBe(404);
    expect(await raw(port, `/mcp/${token}%`)).toBe(404);
  });
});
