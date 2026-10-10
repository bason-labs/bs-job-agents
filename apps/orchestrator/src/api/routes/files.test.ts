import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ApiErrorSchema } from "@bs-job-agents/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createUpload, recordExport, schema } from "../../db/index.js";
import { FILE_BYTES, createApiHarness, seedRecordedApplication, writeDataFile, type ApiHarness } from "../testing.js";
import { formatFileId, parseFileId } from "../files.js";

let h: ApiHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

describe("file ids", () => {
  it("round-trip, and anything else is not an id (no path ever comes from the client)", () => {
    for (const id of ["cv-12", "upload-3", "export-1", "app-5-cv", "app-5-presubmit", "app-5-confirmation", "app-5-jd", "app-5-jd-screenshot"]) {
      expect(formatFileId(parseFileId(id)!)).toBe(id);
    }
    for (const id of ["../etc/passwd", "cv-abc", "cv-0", "cv-01", "app-1-secret", "app-1", "pdf/x.pdf", "cv-1/../2", "upload-1.pdf", ""]) {
      expect(parseFileId(id)).toBeNull();
    }
  });
});

describe("GET /files/:id (§11 file viewer rule, S18)", () => {
  it("serves the record's files inline for the viewer, and as an attachment with ?download=1", async () => {
    h = await createApiHarness();
    const { application, cv } = seedRecordedApplication(h.t.db, h.dataDir);
    const pdf = await h.get(`/files/cv-${cv.id}`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.headers["content-disposition"]).toBe(`inline; filename="NOVAPAY_SENIOR-FE_EN_v1.pdf"; filename*=UTF-8''NOVAPAY_SENIOR-FE_EN_v1.pdf`);
    expect(pdf.rawPayload.equals(FILE_BYTES.pdf)).toBe(true);
    const download = await h.get(`/files/app-${application.id}-cv?download=1`);
    expect(download.headers["content-disposition"]).toMatch(/^attachment; filename="BA_HUYNH_NOVAPAY_EN\.pdf"/);
    const shot = await h.get(`/files/app-${application.id}-confirmation`);
    expect(shot.headers["content-type"]).toBe("image/png");
    const jdShot = await h.get(`/files/app-${application.id}-jd-screenshot`);
    expect(jdShot.headers["content-type"]).toBe("image/jpeg");
    expect(jdShot.headers["content-disposition"]).toMatch(/filename="jd\.jpg"/);
  });

  it("serves the frozen JD snapshot as text", async () => {
    h = await createApiHarness();
    const { application } = seedRecordedApplication(h.t.db, h.dataDir);
    const jd = await h.get(`/files/app-${application.id}-jd`);
    expect(jd.statusCode).toBe(200);
    expect(jd.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(jd.body).toContain("Senior Frontend Engineer (React/Next.js) — NovaPay");
    expect(jd.body).toContain("own our React/Next.js apps");
  });

  it("never reads a stored path outside data/: absolute, climbing, or through a symlink (M1 probe P1)", async () => {
    h = await createApiHarness();
    const { application } = seedRecordedApplication(h.t.db, h.dataDir);
    // A real image outside data/ that a bad row could name.
    const outside = join(dirname(h.dataDir), "secret.png");
    writeFileSync(outside, FILE_BYTES.png);
    const db = h.t.db.$client;
    // The record is immutable (§9.1), so the bad paths go into fresh rows the way a bot's output would.
    db.exec("DROP TRIGGER IF EXISTS submissions_no_update");
    db.prepare("UPDATE submissions SET pre_submit_screenshot_path = ?, confirmation_screenshot_path = ?, uploaded_path = ? WHERE application_id = ?").run(
      "../secret.png",
      outside,
      `applications/${application.id}/link.pdf`,
      application.id,
    );
    // A symlink inside data/ to a real PDF outside it: only the realpath check can refuse it.
    const outsidePdf = join(dirname(h.dataDir), "secret.pdf");
    writeFileSync(outsidePdf, FILE_BYTES.pdf);
    mkdirSync(join(h.dataDir, "applications", String(application.id)), { recursive: true });
    symlinkSync(outsidePdf, join(h.dataDir, "applications", String(application.id), "link.pdf"));
    for (const part of ["presubmit", "confirmation", "cv"]) {
      const res = await h.get(`/files/app-${application.id}-${part}`);
      expect(res.statusCode, part).toBe(404);
      expect(ApiErrorSchema.parse(res.json()).error.code).toBe("not_found");
    }
  });

  it("refuses a screenshot that is not an image and a CV that is not a PDF", async () => {
    h = await createApiHarness();
    const { application, cv } = seedRecordedApplication(h.t.db, h.dataDir);
    writeDataFile(h.dataDir, `applications/${application.id}/pre-submit.png`, "screenshot 3: confirmation page");
    writeDataFile(h.dataDir, "pdf/NOVAPAY_SENIOR-FE_EN_v1.pdf", "not a pdf");
    expect((await h.get(`/files/app-${application.id}-presubmit`)).statusCode).toBe(404);
    expect((await h.get(`/files/cv-${cv.id}`)).statusCode).toBe(404);
  });

  it("answers 404 for an unknown id, a malformed id and a missing file", async () => {
    h = await createApiHarness();
    for (const url of ["/files/cv-999", "/files/..%2f..%2fetc%2fpasswd", "/files/app-1-secret", "/files/%2e%2e"]) {
      expect((await h.get(url)).statusCode, url).toBe(404);
    }
    const { application } = seedRecordedApplication(h.t.db, h.dataDir, { files: false });
    expect((await h.get(`/files/app-${application.id}-confirmation`)).statusCode).toBe(404);
  });

  it("serves an upload with its stored type and an export as a ZIP", async () => {
    h = await createApiHarness();
    writeDataFile(h.dataDir, "uploads/abc.pdf", FILE_BYTES.pdf);
    const upload = createUpload(h.t.db, { filename: "JD NovaPay (final).pdf", mime: "application/pdf", size: FILE_BYTES.pdf.length, path: "uploads/abc.pdf", sha256: "b".repeat(64) });
    const res = await h.get(`/files/upload-${upload.id}?download=1`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toBe(
      `attachment; filename="JD NovaPay _final_.pdf"; filename*=UTF-8''JD%20NovaPay%20%28final%29.pdf`,
    );
    writeDataFile(h.dataDir, "exports/applications-1.zip", FILE_BYTES.zip);
    const exp = recordExport(h.t.db, { path: "exports/applications-1.zip", applicationCount: 1 });
    const zip = await h.get(`/files/export-${exp.id}?download=1`);
    expect(zip.headers["content-type"]).toBe("application/zip");
    expect(h.t.db.select().from(schema.exports).all()).toHaveLength(1);
  });

  it("file responses are sandboxed and never sniffed", async () => {
    h = await createApiHarness();
    const { cv } = seedRecordedApplication(h.t.db, h.dataDir);
    const res = await h.get(`/files/cv-${cv.id}`);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toContain("sandbox");
    expect(res.headers["cache-control"]).toBe("private, no-store");
  });
});
