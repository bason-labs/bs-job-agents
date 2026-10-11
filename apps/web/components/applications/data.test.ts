import { ApplicationDetailSchema, ApplicationListItemSchema, ApplicationStatusChangeResponseSchema, ExportResponseSchema } from "@bs-job-agents/shared";
import { describe, expect, it } from "vitest";
import { apiErrorInfo } from "@/components/schedules/apiError";
import { createFixtureApplicationsData } from "./data";
import { APPLICATION_DETAILS } from "./fixtures";

const NOW = new Date("2026-10-11T03:00:00Z");
const make = () => createFixtureApplicationsData({ now: () => NOW });

describe("applications fixtures", () => {
  it("are valid API shapes", async () => {
    for (const d of APPLICATION_DETAILS) expect(() => ApplicationDetailSchema.parse(d), d.application.id).not.toThrow();
    for (const r of (await make().list()).applications) expect(() => ApplicationListItemSchema.parse(r)).not.toThrow();
  });

  it("never carry an approval token (PM S18)", () => {
    for (const d of APPLICATION_DETAILS) expect(d.submission?.approvalToken ?? null).toBeNull();
  });

  it("list newest first, flagging imported and incomplete records as partial", async () => {
    const { applications, lastExportAt } = await make().list();
    expect(applications.map((r) => r.job.company)).toEqual(["Sao Việt Tech", "Kite Labs", "Bluebird Software", "SMARTBIT", "NovaPay", "DEKON", "YAVIET"]);
    expect(lastExportAt).toBeNull();
    const partial = Object.fromEntries(applications.map((r) => [r.job.company, r.partialRecord]));
    expect(partial).toMatchObject({ DEKON: true, "Sao Việt Tech": true, NovaPay: false, "Kite Labs": false, "Bluebird Software": false });
    expect(applications.find((r) => r.job.company === "NovaPay")?.confirmationScreenshotFileId).toBe("file_app1_confirmation");
    expect(applications.find((r) => r.job.company === "Sao Việt Tech")?.confirmationScreenshotFileId).toBeNull();
  });
});

describe("fixture applications store", () => {
  it("changes a status through the shared machine and appends the history", async () => {
    const data = make();
    const res = ApplicationStatusChangeResponseSchema.parse(await data.changeStatus("app_1", { status: "interviewing", note: null }));
    expect(res.application.status).toBe("interviewing");
    expect(res.application.statusHistory.at(-1)).toEqual({ status: "interviewing", at: NOW.toISOString(), note: null });
    expect((await data.get("app_1"))?.application.status).toBe("interviewing");
  });

  it("refuses moves the machine forbids, e.g. a dry run to submitted, with the API's 409", async () => {
    const data = make();
    const refused = await data.changeStatus("app_3", { status: "submitted", note: null }).catch((e: unknown) => e);
    expect(apiErrorInfo(refused)).toMatchObject({ status: 409, code: "conflict" });
    await expect(data.changeStatus("app_1", { status: "needs_check", note: null })).rejects.toThrow(/can't change/);
  });

  it("answers a missing application with null (the API's 404)", async () => {
    expect(await make().get("nope")).toBeNull();
  });

  it("exports every real application and remembers the export time (UC-13b)", async () => {
    const data = make();
    const res = ExportResponseSchema.parse(await data.exportAll());
    expect(res.export).toMatchObject({ applicationCount: 6, path: "data/exports/job-agents-export_2026-10-11.zip" });
    expect(res.downloadUrl).toMatch(/^data:application\/zip;base64,/);
    expect((await data.list()).lastExportAt).toBe(NOW.toISOString());
  });

  it("applies again only to failed applications", async () => {
    const data = make();
    expect(await data.applyAgain("app_4")).toEqual({ jobId: "job_4" });
    await expect(data.applyAgain("app_1")).rejects.toThrow();
  });

  it("serves sample files by type for the viewer", () => {
    const data = make();
    expect(data.fileUrl("file_app1_cv")).toBe("/dev/sample-cv.pdf");
    expect(data.fileUrl("file_app1_confirmation", { download: true })).toBe("/dev/sample-screenshot.png");
    expect(data.fileUrl("unknown", { download: true })).toBe("/files/unknown?download=1");
  });
});
