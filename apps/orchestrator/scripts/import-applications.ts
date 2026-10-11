// One-off import of applications made before this app (UC-13, pm-phase-3 S12), e.g. Ba's
// DEKON / SMARTBIT / YAVIET TopCV applications of 2026-10-10:
//
//   pnpm --filter @bs-job-agents/orchestrator import:applications -- --data <data dir> --file <yaml>
//
// Each row becomes a job (upsertJobCandidate: an existing job with the same URL is reused) and an
// `imported` application with a partial submission record (importApplication). Its PDF is copied
// into <data>/applications/<id>/ and hashed (SHA-256). Missing parts stay NULL, which the app
// shows as "not captured". Re-running skips every URL that already has an application.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ApplicationStatusSchema, IsoDateTimeSchema, JobSourceSchema, LanguageCodeSchema, SubmittedFieldSchema } from "@bs-job-agents/shared";
import { sql } from "drizzle-orm";
import { parse } from "yaml";
import { z } from "zod";
import {
  findJobByUrl,
  getApplicationByJob,
  importApplication,
  openDb,
  toIso,
  upsertJobCandidate,
  type Conn,
  type Db,
} from "../src/db/index.js";

export const ImportedApplicationSchema = z.strictObject({
  company: z.string().min(1),
  title: z.string().min(1),
  source: JobSourceSchema,
  url: z.string().url(),
  /** The JD's language; null when it was not captured. */
  language: LanguageCodeSchema.nullable().default(null),
  location: z.string().min(1).nullable().default(null),
  submittedAt: IsoDateTimeSchema,
  status: ApplicationStatusSchema.default("submitted"),
  /** File name in pdfDir, or a path (absolute, or relative to pdfDir). Null: no CV file. */
  pdf: z.string().min(1).nullable().default(null),
  fields: z.array(SubmittedFieldSchema).default([]),
  introText: z.string().min(1).nullable().default(null),
  consent: z.strictObject({ ticked: z.boolean(), text: z.string().min(1) }).nullable().default(null),
  confirmationText: z.string().min(1).nullable().default(null),
  finalUrl: z.string().url().nullable().default(null),
});
export type ImportedApplication = z.infer<typeof ImportedApplicationSchema>;

export const ImportedApplicationsFileSchema = z.strictObject({
  /** Where the PDFs are: absolute, or relative to the YAML file. Default: the YAML's folder. */
  pdfDir: z.string().min(1).nullable().default(null),
  applications: z.array(ImportedApplicationSchema),
});

export interface ImportReport {
  imported: Array<{ company: string; url: string; applicationId: number; jobId: number; pdfSha256: string | null }>;
  skipped: Array<{ company: string; url: string; reason: string }>;
  warnings: string[];
}

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportError";
  }
}

/** Read and validate the import file. Throws ImportError naming the file and the problem. */
export function readImportFile(file: string): z.infer<typeof ImportedApplicationsFileSchema> {
  let raw: unknown;
  try {
    raw = parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new ImportError(`imported-applications file ${file}: ${(err as Error).message}`);
  }
  const parsed = ImportedApplicationsFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new ImportError(`imported-applications file ${file} is invalid: ${issues}`);
  }
  return parsed.data;
}

interface Pdf {
  filename: string;
  bytes: Buffer;
  sha256: string;
}

/** The row's PDF, or null (with a warning) when it is missing. Refuses a file that is not a PDF. */
function readPdf(row: ImportedApplication, pdfDir: string, warnings: string[]): Pdf | null {
  if (!row.pdf) return null;
  const path = isAbsolute(row.pdf) ? row.pdf : join(pdfDir, row.pdf);
  if (!existsSync(path)) {
    warnings.push(`${row.company}: PDF not found at ${path}; imported without a CV file ("not captured")`);
    return null;
  }
  const bytes = readFileSync(path);
  if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") throw new ImportError(`${row.company}: ${path} is not a PDF`);
  return { filename: basename(path), bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** The id SQLite gives the next `applications` row (AUTOINCREMENT: past the highest id ever used). */
function nextApplicationId(db: Conn): number {
  const row = db.get<{ next: number }>(
    sql`SELECT COALESCE(MAX(n), 0) + 1 AS next FROM (SELECT seq AS n FROM sqlite_sequence WHERE name = 'applications' UNION ALL SELECT MAX(id) AS n FROM applications)`,
  );
  return row.next;
}

/**
 * Import every row of `file` into the database and data folder. Idempotent: a row whose URL
 * already has an application is skipped. All rows are checked (YAML and PDFs) before anything
 * is written; each row is then written in its own transaction with its PDF copy.
 */
export function importApplications(opts: { db: Db; dataDir: string; file: string; pdfDir?: string }): ImportReport {
  const input = readImportFile(opts.file);
  const pdfDir = resolve(dirname(opts.file), opts.pdfDir ?? input.pdfDir ?? ".");
  const report: ImportReport = { imported: [], skipped: [], warnings: [] };
  const rows = input.applications.map((row) => ({ row, pdf: readPdf(row, pdfDir, report.warnings) }));

  for (const { row, pdf } of rows) {
    const existingJob = findJobByUrl(opts.db, row.url);
    const existingApp = existingJob ? getApplicationByJob(opts.db, existingJob.id) : undefined;
    if (existingApp) {
      const reason = existingApp.origin === "imported" ? "already imported" : `already applied in the app (application ${existingApp.id})`;
      report.skipped.push({ company: row.company, url: row.url, reason });
      continue;
    }
    const copied: { dir?: string } = {};
    try {
      const done = opts.db.transaction((tx) => {
        const job =
          existingJob ??
          upsertJobCandidate(tx, {
            source: row.source,
            url: row.url,
            title: row.title,
            company: row.company,
            location: row.location ?? undefined,
            // jobs.language is nullable: an imported job's JD language may not have been captured.
            language: row.language as string,
          }).job;
        const id = nextApplicationId(tx);
        const uploadedPath = pdf ? `applications/${id}/${pdf.filename}` : null;
        if (pdf) {
          copied.dir = join(opts.dataDir, "applications", String(id));
          mkdirSync(copied.dir, { recursive: true });
          writeFileSync(join(copied.dir, pdf.filename), pdf.bytes, { mode: 0o600 });
        }
        const submittedAt = toIso(row.submittedAt);
        const { application } = importApplication(tx, {
          jobId: job.id,
          status: row.status,
          submittedAt,
          submission: {
            finalUrl: row.finalUrl,
            fields: row.fields,
            introText: row.introText,
            consentTicked: row.consent?.ticked ?? null,
            consentText: row.consent?.text ?? null,
            uploadedFilename: pdf?.filename ?? null,
            uploadedSha256: pdf?.sha256 ?? null,
            uploadedPath,
            confirmationText: row.confirmationText,
            submittedAt,
          },
        });
        if (application.id !== id) throw new ImportError(`${row.company}: expected application id ${id}, got ${application.id}`);
        return { applicationId: application.id, jobId: job.id };
      });
      report.imported.push({ company: row.company, url: row.url, ...done, pdfSha256: pdf?.sha256 ?? null });
    } catch (err) {
      if (copied.dir) rmSync(copied.dir, { recursive: true, force: true });
      throw err;
    }
  }
  return report;
}

const USAGE = "usage: pnpm --filter @bs-job-agents/orchestrator import:applications -- --data <dir> --file <yaml> [--pdf-dir <dir>]";

/**
 * The command line. Returns the exit code. Relative paths resolve from where Ba ran pnpm
 * (INIT_CWD), not from apps/orchestrator, where `pnpm --filter` runs the script.
 */
export function runCli(
  argv: readonly string[],
  out: { log: (line: string) => void; error?: (line: string) => void } = { log: console.info, error: console.error },
  cwd: string = process.env.INIT_CWD ?? process.cwd(),
): number {
  const error = out.error ?? out.log;
  let values: { data?: string; file?: string; "pdf-dir"?: string };
  try {
    ({ values } = parseArgs({
      args: argv.filter((a) => a !== "--"),
      options: { data: { type: "string" }, file: { type: "string" }, "pdf-dir": { type: "string" } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    error(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  if (!values.data || !values.file) {
    error(USAGE);
    return 2;
  }
  const dataDir = resolve(cwd, values.data);
  const db = openDb(join(dataDir, "app.db"));
  try {
    const report = importApplications({ db, dataDir, file: resolve(cwd, values.file), ...(values["pdf-dir"] ? { pdfDir: resolve(cwd, values["pdf-dir"]) } : {}) });
    for (const r of report.imported) out.log(`imported ${r.company} → application ${r.applicationId}${r.pdfSha256 ? ` (PDF sha256 ${r.pdfSha256.slice(0, 12)}…)` : ""}`);
    for (const s of report.skipped) out.log(`skipped ${s.company}: ${s.reason}`);
    for (const w of report.warnings) error(`warning: ${w}`);
    out.log(`imported ${report.imported.length}, skipped ${report.skipped.length} (data folder ${dataDir})`);
    return 0;
  } catch (err) {
    if (!(err instanceof ImportError)) throw err;
    error(err.message);
    return 1;
  } finally {
    db.$client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runCli(process.argv.slice(2));
}
