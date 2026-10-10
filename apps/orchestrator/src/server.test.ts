import { afterEach, describe, expect, it } from "vitest";
import { ApiErrorSchema, HealthStatusSchema, OrchestratorStatusSchema } from "@bs-job-agents/shared";
import { approveApplication } from "./db/index.js";
import { seedCv, seedJob } from "./db/test-helpers.js";
import { createApiHarness, type ApiHarness } from "./api/testing.js";
import { resolvePort, DEFAULT_PORT } from "./config.js";

let h: ApiHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

describe("GET /health and /status (S19)", () => {
  it("health is { ok: true } while the engine runs", async () => {
    h = await createApiHarness();
    const res = await h.get("/health");
    expect(res.statusCode).toBe(200);
    expect(HealthStatusSchema.parse(res.json())).toEqual({ ok: true });
  });

  it("status says running, with the data folder and what start-up recovered", async () => {
    h = await createApiHarness({ state: { state: "running", startedAt: "2026-10-10T08:00:00.000Z", recovered: { requeued: 2, exhausted: 0, needsCheck: 1 } } });
    const res = await h.get("/status");
    expect(res.statusCode).toBe(200);
    expect(OrchestratorStatusSchema.parse(res.json())).toEqual({
      state: "running",
      reason: null,
      detail: null,
      startedAt: "2026-10-10T08:00:00.000Z",
      dataDir: h.dataDir,
      recovered: { requeued: 2, exhausted: 0, needsCheck: 1 },
    });
  });

  it("degraded: health is 503 with the reason and detail, status names them, and engine commands answer 503", async () => {
    const detail = "bots/cv/ROLE.md changed but promptVersion is still 1: bump promptVersion in bots/cv/bot.json";
    h = await createApiHarness({ state: { state: "degraded", reason: "prompt_version_stale", detail, startedAt: "2026-10-10T08:00:00.000Z" } });
    const health = await h.get("/health");
    expect(health.statusCode).toBe(503);
    expect(HealthStatusSchema.parse(health.json())).toEqual({ ok: false, reason: "prompt_version_stale", detail });
    const status = OrchestratorStatusSchema.parse((await h.get("/status")).json());
    expect(status).toMatchObject({ state: "degraded", reason: "prompt_version_stale", detail, recovered: null });
    const control = await h.post("/runs/1/control", { action: "pause" });
    expect(control.statusCode).toBe(503);
    expect(ApiErrorSchema.parse(control.json()).error.message).toContain(detail);
  });

  it("degraded without a database: health and status still answer; data routes answer 503", async () => {
    h = await createApiHarness({
      state: { state: "degraded", reason: "schema_guard", detail: "trigger submissions_no_update is missing", startedAt: "2026-10-10T08:00:00.000Z" },
      context: { db: null, engine: null, events: null },
    });
    expect((await h.get("/health")).statusCode).toBe(503);
    expect((await h.get("/status")).statusCode).toBe(200);
    expect((await h.get("/runs")).statusCode).toBe(503);
  });
});

describe("approval tokens never leave the API (S18)", () => {
  it("a JSON response that would carry a token value is refused with 500", async () => {
    h = await createApiHarness({ beforeReady: (app, ctx) => {
      app.get("/test/echo", async () => {
        const job = seedJob(ctx.db!);
        const cv = seedCv(ctx.db!, job);
        const { approval } = approveApplication(ctx.db!, { jobId: job.id, cvVersionId: cv.id, allowedDomains: ["itviec.com"] });
        return { note: `leaked ${approval.token}` };
      });
    } });
    const res = await h.get("/test/echo");
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toMatch(/[a-f0-9]{64}/);
    expect(ApiErrorSchema.parse(res.json()).error.code).toBe("internal");
  });
});

describe("resolvePort", () => {
  // PM phase 1, S12: 4100 (the spec value); 4318 is the OpenTelemetry OTLP/HTTP port.
  it("defaults to 4100 when ORCH_PORT is unset or empty", () => {
    expect(DEFAULT_PORT).toBe(4100);
    expect(resolvePort({})).toBe(4100);
    expect(resolvePort({ ORCH_PORT: "" })).toBe(4100);
  });

  it("reads ORCH_PORT", () => {
    expect(resolvePort({ ORCH_PORT: "5000" })).toBe(5000);
  });

  it("rejects an invalid ORCH_PORT", () => {
    expect(() => resolvePort({ ORCH_PORT: "abc" })).toThrow(/ORCH_PORT/);
  });
});
