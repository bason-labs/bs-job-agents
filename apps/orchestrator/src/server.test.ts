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
  it("defaults to 4318", () => {
    expect(DEFAULT_PORT).toBe(4318);
    expect(resolvePort({})).toBe(4318);
  });

  it("reads ORCH_PORT", () => {
    expect(resolvePort({ ORCH_PORT: "5000" })).toBe(5000);
  });

  it("rejects an invalid ORCH_PORT", () => {
    expect(() => resolvePort({ ORCH_PORT: "abc" })).toThrow(/ORCH_PORT/);
  });
});
