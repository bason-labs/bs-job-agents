import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ApplicationsResponseSchema, ExportResponseSchema, ExportsResponseSchema } from "@bs-job-agents/shared";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { importApplication, transitionApplication } from "../../db/index.js";
import { NOVAPAY, seedApprovedApplication, seedJob } from "../../db/test-helpers.js";
import { FILE_BYTES, createApiHarness, seedCvVersion, seedRecordedApplication, type ApiHarness } from "../testing.js";

let h: ApiHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

async function exportAll(x: ApiHarness) {
  const res = await x.post("/exports", {});
  expect(res.statusCode, res.body).toBe(201);
  const body = ExportResponseSchema.parse(res.json());
  const zip = unzipSync(readFileSync(join(x.dataDir, body.export.path)));
  return { body, zip };
}

describe("POST /exports (UC-13b ⬇ Export all)", () => {
  it("writes a ZIP: applications.csv plus one folder per application with the record and its files", async () => {
    h = await createApiHarness();
    const { application, approval } = seedRecordedApplication(h.t.db, h.dataDir);
    const dekon = seedJob(h.t.db, { ...NOVAPAY, url: "https://topcv.vn/viec-lam/dekon-1", title: "=HYPERLINK(\"http://evil\")", company: "Công ty DEKON", source: "topcv" });
    importApplication(h.t.db, { jobId: dekon.id, submittedAt: "2026-10-09T03:00:00.000Z" });
    const { body, zip } = await exportAll(h);
    expect(body.export).toMatchObject({ applicationCount: 2, path: expect.stringMatching(/^exports\/applications-\d{8}-\d{6}\.zip$/) });
    expect(body.downloadUrl).toBe(`/files/export-${body.export.id}?download=1`);

    // A UTF-8 BOM, so spreadsheet apps read Vietnamese names right (TextDecoder drops it when decoding).
    expect([...zip["applications.csv"]!.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const csv = strFromU8(zip["applications.csv"]!);
    const lines = csv.trim().split("\n");
    // PM3 S7: the CV version, its language and whether the record is partial, as the Applications screen shows them.
    expect(lines[0]).toBe("application_id,company,role,source,url,cv_file,cv_sha256,submitted_at,status,origin,cv_version,cv_language,partial_record");
    expect(lines).toHaveLength(3);
    const row = (id: number) => lines.find((l) => l.startsWith(`${id},`))!.split(",");
    expect(row(application.id).slice(-3)).toEqual(["NOVAPAY_SENIOR-FE_EN_v1", "en", "false"]);
    expect(lines.find((l) => l.includes("DEKON"))!.split(",").slice(-3)).toEqual(["", "", "true"]);
    // A formula from a job page is never run by a spreadsheet.
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(csv).toContain("not captured");

    const folder = `2026-10-10_NovaPay_${application.id}/`;
    const names = Object.keys(zip);
    expect(names).toEqual(
      expect.arrayContaining([
        `${folder}submission.json`,
        `${folder}BA_HUYNH_NOVAPAY_EN.pdf`,
        `${folder}jd.txt`,
        `${folder}jd.jpg`,
        `${folder}pre-submit.png`,
        `${folder}confirmation.png`,
      ]),
    );
    expect(names.some((n) => n.startsWith(`2026-10-09_CongtyDEKON_`))).toBe(true);
    expect(Buffer.from(zip[`${folder}BA_HUYNH_NOVAPAY_EN.pdf`]!).equals(FILE_BYTES.pdf)).toBe(true);
    const record = JSON.parse(strFromU8(zip[`${folder}submission.json`]!));
    expect(record.submission.approvalToken).toBeNull();
    for (const bytes of Object.values(zip)) expect(Buffer.from(bytes).includes(approval.token)).toBe(false);
  });

  it("leaves out dry runs and any file a record names outside data/", async () => {
    h = await createApiHarness();
    const { application } = seedRecordedApplication(h.t.db, h.dataDir);
    const secret = join(dirname(h.dataDir), "secret.png");
    writeFileSync(secret, Buffer.concat([FILE_BYTES.png, Buffer.from("PRIVATE KEY")]));
    h.t.db.$client.exec("DROP TRIGGER IF EXISTS submissions_no_update");
    h.t.db.$client.prepare("UPDATE submissions SET confirmation_screenshot_path = ? WHERE application_id = ?").run("../secret.png", application.id);
    const job = seedJob(h.t.db, { ...NOVAPAY, url: "https://itviec.com/it-jobs/other-2", title: "Other" });
    const dry = seedApprovedApplication(h.t.db, job, seedCvVersion(h.t.db, job, { frame: "OTHER_EN_v1" }), { dryRun: true }).application;
    transitionApplication(h.t.db, dry.id, "needs_check");
    const { body, zip } = await exportAll(h);
    expect(body.export.applicationCount).toBe(1);
    expect(Object.keys(zip).some((n) => n.endsWith("confirmation.png"))).toBe(false);
    for (const bytes of Object.values(zip)) expect(Buffer.from(bytes).includes("PRIVATE KEY")).toBe(false);
  });

  it("records the export: the last export date, the export.ready event, the list and the download", async () => {
    h = await createApiHarness();
    seedRecordedApplication(h.t.db, h.dataDir);
    const { body } = await exportAll(h);
    expect(ApplicationsResponseSchema.parse((await h.get("/applications")).json()).lastExportAt).toBe(body.export.createdAt);
    expect(h.t.events("export.ready").at(-1)?.export).toEqual(body.export);
    h.t.checkEvents();
    expect(ExportsResponseSchema.parse((await h.get("/exports")).json()).exports.map((e) => e.id)).toEqual([body.export.id]);
    const file = await h.get(body.downloadUrl);
    expect(file.statusCode).toBe(200);
    expect(file.headers["content-type"]).toBe("application/zip");
    expect(file.headers["content-disposition"]).toMatch(/^attachment; filename="applications-/);
  });

  it("takes an empty body only", async () => {
    h = await createApiHarness();
    expect((await h.post("/exports", { folder: "/tmp" })).statusCode).toBe(400);
    expect((await h.post("/exports")).statusCode).toBe(201);
  });
});
