// PM2 M1: the §9.1 record cites only files the orchestrator itself put in
// data/applications/<id>/ (inside that folder, existing, a PNG or JPEG), never a path the bot names;
// a `submitted` report without its proof is recorded as needs_check ("screenshots not captured").
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyOutputFixture } from "@bs-job-agents/shared/fixtures";
import type { ApplyOutput } from "@bs-job-agents/shared";
import { afterEach, describe, expect, it } from "vitest";
import { getApplication, getSubmissionRecord } from "../db/index.js";
import { nodeFileStore } from "./system.js";
import { fake } from "./testing/fake-runner.js";
import { createTestEngine, type TestEngine } from "./testing/harness.js";
import type { RunnerTask } from "../runner/types.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]);

async function approved() {
  const t = await createTestEngine({ sources: ["itviec"] });
  const run = t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
  await t.idle();
  const cvVersionId = t.review(run.id, 1)!.cvVersions[0]!.cvVersionId;
  return { t, run, approve: () => t.engine.approve(1, { cvVersionId, introText: null }) };
}

/** Apply's report, with the screenshots it names and the orchestrator's file name. */
function report(t: TestEngine, over: Partial<ApplyOutput>, place?: (dir: string) => void) {
  return (task: RunnerTask) => {
    place?.(task.readDirs![0]!);
    const input = task.input as { pdfPath: string; pdfSha256: string };
    return fake.ok({ ...applyOutputFixture, uploadedFile: { filename: input.pdfPath.split("/").at(-1)!, sha256: input.pdfSha256 }, ...over });
  };
}

describe("the record cites only the orchestrator's own image files (PM2 M1, §9.1)", () => {
  it("probe P1: bot-named paths outside the folder, prose and traversal are stored as null; the application needs a check", async () => {
    const { t, approve } = await approved();
    t.runner.script({
      bot: "apply",
      kind: "submit",
      result: report(t, {
        preSubmitScreenshot: "/Users/bason/.ssh/id_ed25519",
        confirmationScreenshot: "screenshot 3: confirmation page",
        jdSnapshot: { ...applyOutputFixture.jdSnapshot!, pageScreenshot: "../../../etc/passwd" },
      }),
    });
    const { applicationId } = approve();
    await t.idle();
    const record = getSubmissionRecord(t.db, applicationId!)!;
    expect(record.submission).toMatchObject({ preSubmitScreenshotPath: null, confirmationScreenshotPath: null });
    expect(record.snapshot?.pageScreenshotPath).toBeNull();
    const app = getApplication(t.db, applicationId!)!;
    expect(app.status).toBe("needs_check");
    expect(app.statusHistory.at(-1)).toMatchObject({ status: "needs_check", note: "screenshots not captured" });
  });

  it("PNG and JPEG files in data/applications/<id>/ are cited by their data/-relative path; the application is submitted", async () => {
    const { t, approve } = await approved();
    t.runner.script({
      bot: "apply",
      kind: "submit",
      result: report(t, { preSubmitScreenshot: "pre-submit.png", confirmationScreenshot: "/data/applications/1/shots/confirmation.jpg", jdSnapshot: { ...applyOutputFixture.jdSnapshot!, pageScreenshot: "./jd.png" } }, (dir) => {
        t.files.write(`${dir}/pre-submit.png`, PNG);
        t.files.write(`${dir}/shots/confirmation.jpg`, JPEG);
        t.files.write(`${dir}/jd.png`, PNG);
      }),
    });
    const { applicationId } = approve();
    await t.idle();
    const record = getSubmissionRecord(t.db, applicationId!)!;
    expect(record.submission).toMatchObject({ preSubmitScreenshotPath: "applications/1/pre-submit.png", confirmationScreenshotPath: "applications/1/shots/confirmation.jpg" });
    expect(record.snapshot?.pageScreenshotPath).toBe("applications/1/jd.png");
    expect(getApplication(t.db, applicationId!)?.status).toBe("submitted");
  });

  it("a file that is not an image (the uploaded PDF), a missing one or one outside the folder is never cited", async () => {
    const { t, approve } = await approved();
    t.runner.script({
      bot: "apply",
      kind: "submit",
      result: report(t, { preSubmitScreenshot: "BA_HUYNH_NOVAPAY_EN.pdf", confirmationScreenshot: "/data/screenshots/9-1/0.png", jdSnapshot: { ...applyOutputFixture.jdSnapshot!, pageScreenshot: "missing.png" } }, () => {
        t.files.write("/data/screenshots/9-1/0.png", PNG);
      }),
    });
    const { applicationId } = approve();
    await t.idle();
    const record = getSubmissionRecord(t.db, applicationId!)!;
    expect(record.submission).toMatchObject({ preSubmitScreenshotPath: null, confirmationScreenshotPath: null });
    expect(record.snapshot?.pageScreenshotPath).toBeNull();
    expect(getApplication(t.db, applicationId!)?.status).toBe("needs_check");
  });

  it("confirmation text is enough proof next to a pre-submit screenshot; without either it needs a check", async () => {
    const one = await approved();
    one.t.runner.script({
      bot: "apply",
      kind: "submit",
      result: report(one.t, { preSubmitScreenshot: "pre.png", confirmationScreenshot: null, confirmationText: "Thank you for applying" }, (dir) => one.t.files.write(`${dir}/pre.png`, PNG)),
    });
    const a = one.approve();
    await one.t.idle();
    expect(getApplication(one.t.db, a.applicationId!)?.status).toBe("submitted");

    const two = await approved();
    two.t.runner.script({
      bot: "apply",
      kind: "submit",
      // The bot names a confirmation screenshot that was never captured, and has no confirmation text.
      result: report(two.t, { preSubmitScreenshot: "pre.png", confirmationScreenshot: "confirmation.png", confirmationText: null, status: "submitted" }, (dir) => two.t.files.write(`${dir}/pre.png`, PNG)),
    });
    const b = two.approve();
    await two.t.idle();
    expect(getApplication(two.t.db, b.applicationId!)).toMatchObject({ status: "needs_check", statusHistory: expect.arrayContaining([expect.objectContaining({ note: "screenshots not captured" })]) });
  });
});

describe("the proof must be real (PM2 M1)", () => {
  it("one file named as both the pre-submit and the confirmation screenshot is one proof, not two; blank text is no proof", async () => {
    const { t, approve } = await approved();
    t.runner.script({
      bot: "apply",
      kind: "submit",
      result: report(t, { preSubmitScreenshot: "pre.png", confirmationScreenshot: "./pre.png", confirmationText: "   " }, (dir) => t.files.write(`${dir}/pre.png`, PNG)),
    });
    const { applicationId } = approve();
    await t.idle();
    expect(getSubmissionRecord(t.db, applicationId!)?.submission).toMatchObject({ preSubmitScreenshotPath: "applications/1/pre.png", confirmationScreenshotPath: null });
    expect(getApplication(t.db, applicationId!)).toMatchObject({ status: "needs_check", statusHistory: expect.arrayContaining([expect.objectContaining({ note: "screenshots not captured" })]) });
  });
});

describe("nodeFileStore.readHead (PM2 M1)", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("reads the first bytes of a regular file; never follows a link, never reads a folder", async () => {
    dir = mkdtempSync(join(tmpdir(), "bsja-head-"));
    writeFileSync(join(dir, "a.png"), PNG);
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "secret"), "PRIVATE KEY");
    symlinkSync(join(dir, "secret"), join(dir, "link.png"));
    expect(await nodeFileStore.readHead(join(dir, "a.png"), 4)).toEqual(PNG.subarray(0, 4));
    expect(await nodeFileStore.readHead(join(dir, "link.png"), 4)).toBeNull();
    expect(await nodeFileStore.readHead(join(dir, "sub"), 4)).toBeNull();
    expect(await nodeFileStore.readHead(join(dir, "missing"), 4)).toBeNull();
  });

  it("never reads through a linked folder out of the application's folder", async () => {
    dir = mkdtempSync(join(tmpdir(), "bsja-head-"));
    const app = join(dir, "applications", "1");
    mkdirSync(app, { recursive: true });
    mkdirSync(join(dir, "elsewhere"));
    writeFileSync(join(dir, "elsewhere", "shot.png"), PNG);
    writeFileSync(join(app, "own.png"), PNG);
    symlinkSync(join(dir, "elsewhere"), join(app, "shots"));
    expect(await nodeFileStore.readHead(join(app, "own.png"), 4, app)).toEqual(PNG.subarray(0, 4));
    expect(await nodeFileStore.readHead(join(app, "shots", "shot.png"), 4, app)).toBeNull();
  });
});
