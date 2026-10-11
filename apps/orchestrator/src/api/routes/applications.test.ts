import {
  ApiErrorSchema,
  ApplicationDetailSchema,
  ApplicationStatusChangeResponseSchema,
  ApplicationsResponseSchema,
  ApplyAgainResponseSchema,
} from "@bs-job-agents/shared";
import { afterEach, describe, expect, it } from "vitest";
import { getRun, importApplication, recordExport, transitionApplication } from "../../db/index.js";
import { NOVAPAY, seedApprovedApplication, seedJob } from "../../db/test-helpers.js";
import { createApiHarness, seedCvVersion, seedRecordedApplication, type ApiHarness } from "../testing.js";

let h: ApiHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

async function list(x: ApiHarness) {
  const res = await x.get("/applications");
  expect(res.statusCode).toBe(200);
  return ApplicationsResponseSchema.parse(res.json());
}

describe("GET /applications (UC-13, UC-13b)", () => {
  it("lists each application with its job, CV version, proof screenshot and the data folder", async () => {
    h = await createApiHarness();
    const { application, cv } = seedRecordedApplication(h.t.db, h.dataDir);
    const body = await list(h);
    expect(body.dataDir).toBe(h.dataDir);
    expect(body.lastExportAt).toBeNull();
    expect(body.applications).toHaveLength(1);
    const item = body.applications[0]!;
    expect(item.application).toMatchObject({ id: String(application.id), status: "submitted", origin: "app", dryRun: false });
    expect(item.job).toEqual({ id: String(application.jobId), title: NOVAPAY.title, company: "NovaPay", url: NOVAPAY.url, source: "itviec" });
    expect(item.cvVersion).toEqual({
      id: String(cv.id),
      label: "NOVAPAY_SENIOR-FE_EN_v1",
      language: "en",
      pdfFileId: `cv-${cv.id}`,
      figmaFrameUrl: cv.figmaFrameUrl,
    });
    expect(item.confirmationScreenshotFileId).toBe(`app-${application.id}-confirmation`);
    expect(item.partialRecord).toBe(false);
    // The CV actually sent: the record's uploaded copy.
    expect(item.cvFile).toMatchObject({ id: `app-${application.id}-cv`, kind: "cv_pdf", filename: "BA_HUYNH_NOVAPAY_EN.pdf" });
  });

  it("POST /applications/:id/apply-again starts apply-to-link with applyAgain for a failed application only", async () => {
    h = await createApiHarness();
    const job = seedJob(h.t.db, NOVAPAY);
    const cv = seedCvVersion(h.t.db, job);
    const { application } = seedApprovedApplication(h.t.db, job, cv);
    const notYet = await h.post(`/applications/${application.id}/apply-again`);
    expect(notYet.statusCode).toBe(409);
    transitionApplication(h.t.db, application.id, "failed", { by: "system" });
    const res = await h.post(`/applications/${application.id}/apply-again`);
    expect(res.statusCode).toBe(201);
    expect(ApplyAgainResponseSchema.parse(res.json())).toEqual({ jobId: String(job.id), runId: "1" });
    const run = getRun(h.t.db, 1)!;
    expect(run).toMatchObject({ workflowName: "apply-to-link", trigger: "link" });
    expect(run.params).toMatchObject({ url: NOVAPAY.url, applyAgain: true });
    expect((await h.post("/applications/999/apply-again")).statusCode).toBe(404);
  });

  it("marks imported applications and records whose files were not captured as partial", async () => {
    h = await createApiHarness();
    seedRecordedApplication(h.t.db, h.dataDir, { files: false });
    const dekon = seedJob(h.t.db, { ...NOVAPAY, url: "https://topcv.vn/viec-lam/dekon-1", title: "Frontend Developer", company: "DEKON", source: "topcv" });
    importApplication(h.t.db, { jobId: dekon.id, submittedAt: "2026-10-10T03:00:00.000Z" });
    const items = (await list(h)).applications;
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.partialRecord)).toBe(true);
    const imported = items.find((i) => i.application.origin === "imported")!;
    expect(imported.cvVersion).toBeNull();
    expect(imported.confirmationScreenshotFileId).toBeNull();
  });

  it("shows the last export date", async () => {
    h = await createApiHarness();
    const exp = recordExport(h.t.db, { path: "exports/a.zip", applicationCount: 0 }, { now: new Date("2026-10-11T01:00:00.000Z") });
    expect((await list(h)).lastExportAt).toBe(exp.createdAt);
  });
});

describe("GET /applications/:id: the approval before a submission exists (PM3 S3, UC-13)", () => {
  it.each(["approved", "paused", "needs_check"] as const)("%s with no record: the approval's time, CV version and sites, never the token", async (status) => {
    h = await createApiHarness();
    const job = seedJob(h.t.db, NOVAPAY);
    const cv = seedCvVersion(h.t.db, job);
    const { application, approval } = seedApprovedApplication(h.t.db, job, cv);
    if (status === "paused") transitionApplication(h.t.db, application.id, "paused", { by: "system" });
    if (status === "needs_check") transitionApplication(h.t.db, application.id, "needs_check", { by: "system" });
    const res = await h.get(`/applications/${application.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(approval.token);
    const d = ApplicationDetailSchema.parse(res.json());
    expect(d.application.status).toBe(status);
    expect(d.submission).toBeNull();
    expect(d.approval).toEqual({ approvedAt: approval.createdAt, cvVersionId: String(cv.id), allowedDomains: ["itviec.com"], note: null });
  });

  it("an imported application has no approval", async () => {
    h = await createApiHarness();
    const job = seedJob(h.t.db, NOVAPAY);
    const { application } = importApplication(h.t.db, { jobId: job.id, submittedAt: "2026-10-10T03:00:00.000Z" });
    const d = ApplicationDetailSchema.parse((await h.get(`/applications/${application.id}`)).json());
    expect(d.approval).toBeNull();
  });
});

describe("GET /applications/:id (the submission record panel)", () => {
  it("shows exactly what was sent, the approval's time, CV version and sites, files by id, and never the token", async () => {
    h = await createApiHarness();
    const { application, approval, cv } = seedRecordedApplication(h.t.db, h.dataDir);
    const res = await h.get(`/applications/${application.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(approval.token);
    const d = ApplicationDetailSchema.parse(res.json());
    expect(d.submission).toMatchObject({
      finalUrl: "https://itviec.com/it-jobs/thanks",
      introText: "I build React/Next.js products.",
      consent: { ticked: true, text: "I agree to the processing of my personal data." },
      uploadedFile: { filename: "BA_HUYNH_NOVAPAY_EN.pdf", sha256: "a".repeat(64), path: `applications/${application.id}/BA_HUYNH_NOVAPAY_EN.pdf` },
      approvalToken: null,
      approval: { cvVersionId: String(cv.id), allowedDomains: ["itviec.com"] },
      dryRun: false,
    });
    expect(d.submission?.jdSnapshot?.jdText).toContain("Senior Frontend Engineer");
    expect(d.files.map((f) => f.id)).toEqual([
      `app-${application.id}-cv`,
      `cv-${cv.id}`,
      `app-${application.id}-presubmit`,
      `app-${application.id}-confirmation`,
      `app-${application.id}-jd`,
      `app-${application.id}-jd-screenshot`,
    ]);
    expect(d.files.find((f) => f.id.endsWith("-presubmit"))).toMatchObject({ kind: "screenshot", mime: "image/png" });
  });

  it("an application still in the apply flow has no record yet; unknown ids are 404", async () => {
    h = await createApiHarness();
    const job = seedJob(h.t.db);
    const cv = seedCvVersion(h.t.db, job);
    const { application } = seedApprovedApplication(h.t.db, job, cv);
    const d = ApplicationDetailSchema.parse((await h.get(`/applications/${application.id}`)).json());
    expect(d.submission).toBeNull();
    expect(d.application.status).toBe("approved");
    expect((await h.get("/applications/999")).statusCode).toBe(404);
  });
});

describe("POST /applications/:id/status (UC-13, UC-11 c)", () => {
  it("Ba moves a submitted application along; history grows and the UI hears about it", async () => {
    h = await createApiHarness();
    const { application } = seedRecordedApplication(h.t.db, h.dataDir);
    const res = await h.post(`/applications/${application.id}/status`, { status: "interviewing", note: "call on Monday" });
    expect(res.statusCode).toBe(200);
    const { application: moved } = ApplicationStatusChangeResponseSchema.parse(res.json());
    expect(moved.status).toBe("interviewing");
    expect(moved.statusHistory.at(-1)).toMatchObject({ status: "interviewing", note: "call on Monday" });
    expect(h.t.events("application.updated").at(-1)).toMatchObject({ applicationId: String(application.id), status: "interviewing", origin: "app" });
    h.t.checkEvents();
  });

  it("refuses a change outside the manual status machine (409) and an unknown status (400)", async () => {
    h = await createApiHarness();
    const { application } = seedRecordedApplication(h.t.db, h.dataDir);
    const back = await h.post(`/applications/${application.id}/status`, { status: "approved", note: null });
    expect(back.statusCode).toBe(409);
    expect(ApiErrorSchema.parse(back.json()).error.code).toBe("conflict");
    expect((await h.post(`/applications/${application.id}/status`, { status: "hired", note: null })).statusCode).toBe(400);
    expect((await h.post("/applications/999/status", { status: "offer", note: null })).statusCode).toBe(404);
  });

  it("Ba settles a needs_check as submitted, but never a dry run", async () => {
    h = await createApiHarness();
    const job = seedJob(h.t.db);
    const cv = seedCvVersion(h.t.db, job);
    const real = seedApprovedApplication(h.t.db, job, cv).application;
    transitionApplication(h.t.db, real.id, "needs_check");
    expect((await h.post(`/applications/${real.id}/status`, { status: "submitted", note: "checked on TopCV" })).statusCode).toBe(200);
    const dry = seedApprovedApplication(h.t.db, job, cv, { dryRun: true }).application;
    transitionApplication(h.t.db, dry.id, "needs_check");
    expect((await h.post(`/applications/${dry.id}/status`, { status: "submitted", note: null })).statusCode).toBe(409);
  });
});
