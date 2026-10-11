// Phase 3 QA: "That was me — retry" on Lead's protected-page alert (choice `figma-change:<taskId>`,
// PM2 S8) goes to engine.protectedChangeWasBa: CV's demotion is undone and the failed step runs
// again. It is an answer to the engine, not a request for Lead, so no lead.chat task is queued.
import { ChatSendResultSchema } from "@bs-job-agents/shared";
import { afterEach, describe, expect, it } from "vitest";
import { getBot, latestBotDemotion } from "../../db/index.js";
import { defaultFakeResult } from "../../engine/testing/index.js";
import type { RunnerTask } from "../../runner/types.js";
import { createApiHarness, type ApiHarness } from "../testing.js";

let h: ApiHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

async function protectedPageChanged() {
  h = await createApiHarness();
  const x = h;
  x.t.runner.script({
    bot: "cv",
    kind: "tailor",
    times: 1,
    result: (task: RunnerTask) => {
      x.t.figma.changeProtectedText("Edited by someone");
      return defaultFakeResult(task);
    },
  });
  await x.post("/runs", { workflow: "job-scan", params: { searchProfileId: null, overrides: null } });
  await x.t.idle();
  const cvTask = x.t.tasks("cv.tailor")[0]!;
  const alert = x.t.events("message.created").find((e) => e.message.cards.some((c) => c.type === "choice" && c.key === `figma-change:${cvTask.id}`))!;
  expect(getBot(x.t.db, "cv")?.trustLevel).toBe(1);
  return { x, cvTask, alert };
}

describe("POST /chat/choices figma-change:<taskId> (PM2 S8)", () => {
  it("was_me restores CV and retries the step through the engine; Lead gets no chat task", async () => {
    const { x, cvTask, alert } = await protectedPageChanged();
    const res = await x.post("/chat/choices", { messageId: alert.message.id, key: `figma-change:${cvTask.id}`, optionId: "was_me" });
    expect(res.statusCode).toBe(201);
    const body = ChatSendResultSchema.parse(res.json());
    expect(body.taskIds).toEqual([]);
    expect(body.message).toMatchObject({ author: { type: "ba" }, text: "That was me — retry" });
    await x.t.idle();
    expect(getBot(x.t.db, "cv")?.trustLevel).toBe(2);
    expect(latestBotDemotion(x.t.db, "cv")).toBeUndefined();
    expect(x.t.runner.callsFor("cv.tailor")).toHaveLength(2);
    expect(x.t.tasks("lead.chat")).toEqual([]);
    // The card is settled, so a second click is a conflict.
    const again = await x.post("/chat/choices", { messageId: alert.message.id, key: `figma-change:${cvTask.id}`, optionId: "was_me" });
    expect(again.statusCode).toBe(409);
  });

  it("a figma-change key naming another task than its card's is refused (404) and changes nothing", async () => {
    const { x, alert } = await protectedPageChanged();
    const res = await x.post("/chat/choices", { messageId: alert.message.id, key: "figma-change:999", optionId: "was_me" });
    expect(res.statusCode).toBe(404);
    expect(getBot(x.t.db, "cv")?.trustLevel).toBe(1);
  });
});
