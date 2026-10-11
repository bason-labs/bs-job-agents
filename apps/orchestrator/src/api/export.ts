// ⬇ Export all (UC-13b): data/exports/applications-<UTC time>.zip with
// - applications.csv, one row per application (dry runs left out), BOM for spreadsheet apps;
// - one folder per application: submission.json (the record without its token), the uploaded CV,
//   jd.txt (the frozen JD text), jd/pre-submit/confirmation screenshots when captured.
// The ZIP is what Ba shares, so only files that resolve inside data/ with the right type go in
// (api/files.ts; PM M1), folder and file names are plain ASCII (no zip-slip for whoever unpacks it),
// and a CSV cell that would start a spreadsheet formula is quoted with a leading apostrophe.
import { open, readFile, rename, rm } from "node:fs/promises";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Zip, ZipDeflate, ZipPassThrough } from "fflate";
import { getSubmissionRecord, listApplications, mappers, recordExport, type Db, type ExportRecord } from "../db/index.js";
import { resolveFile, type AppFilePart } from "./files.js";
import { panelRecord } from "./views/applications.js";

export const EXPORTS_DIR = "exports";
const NOT_CAPTURED = "not captured";
/** Spreadsheet apps read a UTF-8 CSV (Vietnamese names) correctly only with a byte-order mark. */
const UTF8_BOM = String.fromCharCode(0xfeff);

/** A CSV cell: quoted when needed; a leading = + - @ (a formula) gets an apostrophe first. */
export function csvCell(value: string | null | undefined): string {
  let v = value ?? "";
  // A formula start, also after leading spaces (some spreadsheet apps trim them first).
  if (/^[\t\r]|^[ ]*[=+\-@]/.test(v)) v = `'${v}`;
  return /[",\n\r]/.test(v) || v !== value ? `"${v.replace(/"/g, '""')}"` : v;
}

/** ASCII letters and digits only (Vietnamese diacritics folded, đ → d), for folder names. */
export function asciiSlug(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 40);
}

const safeFileName = (name: string, fallback: string): string => {
  const base = name.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  return clean.length > 0 ? clean : fallback;
};

const stamp = (d: Date): string => d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

interface Entry {
  name: string;
  data: Uint8Array;
  /** Text compresses; PDFs and images are stored as they are. */
  compress: boolean;
}

/** Stream entries into a ZIP file (fflate's Zip is synchronous per entry; chunks are written between entries). */
async function writeZip(path: string, entries: AsyncIterable<Entry>, mtime: Date): Promise<void> {
  const handle = await open(path, "w", 0o600);
  const chunks: Uint8Array[] = [];
  let failure: Error | null = null;
  let finished = false;
  const zip = new Zip((err, data, final) => {
    if (err) failure = err;
    else chunks.push(data);
    if (final) finished = true;
  });
  const drain = async () => {
    while (chunks.length > 0) await handle.write(chunks.shift()!);
    if (failure) throw failure;
  };
  try {
    for await (const e of entries) {
      const file = e.compress ? new ZipDeflate(e.name, { level: 6 }) : new ZipPassThrough(e.name);
      file.mtime = mtime;
      zip.add(file);
      file.push(e.data, true);
      await drain();
    }
    zip.end();
    await drain();
    if (!finished) throw new Error("the ZIP was not finished");
  } finally {
    await handle.close();
  }
}

const utf8 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "utf8"));

async function* entriesFor(db: Db, dataDir: string, appIds: readonly number[], warn: (m: string) => void): AsyncGenerator<Entry> {
  const rows = ["application_id,company,role,source,url,cv_file,cv_sha256,submitted_at,status,origin"];
  for (const id of appIds) {
    const rec = getSubmissionRecord(db, id);
    if (!rec) continue;
    const app = rec.application;
    const s = rec.submission;
    const company = rec.company?.name ?? "";
    rows.push(
      [
        String(app.id),
        company,
        rec.job.title,
        rec.job.source,
        rec.job.url ?? "",
        s?.uploadedFilename ?? NOT_CAPTURED,
        s?.uploadedSha256 ?? NOT_CAPTURED,
        app.submittedAt ?? "",
        app.status,
        app.origin,
      ]
        .map(csvCell)
        .join(","),
    );
    const day = (app.submittedAt ?? app.createdAt).slice(0, 10);
    const folder = `${day}_${asciiSlug(company) || "company"}_${app.id}/`;
    const record = {
      application: mappers.toApplication(app),
      job: { id: String(rec.job.id), title: rec.job.title, company, url: rec.job.url, source: rec.job.source },
      submission: panelRecord(rec, warn),
    };
    yield { name: `${folder}submission.json`, data: utf8(`${JSON.stringify(record, null, 2)}\n`), compress: true };
    const parts: [AppFilePart, string][] = [
      ["cv", ""],
      ["jd", "jd"],
      ["jd-screenshot", "jd"],
      ["presubmit", "pre-submit"],
      ["confirmation", "confirmation"],
    ];
    for (const [part, stem] of parts) {
      const file = await resolveFile(db, dataDir, { type: "app", id: app.id, part });
      if (!file) continue;
      const ext = file.ref.filename.split(".").pop() ?? "bin";
      const name = part === "cv" ? safeFileName(file.ref.filename, "cv.pdf") : `${stem}.${ext}`;
      const data = file.text !== null ? utf8(file.text) : new Uint8Array(await readFile(file.path!));
      yield { name: `${folder}${name}`, data, compress: file.text !== null };
    }
  }
  yield { name: "applications.csv", data: utf8(`${UTF8_BOM}${rows.join("\n")}\n`), compress: true };
}

/** Build the ZIP of every real application, record it in `exports`, and return the row. */
export async function exportApplications(db: Db, dataDir: string, now: Date, warn: (m: string) => void): Promise<ExportRecord> {
  const ids = listApplications(db, { dryRun: false })
    .map((a) => a.id)
    .sort((a, b) => a - b);
  mkdirSync(join(dataDir, EXPORTS_DIR), { recursive: true });
  let rel = `${EXPORTS_DIR}/applications-${stamp(now)}.zip`;
  for (let n = 2; existsSync(join(dataDir, rel)); n++) rel = `${EXPORTS_DIR}/applications-${stamp(now)}-${n}.zip`;
  const tmp = join(dataDir, EXPORTS_DIR, `.tmp-${randomBytes(6).toString("hex")}.zip`);
  try {
    await writeZip(tmp, entriesFor(db, dataDir, ids, warn), now);
    await rename(tmp, join(dataDir, rel));
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return recordExport(db, { path: rel, applicationCount: ids.length }, { now });
}
