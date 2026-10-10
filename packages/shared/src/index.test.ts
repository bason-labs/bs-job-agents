import { describe, expect, it } from "vitest";
import * as fixtures from "./fixtures/index.js";
import * as shared from "./index.js";
import { HealthSchema, PACKAGE_NAME } from "./index.js";

describe("@bs-job-agents/shared", () => {
  it("exposes its package name", () => {
    expect(PACKAGE_NAME).toBe("@bs-job-agents/shared");
  });

  it("validates a health payload with zod", () => {
    expect(HealthSchema.parse({ ok: true })).toEqual({ ok: true });
    expect(HealthSchema.safeParse({ ok: "yes" }).success).toBe(false);
  });

  it("exports the main schemas and helpers from the root entry", () => {
    for (const name of [
      "toStrictJsonSchema",
      "checkStrictJsonSchema",
      "BotDefinitionSchema",
      "getBotOutputJsonSchema",
      "ApplyOutputSchema",
      "SubmissionRecordSchema",
      "SearchProfileSchema",
      "TaskSchema",
      "WorkflowDefinitionSchema",
      "AppEventSchema",
      "ChatSendRequestSchema",
      "ReviewCardSchema",
    ]) {
      expect(shared, name).toHaveProperty(name);
    }
  });

  it("keeps fixtures out of the root entry", () => {
    expect(shared).not.toHaveProperty("applyOutputFixture");
    expect(fixtures).toHaveProperty("applyOutputFixture");
    expect(fixtures).toHaveProperty("sampleEvents");
  });
});
