// PM2 S10 (decision 10c): a click can take Apply's tab off the approved domains without a navigate
// call the site guard sees. After the run, Apply's finalUrl and every page URL the Chrome tools
// reported must be on the approval's domains; otherwise needs_check + safety.denied(off_allowlist).
import { applyOutputFixture } from "@bs-job-agents/shared/fixtures";
import type { ApplyOutput } from "@bs-job-agents/shared";
import { describe, expect, it } from "vitest";
import { getApplication, getTask } from "../db/index.js";
import type { RunnerResult, RunnerTask } from "../runner/types.js";
import { fake, fakeCaptures } from "./testing/fake-runner.js";
import { createTestEngine, type TestEngine } from "./testing/harness.js";

async function reviewed(t: TestEngine) {
  const run = t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
  await t.idle();
  return t.review(run.id, 1)!.cvVersions[0]!.cvVersionId;
}

/** A clean submitted report with its screenshots captured, plus what the Chrome tools reported. */
function submitted(t: TestEngine, pageUrls: string[], over: Partial<ApplyOutput> = {}) {
  return (task: RunnerTask): RunnerResult => {
    fakeCaptures(t.files, task.screenshotDir!, [{ id: "ss_pre" }, { id: "ss_conf" }]);
    const input = task.input as { pdfPath: string; pdfSha256: string };
    const output: ApplyOutput = {
      ...applyOutputFixture,
      uploadedFile: { filename: input.pdfPath.split("/").at(-1)!, sha256: input.pdfSha256 },
      preSubmitScreenshot: "ss_pre",
      confirmationScreenshot: "ss_conf",
      jdSnapshot: null,
      ...over,
    };
    return { ...fake.ok(output), pageUrls };
  };
}

describe("Apply's pages are checked against the approval after the run (PM2 S10)", () => {
  it("every page on the approved domain (subdomains too): the application is submitted", async () => {
    const t = await createTestEngine();
    const cvVersionId = await reviewed(t);
    t.runner.script({ bot: "apply", kind: "submit", result: submitted(t, ["https://itviec.com/it-jobs/x", "https://apply.itviec.com/form"]) });
    const { applicationId } = t.engine.approve(1, { cvVersionId, introText: null });
    await t.idle();
    expect(getApplication(t.db, applicationId!)?.status).toBe("submitted");
    expect(t.events("safety.denied")).toEqual([]);
  });

  it("a page outside the approved domains (a click away): needs_check and a safety event, never submitted", async () => {
    const t = await createTestEngine();
    const cvVersionId = await reviewed(t);
    t.runner.script({ bot: "apply", kind: "submit", result: submitted(t, ["https://itviec.com/it-jobs/x", "https://vietcombank.com.vn/login"]) });
    const { applicationId } = t.engine.approve(1, { cvVersionId, introText: null });
    await t.idle();
    const app = getApplication(t.db, applicationId!)!;
    expect(app.status).toBe("needs_check");
    expect(app.statusHistory.at(-1)?.note).toMatch(/vietcombank\.com\.vn/);
    expect(t.events("safety.denied")).toContainEqual(expect.objectContaining({ botName: "apply", action: "apply.page_check", reason: "off_allowlist" }));
  });

  it("a finalUrl outside the approved domains is caught the same way", async () => {
    const t = await createTestEngine();
    const cvVersionId = await reviewed(t);
    t.runner.script({ bot: "apply", kind: "submit", result: submitted(t, [], { finalUrl: "https://evil-ats.example.org/thanks" }) });
    const { applicationId } = t.engine.approve(1, { cvVersionId, introText: null });
    await t.idle();
    expect(getApplication(t.db, applicationId!)?.status).toBe("needs_check");
    expect(t.events("safety.denied")).toContainEqual(expect.objectContaining({ reason: "off_allowlist", detail: expect.stringContaining("evil-ats.example.org") }));
  });

  it("a paused Apply whose tab left the domain stops instead of waiting for Ba", async () => {
    const t = await createTestEngine();
    const cvVersionId = await reviewed(t);
    t.runner.script({ bot: "apply", kind: "submit", result: { ...fake.applyPaused({ reason: "needs_login", site: "itviec.com" }), pageUrls: ["https://accounts.google.com/signin"] } });
    const { applicationId, taskId } = t.engine.approve(1, { cvVersionId, introText: null });
    await t.idle();
    expect(getTask(t.db, taskId!)?.status).toBe("failed");
    expect(getApplication(t.db, applicationId!)?.status).toBe("needs_check");
  });
});
