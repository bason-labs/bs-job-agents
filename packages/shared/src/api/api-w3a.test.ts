// W3a part 2 additions to the shared API (additive): proposals, transcripts, chat results, routes.
import { describe, expect, it } from "vitest";
import { ChatSendResultSchema, ProposeWorkflowInputSchema, WorkflowProposalSchema } from "./chat.js";
import { API_ROUTES, BridgesResponseSchema } from "./common.js";
import { TranscriptQuerySchema, TranscriptResponseSchema } from "./runs.js";

describe("propose_workflow input (rule 3)", () => {
  it("is either a preset of a shipped workflow or a YAML definition, never both or neither", () => {
    expect(ProposeWorkflowInputSchema.safeParse({ name: "weekly-react", description: "x", basedOn: "job-scan", params: {} }).success).toBe(true);
    expect(ProposeWorkflowInputSchema.safeParse({ name: "custom", description: "x", definitionYaml: "name: custom" }).success).toBe(true);
    expect(ProposeWorkflowInputSchema.safeParse({ name: "both", description: "x", basedOn: "job-scan", definitionYaml: "y" }).success).toBe(false);
    expect(ProposeWorkflowInputSchema.safeParse({ name: "neither", description: "x" }).success).toBe(false);
    expect(ProposeWorkflowInputSchema.safeParse({ name: "Bad Name", description: "x", basedOn: "job-scan" }).success).toBe(false);
    expect(ProposeWorkflowInputSchema.safeParse({ name: "x", description: "x", basedOn: "job-scan", extra: 1 }).success).toBe(false);
  });

  it("a stored proposal starts pending with no saved version", () => {
    expect(
      WorkflowProposalSchema.safeParse({
        id: "p1",
        name: "weekly-react",
        description: "x",
        basedOn: "job-scan",
        params: {},
        definitionYaml: null,
        status: "pending",
        taskId: null,
        proposedAt: "2026-10-10T08:00:00.000Z",
        decidedAt: null,
        savedVersion: null,
      }).success,
    ).toBe(true);
  });
});

describe("transcript, chat and bridge shapes", () => {
  it("transcript queries coerce numbers; lines carry their file line number", () => {
    expect(TranscriptQuerySchema.parse({ attempt: "2", after: "10" })).toEqual({ attempt: 2, after: 10 });
    expect(TranscriptQuerySchema.parse({})).toEqual({ after: 0 });
    expect(TranscriptResponseSchema.safeParse({ taskId: "1", attempt: 1, attempts: [1], lines: [{ n: 1, kind: "text", text: "hi" }], nextAfter: 1, truncated: false, running: false }).success).toBe(true);
  });

  it("chat send results list the queued conversation tasks", () => {
    const message = { id: "1", roomId: "1", author: { type: "ba" }, text: "hi", mode: "work", mentions: [], runIds: [], uploadIds: [], cards: [], createdAt: "2026-10-10T08:00:00.000Z", attachments: [] };
    expect(ChatSendResultSchema.safeParse({ message, taskIds: ["4"] }).success).toBe(true);
    expect(BridgesResponseSchema.safeParse({ chrome: [{ engine: "claude", connected: null }], checkedAt: "2026-10-10T08:00:00.000Z" }).success).toBe(true);
  });

  it("API_ROUTES has the part 2 routes", () => {
    expect(API_ROUTES).toMatchObject({
      chatChoices: "/chat/choices",
      taskTranscript: "/tasks/:id/transcript",
      workflowProposals: "/workflow-proposals",
      bridges: "/bridges",
      applicationApplyAgain: "/applications/:id/apply-again",
      criteriaProfiles: "/criteria/profiles",
    });
  });
});
