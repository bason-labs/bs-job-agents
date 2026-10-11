import { API_ROUTES } from "@bs-job-agents/shared";
import { describe, expect, it } from "vitest";
import { apiPath } from "./routes";

describe("apiPath", () => {
  it("fills path params and encodes them", () => {
    expect(apiPath(API_ROUTES.roomMessages, { id: "7" })).toBe("/rooms/7/messages");
    expect(apiPath(API_ROUTES.reviewApprove, { jobId: "job 1/x" })).toBe("/review/job%201%2Fx/approve");
    expect(apiPath(API_ROUTES.answerQuestion, { taskId: "42" })).toBe("/questions/42/answer");
  });

  it("refuses a missing param instead of calling a wrong URL", () => {
    expect(() => apiPath(API_ROUTES.run, {})).toThrow(/missing path param "id"/);
  });

  it("appends a query string, skipping null and undefined", () => {
    expect(apiPath(API_ROUTES.roomMessages, { id: "7" }, { before: "m9", limit: 50, x: undefined, y: null })).toBe(
      "/rooms/7/messages?before=m9&limit=50",
    );
    expect(apiPath(API_ROUTES.files, { id: "f1" }, { download: true })).toBe("/files/f1?download=true");
    expect(apiPath(API_ROUTES.reviewQueue)).toBe("/review");
  });

  it("every route the UI once proposed is in API_ROUTES (W3a part 2, and Don't allow in Phase 3 QA)", () => {
    expect(API_ROUTES).toMatchObject({
      chatChoices: "/chat/choices",
      taskTranscript: "/tasks/:id/transcript",
      taskDeclineDomain: "/tasks/:id/decline-domain",
      engineResume: "/engines/:engine/resume",
    });
  });
});
