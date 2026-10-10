import { describe, expect, it } from "vitest";
import { HealthSchema, PACKAGE_NAME } from "./index.js";

describe("@bs-job-agents/shared", () => {
  it("exposes its package name", () => {
    expect(PACKAGE_NAME).toBe("@bs-job-agents/shared");
  });

  it("validates a health payload with zod", () => {
    expect(HealthSchema.parse({ ok: true })).toEqual({ ok: true });
    expect(HealthSchema.safeParse({ ok: "yes" }).success).toBe(false);
  });
});
