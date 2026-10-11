// S12 (pm-phase-3, UC-13): the one-off import of applications made before this app.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { findJobByUrl, getSubmissionRecord, listApplications, openDb, openTestDb, type Db } from "../src/db/index.js";
import { seedApprovedApplication, seedCv, seedJob } from "../src/db/test-helpers.js";
import { ApplicationDetailSchema, ApplicationsResponseSchema } from "@bs-job-agents/shared";
import { createApiHarness } from "../src/api/testing.js";
import { ImportedApplicationsFileSchema, importApplications, runCli } from "./import-applications.js";

const EXAMPLE = fileURLToPath(new URL("../../../data.example/imported-applications.yaml", import.meta.url));
const temps: string[] = [];
const dbs: Db[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
  dbs.splice(0);
});

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const pdfBytes = (name: string) => Buffer.from(`%PDF-1.7\n% ${name}\n%%EOF\n`);

/** A temp root with data/, a pdf/ folder holding the given PDFs and an import YAML pointing at it. */
function setup(pdfs: string[], yamlBody: string): { root: string; dataDir: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), "bsja-import-"));
  temps.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir);
  mkdirSync(join(root, "pdf"));
  for (const p of pdfs) writeFileSync(join(root, "pdf", p), pdfBytes(p));
  const file = join(root, "imported.yaml");
  writeFileSync(file, yamlBody);
  return { root, dataDir, file };
}

const TWO = `pdfDir: pdf
applications:
  - company: DEKON
    title: Senior Developer (NodeJS, ReactJS, AI)
    source: topcv
    url: https://www.topcv.vn/viec-lam/senior-developer-nodejs-reactjs-ai/2316742.html
    language: null
    submittedAt: 2026-10-10T15:40:00+07:00
    status: submitted
    pdf: A.pdf
    fields:
      - { label: CV, name: null, value: A.pdf, source: generated }
    introText: null
    consent: { ticked: true, text: Employer personal-data-use agreement (TopCV) }
    confirmationText: Ứng tuyển việc làm thành công!
  - company: YAVIET
    title: Frontend Developer (ReactJS, NextJS, TS)
    source: topcv
    url: https://www.topcv.vn/viec-lam/frontend-developer-reactjs-nextjs-typescript/2325969.html
    language: null
    submittedAt: 2026-10-10T15:38:00+07:00
    pdf: B.pdf
`;

function openDbFor(): Db {
  const db = openTestDb();
  dbs.push(db);
  return db;
}

describe("importApplications (UC-13, S12)", () => {
  it("imports each row as an imported, submitted application with its PDF copied into data/applications/<id>/ and hashed", () => {
    const { dataDir, file } = setup(["A.pdf", "B.pdf"], TWO);
    const db = openDbFor();
    const report = importApplications({ db, dataDir, file });
    expect(report.imported.map((r) => r.company)).toEqual(["DEKON", "YAVIET"]);
    expect(report.skipped).toEqual([]);
    expect(report.warnings).toEqual([]);

    const apps = listApplications(db);
    expect(apps).toHaveLength(2);
    const dekonJob = findJobByUrl(db, "https://www.topcv.vn/viec-lam/senior-developer-nodejs-reactjs-ai/2316742.html")!;
    expect(dekonJob).toMatchObject({ source: "topcv", title: "Senior Developer (NodeJS, ReactJS, AI)", status: "applied", language: null, jdText: null });
    const dekon = apps.find((a) => a.jobId === dekonJob.id)!;
    expect(dekon).toMatchObject({ origin: "imported", status: "submitted", submittedAt: "2026-10-10T08:40:00.000Z", cvVersionId: null });

    const record = getSubmissionRecord(db, dekon.id)!;
    expect(record.submission).toMatchObject({
      uploadedFilename: "A.pdf",
      uploadedPath: `applications/${dekon.id}/A.pdf`,
      uploadedSha256: sha(pdfBytes("A.pdf")),
      consentTicked: true,
      consentText: "Employer personal-data-use agreement (TopCV)",
      confirmationText: "Ứng tuyển việc làm thành công!",
      preSubmitScreenshotPath: null,
      confirmationScreenshotPath: null,
      approvalToken: null,
      submittedAt: "2026-10-10T08:40:00.000Z",
      fields: [{ label: "CV", name: null, value: "A.pdf", source: "generated" }],
    });
    // Not captured: no JD snapshot.
    expect(record.snapshot).toBeUndefined();
    const copy = join(dataDir, "applications", String(dekon.id), "A.pdf");
    expect(sha(readFileSync(copy))).toBe(record.submission!.uploadedSha256);
  });

  it("re-running imports nothing twice (keyed by URL)", () => {
    const { dataDir, file } = setup(["A.pdf", "B.pdf"], TWO);
    const db = openDbFor();
    importApplications({ db, dataDir, file });
    const again = importApplications({ db, dataDir, file });
    expect(again.imported).toEqual([]);
    expect(again.skipped.map((s) => [s.company, s.reason])).toEqual([
      ["DEKON", "already imported"],
      ["YAVIET", "already imported"],
    ]);
    expect(listApplications(db)).toHaveLength(2);
  });

  it("a job only scanned gets the imported application; a job Ba applied to in the app is skipped", () => {
    const { dataDir, file } = setup(["A.pdf", "B.pdf"], TWO);
    const db = openDbFor();
    const scanned = seedJob(db, { source: "topcv", url: "https://www.topcv.vn/viec-lam/senior-developer-nodejs-reactjs-ai/2316742.html?utm_source=x", title: "Senior Developer (NodeJS, ReactJS, AI)", company: "DEKON", language: "vi", jdText: "JD" });
    const applied = seedJob(db, { source: "topcv", url: "https://www.topcv.vn/viec-lam/frontend-developer-reactjs-nextjs-typescript/2325969.html", title: "Frontend Developer (ReactJS, NextJS, TS)", company: "YAVIET", language: "en" });
    const { application } = seedApprovedApplication(db, applied, seedCv(db, applied));
    const report = importApplications({ db, dataDir, file });
    expect(report.imported.map((r) => [r.company, r.jobId])).toEqual([["DEKON", scanned.id]]);
    expect(report.skipped).toEqual([{ company: "YAVIET", url: expect.any(String), reason: `already applied in the app (application ${application.id})` }]);
    // The scanned job keeps what Research found.
    expect(findJobByUrl(db, "https://www.topcv.vn/viec-lam/senior-developer-nodejs-reactjs-ai/2316742.html")).toMatchObject({ id: scanned.id, language: "vi", jdText: "JD", status: "applied" });
  });

  it("a missing PDF is imported without a file (\"not captured\") and reported", () => {
    const { dataDir, file } = setup(["A.pdf"], TWO);
    const db = openDbFor();
    const report = importApplications({ db, dataDir, file });
    expect(report.imported).toHaveLength(2);
    expect(report.warnings).toEqual([expect.stringMatching(/YAVIET: PDF not found .*B\.pdf/)]);
    const yaviet = listApplications(db).find((a) => a.jobId === findJobByUrl(db, "https://www.topcv.vn/viec-lam/frontend-developer-reactjs-nextjs-typescript/2325969.html")!.id)!;
    expect(getSubmissionRecord(db, yaviet.id)!.submission).toMatchObject({ uploadedFilename: null, uploadedPath: null, uploadedSha256: null });
  });

  it("refuses a file that is not a PDF and an invalid YAML, writing nothing", () => {
    const { root, dataDir, file } = setup(["A.pdf", "B.pdf"], TWO);
    writeFileSync(join(root, "pdf", "B.pdf"), "not a pdf");
    const db = openDbFor();
    expect(() => importApplications({ db, dataDir, file })).toThrow(/YAVIET: .*B\.pdf is not a PDF/);
    expect(listApplications(db)).toEqual([]);
    expect(existsSync(join(dataDir, "applications"))).toBe(false);
    expect(() => importApplications({ db, dataDir, file: writeYaml(dataDir, "applications: [{ company: X }]") })).toThrow(/imported-applications/);
  });
});

function writeYaml(dir: string, body: string): string {
  const path = join(dir, `extra-${Math.random().toString(36).slice(2)}.yaml`);
  writeFileSync(path, body.replace("pdfDir: pdf", `pdfDir: ${join(dir, "..", "pdf")}`));
  return path;
}

describe("the imported rows in the app (Applications screen, record panel, viewer)", () => {
  it("list as imported and partial, show the record with the CV file by id, and serve that PDF", async () => {
    const h = await createApiHarness();
    try {
      const { dataDir, file } = setup(["A.pdf", "B.pdf"], TWO);
      // The harness has its own data folder; import into it (the PDFs come from the temp root).
      importApplications({ db: h.t.db, dataDir: h.dataDir, file, pdfDir: join(dataDir, "..", "pdf") });
      const list = ApplicationsResponseSchema.parse((await h.get("/applications")).json());
      expect(list.applications).toHaveLength(2);
      expect(list.applications.every((i) => i.application.origin === "imported" && i.partialRecord)).toBe(true);
      const id = list.applications.find((i) => i.job.company === "DEKON")!.application.id;
      const detail = ApplicationDetailSchema.parse((await h.get(`/applications/${id}`)).json());
      expect(detail.submission).toMatchObject({ consent: { ticked: true }, confirmationText: "Ứng tuyển việc làm thành công!", jdSnapshot: null });
      expect(detail.files.map((f) => f.id)).toEqual([`app-${id}-cv`]);
      const pdf = await h.get(`/files/app-${id}-cv`);
      expect(pdf.statusCode).toBe(200);
      expect(pdf.rawPayload.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    } finally {
      await h.close();
    }
  });
});

describe("runCli: pnpm --filter @bs-job-agents/orchestrator import:applications -- --data <dir> --file <yaml>", () => {
  it("opens <data>/app.db, imports, and prints a summary", () => {
    const { root, dataDir, file } = setup(["A.pdf", "B.pdf"], TWO);
    const out: string[] = [];
    expect(runCli(["--data", dataDir, "--file", file], { log: (l) => out.push(l) })).toBe(0);
    expect(out.join("\n")).toMatch(/imported 2, skipped 0/);
    const db = openDb(join(dataDir, "app.db"));
    expect(listApplications(db)).toHaveLength(2);
    db.$client.close();
    // The second run on the same folder is a no-op; relative paths resolve from where pnpm ran.
    expect(runCli(["--", "--data", "data", "--file", "imported.yaml"], { log: (l) => out.push(l) }, root)).toBe(0);
    expect(out.at(-1)).toMatch(/imported 0, skipped 2/);
  });

  it("explains its usage without --data or --file", () => {
    const err: string[] = [];
    expect(runCli([], { log: () => {}, error: (l) => err.push(l) })).toBe(2);
    expect(err.join("\n")).toMatch(/--data <dir> --file <yaml>/);
  });
});

describe("data.example/imported-applications.yaml", () => {
  it("holds the three TopCV applications of 2026-10-10 as in the prototype", () => {
    const file = ImportedApplicationsFileSchema.parse(parse(readFileSync(EXAMPLE, "utf8")));
    expect(file.applications.map((a) => [a.company, a.url.match(/(\d+)\.html$/)?.[1], a.submittedAt, a.pdf])).toEqual([
      ["DEKON", "2316742", "2026-10-10T15:40:00+07:00", "BA_HUYNH_DEKON_Figma_EN.pdf"],
      ["SMARTBIT", "2298533", "2026-10-10T15:44:00+07:00", "BA_HUYNH_SMARTBIT_Figma_EN.pdf"],
      ["YAVIET", "2325969", "2026-10-10T15:38:00+07:00", "BA_HUYNH_YAVIET_Figma_EN.pdf"],
    ]);
    expect(file.applications.every((a) => a.source === "topcv" && a.status === "submitted")).toBe(true);
  });
});
