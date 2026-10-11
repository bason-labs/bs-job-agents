import { API_ROUTES, ApplicationDetailSchema, ApplicationListItemSchema, ApplicationStatusChangeResponseSchema, CSRF_HEADER, ExportResponseSchema } from "@bs-job-agents/shared";
import { describe, expect, it } from "vitest";
import { apiErrorInfo } from "@/components/schedules/apiError";
import { createHttpApi } from "@/lib/api/http";
import { APPLICATION_DETAILS } from "@/lib/api/mock/seed-applications";
import { TEST_NOW, testMock } from "@/lib/api/mock/testing";
import { createApplicationsData } from "./data";

const make = () => {
  const mock = testMock();
  return { mock, data: createApplicationsData(mock) };
};

describe("seeded applications (mock orchestrator)", () => {
  it("are valid API shapes and never carry an approval token (PM S18)", async () => {
    for (const d of APPLICATION_DETAILS) expect(() => ApplicationDetailSchema.parse(d), d.application.id).not.toThrow();
    for (const d of APPLICATION_DETAILS) expect(d.submission?.approvalToken ?? null).toBeNull();
    for (const r of (await make().data.list()).applications) expect(() => ApplicationListItemSchema.parse(r)).not.toThrow();
  });

  it("list newest first with cvFile, flagging imported and incomplete records as partial", async () => {
    const { applications, lastExportAt, dataDir } = await make().data.list();
    expect(applications.map((r) => r.job.company)).toEqual(["Sao Việt Tech", "Kite Labs", "Bluebird Software", "SMARTBIT", "NovaPay", "DEKON", "YAVIET"]);
    expect(lastExportAt).toBeNull();
    expect(dataDir).toBe("/Users/ba/job-agents/data");
    const partial = Object.fromEntries(applications.map((r) => [r.job.company, r.partialRecord]));
    expect(partial).toMatchObject({ DEKON: true, "Sao Việt Tech": true, NovaPay: false, "Kite Labs": false, "Bluebird Software": false });
    expect(applications.find((r) => r.job.company === "NovaPay")?.confirmationScreenshotFileId).toBe("file_app1_confirmation");
    expect(applications.find((r) => r.job.company === "DEKON")?.cvFile).toMatchObject({ id: "file_dekon_cv", kind: "cv_pdf" });
  });
});

describe("applications adapter", () => {
  it("changes a status through the shared machine, appends the history and emits application.updated", async () => {
    const { mock, data } = make();
    const events: string[] = [];
    mock.subscribe((e) => events.push(e.type));
    const res = ApplicationStatusChangeResponseSchema.parse(await data.changeStatus("app_1", { status: "interviewing", note: null }));
    expect(res.application.status).toBe("interviewing");
    expect(res.application.statusHistory.at(-1)).toEqual({ status: "interviewing", at: TEST_NOW.toISOString(), note: null });
    expect((await data.get("app_1"))?.application.status).toBe("interviewing");
    expect(events).toContain("application.updated");
  });

  it("maps the API's 409 (a dry run never becomes submitted) and 404 → null", async () => {
    const { data } = make();
    const refused = await data.changeStatus("app_3", { status: "submitted", note: null }).catch((e: unknown) => e);
    expect(apiErrorInfo(refused)).toMatchObject({ status: 409, code: "conflict" });
    expect(await data.get("nope")).toBeNull();
  });

  it("exports every real application and remembers the export time (UC-13b)", async () => {
    const { data } = make();
    const res = ExportResponseSchema.parse(await data.exportAll());
    expect(res.export).toMatchObject({ applicationCount: 6, path: "data/exports/job-agents-export_2026-10-11.zip" });
    expect(res.downloadUrl).toMatch(/^data:application\/zip;base64,/);
    expect((await data.list()).lastExportAt).toBe(TEST_NOW.toISOString());
  });

  it("applies again only to failed applications: a new apply-to-link run (UC-14 a)", async () => {
    const { mock, data } = make();
    const res = await data.applyAgain("app_4");
    expect(res.jobId).toBe("job_4");
    expect((await mock.getRun(res.runId)).run).toMatchObject({ workflowName: "apply-to-link", params: { applyAgain: true } });
    expect(apiErrorInfo(await data.applyAgain("app_1").catch((e: unknown) => e))).toMatchObject({ status: 409 });
    await mock.idle();
  });

  it("lists the applications the sim creates on approval, with the card's job and CV", async () => {
    const { mock, data } = make();
    const card = (await mock.getReviewQueue())[1]!;
    await mock.approve(card.job.id, { cvVersionId: card.cvOptions[0]!.cvVersion.id, introText: null });
    const row = (await data.list()).applications.find((r) => r.job.id === card.job.id);
    expect(row).toMatchObject({ job: { company: card.job.company }, cvVersion: { id: card.cvOptions[0]!.cvVersion.id } });
    await mock.idle();
  });

  it("serves the viewer's sample files in mock mode", () => {
    const { data } = make();
    expect(data.fileUrl("file_app1_cv")).toBe("/dev/sample-cv.pdf");
    expect(data.fileUrl("file_app1_confirmation", { download: true })).toBe("/dev/sample-screenshot.png");
  });

  it("live: same-origin /api paths, the CSRF header, and the download URL behind the proxy", async () => {
    const calls: [string, RequestInit][] = [];
    const exp = { export: { id: "4", createdAt: "2026-10-11T03:00:00.000Z", path: "data/exports/x.zip", applicationCount: 2 }, downloadUrl: "/files/export-4?download=1" };
    const fetch = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push([String(url), init ?? {}]);
      if (String(url).endsWith("/applications/9")) return new Response(JSON.stringify({ error: { code: "not_found", message: "application 9 not found", details: null } }), { status: 404 });
      return new Response(JSON.stringify(exp), { status: 201 });
    };
    const api = createHttpApi({ baseUrl: "/api", fetch: fetch as typeof globalThis.fetch, events: { subscribe: () => () => {}, getStatus: () => "idle", onStatus: () => () => {} } });
    const data = createApplicationsData(api);
    expect(await data.get("9")).toBeNull();
    expect((await data.exportAll()).downloadUrl).toBe("/api/files/export-4?download=1");
    expect(data.fileUrl("7", { download: true })).toBe("/api/files/7?download=1");
    expect(calls.map(([u, i]) => `${i.method} ${u}`)).toEqual(["GET /api/applications/9", `POST /api${API_ROUTES.exports}`]);
    expect(new Headers(calls[1]![1].headers).get(CSRF_HEADER)).toBe("1");
  });
});
