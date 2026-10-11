// API test kit: the real server (buildServer) over a whole test engine (createTestEngine: in-memory
// SQLite, FakeRunner, fake bridges) and a real temporary data/ folder for files. Requests go
// through `inject` with the headers the web app's proxy sends (loopback Host, the web origin and
// the CSRF header on mutations), so every route test also passes the S18 checks.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CSRF_HEADER, CSRF_HEADER_VALUE } from "@bs-job-agents/shared";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { cvOutputFixture } from "@bs-job-agents/shared/fixtures";
import { createCvVersion, recordSubmission, type Application, type Approval, type CvVersion, type Db, type Job } from "../db/index.js";
import { NOVAPAY, T0, seedApprovedApplication, seedJob } from "../db/test-helpers.js";
import { silentLogger } from "../engine/ports.js";
import { createTestEngine, type TestEngine, type TestEngineOptions } from "../engine/testing/index.js";
import { buildServer, type ServerOptions } from "../server.js";
import { CapabilityStore } from "../mcp/capabilities.js";
import { ChatSink } from "./chat/sink.js";
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
  /** The Lead capability log the sink reads (record actions to simulate MCP tool calls). */
  capabilities: CapabilityStore;
  sink: ChatSink;
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

/** File contents with the right magic bytes. */
export const FILE_BYTES = {
  pdf: Buffer.from("%PDF-1.7\n% fake one-page CV\n%%EOF\n"),
  png: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fake png body")]),
  jpeg: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("fake jpeg body")]),
  zip: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("fake zip body")]),
} as const;

/** Write `bytes` at a data/-relative path. */
export function writeDataFile(dataDir: string, rel: string, bytes: Buffer | string): void {
  const abs = join(dataDir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, bytes);
}

/** A CV version as the engine stores it: the PDF at data/pdf/<frame>.pdf, path relative to data/. */
export function seedCvVersion(db: Db, job: Job, opts: { language?: "en" | "vi"; now?: Date; frame?: string; masterVersion?: number } = {}): CvVersion {
  const language = opts.language ?? "en";
  const frame = opts.frame ?? `NOVAPAY_SENIOR-FE_${language.toUpperCase()}_v1`;
  return createCvVersion(
    db,
    {
      jobId: job.id,
      language,
      tailored: cvOutputFixture.tailored,
      figmaFrameName: frame,
      figmaFrameUrl: "https://www.figma.com/design/kJFoXNrTfFOtkQ515c0jHk?node-id=1-2",
      pdfPath: `pdf/${frame}.pdf`,
      pdfSha256: "a".repeat(64),
      changeNotes: ["Led with Next.js and payments work"],
      masterVersion: opts.masterVersion ?? 3,
      promptVersion: 1,
    },
    { now: opts.now ?? T0 },
  );
}

export interface SeededRecord {
  job: Job;
  cv: CvVersion;
  application: Application;
  approval: Approval;
}

/**
 * A submitted application with its §9.1 record (UC-11 step 9) and the record's files in data/:
 * the CV version's PDF (pdf/…), the uploaded copy, both screenshots and the JD page screenshot
 * (applications/<id>/…). `files: false` writes the rows only.
 */
export function seedRecordedApplication(db: Db, dataDir: string, opts: { files?: boolean; now?: Date } = {}): SeededRecord {
  const now = opts.now ?? T0;
  const job = seedJob(db, NOVAPAY, now);
  const cv = seedCvVersion(db, job, { now });
  const { application, approval } = seedApprovedApplication(db, job, cv, { now });
  const dir = `applications/${application.id}`;
  const rec = recordSubmission(
    db,
    {
      applicationId: application.id,
      submission: {
        finalUrl: "https://itviec.com/it-jobs/thanks",
        fields: [{ label: "Full name", name: "name", value: "Ba Huynh", source: "master_cv" }],
        introText: "I build React/Next.js products.",
        consentTicked: true,
        consentText: "I agree to the processing of my personal data.",
        uploadedFilename: "BA_HUYNH_NOVAPAY_EN.pdf",
        uploadedSha256: cv.pdfSha256,
        uploadedPath: `${dir}/BA_HUYNH_NOVAPAY_EN.pdf`,
        preSubmitScreenshotPath: `${dir}/pre-submit.png`,
        confirmationScreenshotPath: `${dir}/confirmation.png`,
        confirmationText: "Thank you for applying",
        approvalToken: approval.token,
        submittedAt: now.toISOString(),
      },
      snapshot: {
        url: NOVAPAY.url!,
        title: NOVAPAY.title,
        company: NOVAPAY.company,
        salaryText: NOVAPAY.salaryText ?? null,
        jdText: "We are looking for a Senior Frontend Engineer to own our React/Next.js apps.",
        pageScreenshotPath: `${dir}/jd.png`,
      },
    },
    { now },
  );
  if (opts.files !== false) {
    writeDataFile(dataDir, "pdf/NOVAPAY_SENIOR-FE_EN_v1.pdf", FILE_BYTES.pdf);
    writeDataFile(dataDir, `${dir}/BA_HUYNH_NOVAPAY_EN.pdf`, FILE_BYTES.pdf);
    writeDataFile(dataDir, `${dir}/pre-submit.png`, FILE_BYTES.png);
    writeDataFile(dataDir, `${dir}/confirmation.png`, FILE_BYTES.png);
    writeDataFile(dataDir, `${dir}/jd.png`, FILE_BYTES.jpeg);
  }
  return { job, cv: { ...cv }, application: rec.application, approval };
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
  // S20: the chat flows' ConversationSink, with the capability log the MCP tools write to.
  const capabilities = new CapabilityStore();
  const sink = new ChatSink({ capabilities });
  const t = await createTestEngine({ conversations: sink, ...opts.engine });
  sink.bind({ now: () => t.clock.now() });
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
    capabilities,
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
    capabilities,
    sink,
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
