import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { HealthSchema } from "@bs-job-agents/shared";
import { buildServer } from "./server.js";
import { resolvePort, DEFAULT_PORT } from "./config.js";

describe("orchestrator server", () => {
  let app: FastifyInstance;
  beforeEach(() => {
    app = buildServer();
  });
  afterEach(async () => {
    await app.close();
  });

  it("GET /health returns { ok: true }", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(HealthSchema.parse(res.json())).toEqual({ ok: true });
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
