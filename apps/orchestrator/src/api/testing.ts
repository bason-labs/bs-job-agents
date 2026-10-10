// API test kit: the real server (buildServer) over a whole test engine (createTestEngine: in-memory
// SQLite, FakeRunner, fake bridges) and a real temporary data/ folder for files. Requests go
// through `inject` with the headers the web app's proxy sends (loopback Host, the web origin and
// the CSRF header on mutations), so every route test also passes the S18 checks.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CSRF_HEADER, CSRF_HEADER_VALUE } from "@bs-job-agents/shared";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { silentLogger } from "../engine/ports.js";
import { createTestEngine, type TestEngine, type TestEngineOptions } from "../engine/testing/index.js";
import { buildServer, type ServerOptions } from "../server.js";
import { engineEventHub, type ApiContext, type OrchestratorState } from "./context.js";

export const TEST_PORT = 4100;
export const TEST_HOST = `127.0.0.1:${TEST_PORT}`;
export const WEB_ORIGIN = "http://localhost:3000";

type Headers = Record<string, string>;
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ApiHarnessOptions {
  engine?: TestEngineOptions;
  state?: OrchestratorState;
  /** Override parts of the context, e.g. `{ db: null }` for a degraded start without a database. */
  context?: Partial<ApiContext>;
  server?: ServerOptions;
  /** Add test-only routes before the server is ready. */
  beforeReady?: (app: FastifyInstance, ctx: ApiContext) => void;
}

export interface ApiHarness {
  t: TestEngine;
  ctx: ApiContext;
  app: FastifyInstance;
  /** The API's real data/ folder (a temp dir; the engine's own files are in memory). */
  dataDir: string;
  botsDir: string;
  workflowsDir: string;
  request(method: Method, url: string, body?: unknown, headers?: Headers): Promise<LightMyRequestResponse>;
  get(url: string, headers?: Headers): Promise<LightMyRequestResponse>;
  post(url: string, body?: unknown, headers?: Headers): Promise<LightMyRequestResponse>;
  put(url: string, body?: unknown, headers?: Headers): Promise<LightMyRequestResponse>;
  patch(url: string, body?: unknown, headers?: Headers): Promise<LightMyRequestResponse>;
  del(url: string, headers?: Headers): Promise<LightMyRequestResponse>;
  close(): Promise<void>;
}

/** Headers the web app's same-origin proxy sends for `method`. */
export function webHeaders(method: Method, hasBody: boolean): Headers {
  const h: Headers = { host: TEST_HOST };
  if (method !== "GET") {
    h.origin = WEB_ORIGIN;
    h[CSRF_HEADER] = CSRF_HEADER_VALUE;
  }
  if (hasBody) h["content-type"] = "application/json";
  return h;
}

export async function createApiHarness(opts: ApiHarnessOptions = {}): Promise<ApiHarness> {
  const t = await createTestEngine(opts.engine);
  const root = mkdtempSync(join(tmpdir(), "bsja-api-"));
  const dataDir = join(root, "data");
  const botsDir = join(root, "bots");
  const workflowsDir = join(root, "workflows");
  for (const dir of [dataDir, botsDir, workflowsDir]) mkdirSync(dir, { recursive: true });
  const ctx: ApiContext = {
    config: { dataDir, botsDir, workflowsDir, port: TEST_PORT, webOrigins: [WEB_ORIGIN, "http://127.0.0.1:3000"] },
    state: opts.state ?? { state: "running", startedAt: t.clock.now().toISOString(), recovered: null },
    db: t.db,
    engine: t.engine,
    bots: t.engine.deps.bots,
    workflows: t.engine.deps.workflows,
    events: engineEventHub(t.engine),
    now: () => t.clock.now(),
    log: silentLogger,
    ...opts.context,
  };
  const app = buildServer(ctx, opts.server);
  opts.beforeReady?.(app, ctx);
  await app.ready();
  const request = (method: Method, url: string, body?: unknown, headers: Headers = {}) =>
    app.inject({
      method,
      url,
      headers: { ...webHeaders(method, body !== undefined), ...headers },
      ...(body !== undefined ? { payload: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    });
  return {
    t,
    ctx,
    app,
    dataDir,
    botsDir,
    workflowsDir,
    request,
    get: (url, headers) => request("GET", url, undefined, headers),
    post: (url, body, headers) => request("POST", url, body, headers),
    put: (url, body, headers) => request("PUT", url, body, headers),
    patch: (url, body, headers) => request("PATCH", url, body, headers),
    del: (url, headers) => request("DELETE", url, undefined, headers),
    close: async () => {
      t.engine.stop();
      await app.close();
      rmSync(root, { recursive: true, force: true });
      t.db.$client.close();
    },
  };
}
