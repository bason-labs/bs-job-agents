// Live 2026-10-20: with two Claude in Chrome extensions connected, Apply stopped before doing
// anything ("Two Chrome browsers are connected and none was selected, and I have no tool to select
// one") and the application ended needs_check. The model never chooses a browser: Ba picks the
// one bots use; until then such a task pauses with a notice; an Apply that opened no page of the
// job site is "not sent", never needs_check.
import { applyOutputFixture } from "@bs-job-agents/shared/fixtures";
import { describe, expect, it } from "vitest";
import { getApplication, getPreferredBrowser, getTask, listSeenBrowsers, setPreferredBrowser } from "../db/index.js";
import type { RunnerResult } from "../runner/types.js";
import { fake } from "./testing/fake-runner.js";
import { createTestEngine, type TestEngine } from "./testing/harness.js";

const MAC = { deviceId: "3e83d913-aaaa-4bbb-8ccc-1234567890ab", name: "Ba's MacBook", os: "macOS", isLocal: true };
const PC = { deviceId: "9f00aa11-bbbb-4ccc-8ddd-0987654321ff", name: "Office PC", os: "Windows", isLocal: false };
const tabTools = [
  { type: "tool" as const, name: "mcp__claude-in-chrome__tabs_create_mcp", status: "started" as const, summary: null },
  { type: "tool" as const, name: "mcp__claude-in-chrome__tabs_create_mcp", status: "error" as const, summary: null },
];
const leadTexts = (t: TestEngine) => t.events("message.created").map((e) => e.message).filter((m) => m.author.type === "bot" && m.author.bot === "lead").map((m) => m.text);

async function approved() {
  const t = await createTestEngine({ sources: ["itviec"] });
  const run = t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
  await t.idle();
  const card = t.review(run.id, 1)!;
  const r = t.engine.approve(1, { cvVersionId: card.cvVersions[0]!.cvVersionId, introText: null });
  return { t, applicationId: r.applicationId!, taskId: r.taskId! };
}

/** Apply's attempt when several browsers are connected: only tab tools, then a failed self-check. */
const stuck = (): RunnerResult => ({ ...fake.selfCheckFailed(applyOutputFixture, ["All required fields are filled"]), chromeBrowsers: { several: true, devices: [MAC, PC] } });

describe("several Chrome browsers connected", () => {
  it("the task pauses (not failed, not needs_check) with Lead's notice; the browsers are kept for Ba's choice; Resume runs it again with the chosen browser", async () => {
    const { t, applicationId, taskId } = await approved();
    t.runner.script({ bot: "apply", kind: "submit", times: 1, events: tabTools, result: stuck() });
    await t.idle();
    expect(getTask(t.db, taskId)).toMatchObject({ status: "paused", pauseReason: "browser_choice" });
    expect(getApplication(t.db, applicationId)!.status).not.toBe("needs_check");
    expect(leadTexts(t)).toContain("Two Chrome browsers are connected. Pick the one bots should use on the Bots screen (Chrome browser for bots), or close the other, then press Resume.");
    expect(listSeenBrowsers(t.db).map((b) => b.deviceId).sort()).toEqual([MAC.deviceId, PC.deviceId].sort());

    setPreferredBrowser(t.db, MAC);
    expect(getPreferredBrowser(t.db)).toEqual(MAC);
    t.engine.resumeTask(taskId);
    await t.idle();
    const second = t.runner.callsFor("apply.submit")[1]!;
    expect(second.chromeBrowserId).toBe(MAC.deviceId);
    expect(JSON.stringify(second.hookSettings)).toContain(`--browser ${MAC.deviceId}`);
  });

  it("a browser task without the choice gets no select_browser and no browser id", async () => {
    const { t } = await approved();
    await t.idle();
    const call = t.runner.callsFor("apply.submit")[0]!;
    expect(call.chromeBrowserId).toBeUndefined();
    expect(JSON.stringify(call.hookSettings)).not.toContain("--browser");
  });
});

describe("an Apply that failed before it opened any page of the job site", () => {
  it("a failed self-check after only tab tools: not sent (failed, Apply again), never needs_check", async () => {
    const { t, applicationId } = await approved();
    t.runner.script({ bot: "apply", kind: "submit", events: tabTools, result: fake.selfCheckFailed(applyOutputFixture, ["All required fields are filled"]) });
    await t.idle();
    const app = getApplication(t.db, applicationId)!;
    expect(app.status).toBe("failed");
    expect(app.statusHistory.at(-1)!.note).toMatch(/^Not sent: Apply stopped before it opened any page of the job site/);
    expect(app.statusHistory.map((h) => h.status)).not.toContain("needs_check");
    expect(leadTexts(t).some((x) => /was not submitted: Apply stopped before it opened any page of the job site .*Open Applications and use Apply again\./.test(x))).toBe(true);
  });

  it("once a page was opened (navigate), needs_check as before", async () => {
    const { t, applicationId } = await approved();
    t.runner.script({ bot: "apply", kind: "submit", result: fake.selfCheckFailed(applyOutputFixture, ["All required fields are filled"]) });
    await t.idle();
    expect(getApplication(t.db, applicationId)!.status).toBe("needs_check");
  });
});
