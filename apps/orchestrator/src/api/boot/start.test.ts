import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HealthStatusSchema, OrchestratorStatusSchema } from "@bs-job-agents/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FigmaBridge } from "../../bridges/index.js";
import { findRepoRoot, resolveConfig, type OrchestratorConfig } from "../../config.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { listMessages, listRooms, openDb, updateBot } from "../../db/index.js";
import { LeadMcpRunner, ORCHESTRATOR_TOOLS } from "../../mcp/index.js";
import { FakeBrowserProbe, FakeFigmaPort, FakeRunner, MemoryFileStore, defaultFakeResult } from "../../engine/testing/index.js";
import { startOrchestrator, type Orchestrator, type StartOptions } from "./start.js";

const ROOT = findRepoRoot();
const temps: string[] = [];
const running: Orchestrator[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "bsja-boot-"));
  temps.push(dir);
  return dir;
}

/** A data folder, a copy of bots/ and the repo's workflows/, in a temp dir. */
function setup(over: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  const root = tempRoot();
  const botsDir = join(root, "bots");
  cpSync(join(ROOT, "bots"), botsDir, { recursive: true });
  return { ...resolveConfig({}), port: 0, dataDir: join(root, "data"), botsDir, workflowsDir: join(ROOT, "workflows"), ...over };
}

function fakes(): Pick<StartOptions, "runners" | "figma" | "browser" | "lockWaitMs" | "shutdownGraceMs" | "notify" | "guidance"> {
  const runner = new FakeRunner();
  // CV guidance pages are never fetched from the network in tests.
  const guidance = { fetch: { fetchPages: async (reqs: readonly { url: string }[]) => reqs.map((r) => ({ url: r.url, status: "not_modified" as const })) } };
  return { runners: { claude: runner, codex: runner }, figma: new FakeFigmaPort(new MemoryFileStore()), browser: new FakeBrowserProbe(), lockWaitMs: 0, shutdownGraceMs: 1000, notify: null, guidance };
}

async function start(config: OrchestratorConfig, extra: Partial<StartOptions> = {}): Promise<Orchestrator> {
  const orch = await startOrchestrator({ config, ...fakes(), ...extra });
  running.push(orch);
  return orch;
}

function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => (body += c.toString("utf8")));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function httpPost(port: number, path: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: { host: `127.0.0.1:${port}`, origin: "http://localhost:3000", "x-bsja-csrf": "1", "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
      },
      (res) => {
        let text = "";
        res.on("data", (c: Buffer) => (text += c.toString("utf8")));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

afterEach(async () => {
  for (const orch of running.splice(0)) await orch.close();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("startOrchestrator", () => {
  it("opens data/app.db, starts the engine, creates the Lead chat and listens on 127.0.0.1 only", async () => {
    const config = setup();
    const orch = await start(config);
    expect(orch.ctx.state.state).toBe("running");
    expect(existsSync(join(config.dataDir, "app.db"))).toBe(true);
    expect(listRooms(orch.ctx.db!, { kind: "lead" })).toHaveLength(1);
    const address = await orch.listen();
    const port = orch.port();
    expect(address).toBe(`http://127.0.0.1:${port}`);
    const info = orch.app.server.address();
    expect(typeof info === "object" && info?.address).toBe("127.0.0.1");
    const res = await httpGet(port, "/health");
    expect(res.status).toBe(200);
    expect(HealthStatusSchema.parse(JSON.parse(res.body))).toEqual({ ok: true });
    const status = OrchestratorStatusSchema.parse(JSON.parse((await httpGet(port, "/status")).body));
    expect(status).toMatchObject({ state: "running", dataDir: config.dataDir, recovered: { requeued: 0, exhausted: 0, needsCheck: 0 } });
  });

  it("degraded: a data folder with a space serves /health 503 and creates no database", async () => {
    const root = tempRoot();
    const config = setup({ dataDir: join(root, "my data") });
    const orch = await start(config);
    expect(orch.ctx.state).toMatchObject({ state: "degraded", reason: "data_dir_invalid" });
    expect(orch.ctx.db).toBeNull();
    expect(existsSync(join(root, "my data", "app.db"))).toBe(false);
    const res = await orch.app.inject({ method: "GET", url: "/health", headers: { host: `127.0.0.1:${config.port}` } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ ok: false, reason: "data_dir_invalid" });
    expect(res.json().detail).toMatch(/space/);
  });

  it("degraded: a missing immutability trigger (schema guard) is reported, not a crash", async () => {
    const config = setup();
    mkdirSync(config.dataDir, { recursive: true });
    const db = openDb(join(config.dataDir, "app.db"));
    db.$client.exec("DROP TRIGGER submissions_no_update");
    db.$client.close();
    const orch = await start(config);
    expect(orch.ctx.state).toMatchObject({ state: "degraded", reason: "schema_guard" });
    expect(orch.ctx.state.state === "degraded" && orch.ctx.state.detail).toMatch(/submissions_no_update/);
    expect(orch.ctx.db).toBeNull();
  });

  it("degraded: a ROLE.md changed without a promptVersion bump; reads still work, commands answer 503", async () => {
    const config = setup();
    await (await start(config)).close();
    running.pop();
    writeFileSync(join(config.botsDir, "cv", "ROLE.md"), `${readFileSync(join(config.botsDir, "cv", "ROLE.md"), "utf8")}\nOne more rule.\n`);
    const orch = await start(config);
    expect(orch.ctx.state).toMatchObject({ state: "degraded", reason: "prompt_version_stale" });
    expect(orch.ctx.state.state === "degraded" && orch.ctx.state.detail).toMatch(/bots\/cv\/ROLE\.md changed/);
    const host = { host: `127.0.0.1:${config.port}` };
    expect((await orch.app.inject({ method: "GET", url: "/runs", headers: host })).statusCode).toBe(200);
    const startRun = await orch.app.inject({
      method: "POST",
      url: "/runs",
      headers: { ...host, origin: "http://localhost:3000", "x-bsja-csrf": "1", "content-type": "application/json" },
      payload: JSON.stringify({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }),
    });
    expect(startRun.statusCode).toBe(503);
  });

  it("PM3 M1 degraded: a DB row that already has Lead on Codex refuses to start the engine (rule 5); Ba can switch it back", async () => {
    const config = setup();
    await (await start(config)).close();
    running.pop();
    const db = openDb(join(config.dataDir, "app.db"));
    updateBot(db, "lead", { engine: "codex" });
    db.$client.close();
    const orch = await start(config);
    expect(orch.ctx.state).toMatchObject({ state: "degraded", reason: "bots_invalid" });
    expect(orch.ctx.state.state === "degraded" && orch.ctx.state.detail).toMatch(/Lead must run on Claude.*switch it back to Claude/);
    const back = await orch.app.inject({
      method: "PATCH",
      url: "/bots/lead",
      headers: { host: `127.0.0.1:${config.port}`, origin: "http://localhost:3000", "x-bsja-csrf": "1", "content-type": "application/json" },
      payload: JSON.stringify({ engine: "claude" }),
    });
    expect(back.statusCode).toBe(200);
    await orch.close();
    running.pop();
    expect((await start(config)).ctx.state.state).toBe("running");
  });

  it("degraded: an invalid workflow file and a missing bots folder name their reason", async () => {
    const root = tempRoot();
    const wf = join(root, "workflows");
    mkdirSync(wf);
    writeFileSync(join(wf, "job-scan.yaml"), "name: job-scan\nversion: 1\ntriggers: [chat]\nsteps: []\n");
    expect((await start(setup({ workflowsDir: wf }))).ctx.state).toMatchObject({ state: "degraded", reason: "workflows_invalid" });
    expect((await start(setup({ botsDir: join(root, "no-bots") }))).ctx.state).toMatchObject({ state: "degraded", reason: "bots_invalid" });
  });

  it("refuses a second orchestrator on the same data folder (locks live in memory)", async () => {
    const config = setup();
    await start(config);
    await expect(start(config)).rejects.toThrow(/another orchestrator/);
    expect(existsSync(join(config.dataDir, "orchestrator.lock"))).toBe(true);
  });

  it("owns the default Figma bridge and stops it at shutdown (its MCP server is a child process)", async () => {
    const config = setup();
    const { figma: _figma, ...noFigma } = fakes();
    const orch = await startOrchestrator({ config, ...noFigma });
    const bridge = orch.ctx.engine!.deps.figma as FigmaBridge;
    expect(bridge).toBeInstanceOf(FigmaBridge);
    const stop = vi.spyOn(bridge, "stop");
    await orch.close();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("S17 + S20 end to end: a chat message runs Lead with its own capability on the live MCP server; tools work, the reply is stored", async () => {
    const config = setup();
    const seen: { tools: string[]; url: string } = { tools: [], url: "" };
    const orch = await start(config, {
      runners: ({ capabilities, server }) => {
        const fakeRunner = new FakeRunner({ engine: "claude" });
        const lead = new LeadMcpRunner(fakeRunner, {
          capabilities,
          server,
          // Stands in for `claude -p` with the per-spawn mcp.json: it calls the tools over HTTP.
          spawnRunner: (cfg) => ({
            engine: "claude",
            run: async (task) => {
              seen.url = (cfg as { url: string }).url;
              const client = new Client({ name: "fake-claude", version: "1" });
              await client.connect(new StreamableHTTPClientTransport(new URL(seen.url)));
              seen.tools = (await client.listTools()).tools.map((t) => t.name);
              await client.callTool({ name: "message_user", arguments: { text: "Looking at your criteria…" } });
              await client.close();
              return defaultFakeResult(task);
            },
          }),
        });
        return { claude: lead, codex: fakeRunner };
      },
    });
    const port = Number(new URL(await orch.listen()).port);
    const room = listRooms(orch.ctx.db!, { kind: "lead" })[0]!;
    const res = await httpPost(port, "/chat/messages", { roomId: String(room.id), text: "what can you do?", uploadIds: [] });
    expect(res.status).toBe(201);
    await orch.ctx.engine!.idle();
    expect(seen.tools.sort()).toEqual([...ORCHESTRATOR_TOOLS].sort());
    expect(seen.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/[A-Za-z0-9_-]{43}$/);
    expect(orch.ctx.capabilities?.size()).toBe(0);
    const texts = listMessages(orch.ctx.db!, room.id).map((m) => [m.author, m.text]);
    expect(texts.map(([a]) => a)).toEqual(["ba", "lead", "lead"]);
    expect(texts[1]![1]).toBe("Looking at your criteria…");
    // The capability died with the spawn.
    const after = new Client({ name: "late", version: "1" });
    await expect(after.connect(new StreamableHTTPClientTransport(new URL(seen.url)))).rejects.toThrow();
  });

  it("close() stops the engine, closes the database and releases the data folder", async () => {
    const config = setup();
    const orch = await start(config);
    await orch.listen();
    await orch.close();
    running.pop();
    expect(existsSync(join(config.dataDir, "orchestrator.lock"))).toBe(false);
    expect(() => orch.ctx.db!.$client.prepare("SELECT 1").get()).toThrow();
    // The folder is free again.
    await start(config);
  });
});
