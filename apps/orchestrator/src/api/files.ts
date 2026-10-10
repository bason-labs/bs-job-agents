// Files by id (§11 file viewer rule, PM S18, M1). The UI never names a path: a file id names a row
// and the part of it (`cv-12`, `upload-3`, `export-1`, `app-5-confirmation`, …). The stored path is
// data/-relative; it is served only when it resolves inside data/ (also through symlinks), is a
// regular file and its bytes are what its kind says (a PDF, a PNG/JPEG screenshot, a ZIP). Bot
// output is untrusted: a record that names `../../etc/passwd` or "screenshot 3" yields no file.
// The JD snapshot is the record's frozen text, served as text/plain.
import { open, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, resolve, sep } from "node:path";
import type { FileKindSchema, FileRef } from "@bs-job-agents/shared";
import type { z } from "zod";
import { getCompany, getCvVersion, getJob, getSubmissionRecord, getUpload, listExports, type Db } from "../db/index.js";

type FileKind = z.infer<typeof FileKindSchema>;

/** A stored data/-relative path, or null for one that is absolute or climbs out of data/ (S18). */
export function safeDataPath(path: string | null | undefined): string | null {
  if (!path || isAbsolute(path) || path.includes("\0")) return null;
  return path.split(/[\\/]/).some((seg) => seg === "..") ? null : path;
}

export const APP_FILE_PARTS = ["cv", "presubmit", "confirmation", "jd", "jd-screenshot"] as const;
export type AppFilePart = (typeof APP_FILE_PARTS)[number];

export type FileId =
  /** The CV version's exported PDF (data/pdf/…). */
  | { type: "cv"; id: number }
  | { type: "upload"; id: number }
  | { type: "export"; id: number }
  /** A part of an application's §9.1 record. */
  | { type: "app"; id: number; part: AppFilePart };

export function formatFileId(f: FileId): string {
  return f.type === "app" ? `app-${f.id}-${f.part}` : `${f.type}-${f.id}`;
}

export function parseFileId(raw: string): FileId | null {
  const m = /^(?:(cv|upload|export)-([1-9]\d{0,15})|app-([1-9]\d{0,15})-(cv|presubmit|confirmation|jd|jd-screenshot))$/.exec(raw);
  if (!m) return null;
  if (m[1]) return { type: m[1] as "cv" | "upload" | "export", id: Number(m[2]) };
  return { type: "app", id: Number(m[3]), part: m[4] as AppFilePart };
}

type Sniffed = "pdf" | "png" | "jpeg" | "zip" | "ole" | "text" | null;

function sniff(head: Buffer): Sniffed {
  if (head.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpeg";
  if (head.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return "zip";
  if (head.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return "ole";
  if (!head.includes(0)) return "text";
  return null;
}

/** What a stored path names: a regular file inside data/ (after symlinks), with its first bytes. */
export interface DataFile {
  path: string;
  size: number;
  kind: Sniffed;
}

/** Resolve a stored data/-relative path, or null when it is absent, unsafe or not a file. */
export async function dataFile(dataDir: string, stored: string | null | undefined): Promise<DataFile | null> {
  const rel = safeDataPath(stored);
  if (!rel) return null;
  const root = resolve(dataDir);
  const candidate = resolve(root, rel);
  if (!candidate.startsWith(root + sep)) return null;
  let real: string;
  let realRoot: string;
  try {
    [real, realRoot] = await Promise.all([realpath(candidate), realpath(root)]);
  } catch {
    return null;
  }
  if (!real.startsWith(realRoot + sep)) return null;
  const st = await stat(real).catch(() => null);
  if (!st?.isFile()) return null;
  const handle = await open(real, "r");
  try {
    const head = Buffer.alloc(16);
    const { bytesRead } = await handle.read(head, 0, 16, 0);
    return { path: real, size: st.size, kind: sniff(head.subarray(0, bytesRead)) };
  } finally {
    await handle.close();
  }
}

/** A file the viewer can open: its FileRef, and either a path inside data/ or generated text. */
export interface ResolvedFile {
  ref: FileRef;
  path: string | null;
  size: number;
  text: string | null;
}

const IMAGE_MIME = { png: "image/png", jpeg: "image/jpeg" } as const;
const IMAGE_EXT = { png: "png", jpeg: "jpg" } as const;

function fromDisk(id: FileId, kind: FileKind, filename: string, mime: string, f: DataFile): ResolvedFile {
  return { ref: { id: formatFileId(id), kind, filename, mime }, path: f.path, size: f.size, text: null };
}

async function screenshot(dataDir: string, id: FileId, kind: FileKind, stored: string | null, name: string): Promise<ResolvedFile | null> {
  const f = await dataFile(dataDir, stored);
  if (!f || (f.kind !== "png" && f.kind !== "jpeg")) return null;
  return fromDisk(id, kind, `${name}.${IMAGE_EXT[f.kind]}`, IMAGE_MIME[f.kind], f);
}

async function pdf(dataDir: string, id: FileId, stored: string | null, filename: string | null): Promise<ResolvedFile | null> {
  const f = await dataFile(dataDir, stored);
  if (!f || f.kind !== "pdf") return null;
  return fromDisk(id, "cv_pdf", filename || basename(f.path), "application/pdf", f);
}

/** The upload's own type must agree with its bytes (it was checked on the way in, too). */
function uploadMatches(mime: string, kind: Sniffed): boolean {
  switch (mime) {
    case "application/pdf":
      return kind === "pdf";
    case "image/png":
      return kind === "png";
    case "image/jpeg":
      return kind === "jpeg";
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return kind === "zip";
    case "application/msword":
      return kind === "ole";
    case "text/plain":
      return kind === "text";
    default:
      return false;
  }
}

/** Resolve a file id to what the viewer may show, or null (unknown, unsafe, missing or wrong type). */
export async function resolveFile(db: Db, dataDir: string, id: FileId): Promise<ResolvedFile | null> {
  switch (id.type) {
    case "cv": {
      const cv = getCvVersion(db, id.id);
      return cv ? pdf(dataDir, id, cv.pdfPath, null) : null;
    }
    case "upload": {
      const up = getUpload(db, id.id);
      if (!up) return null;
      const f = await dataFile(dataDir, up.path);
      if (!f || !uploadMatches(up.mime, f.kind)) return null;
      return fromDisk(id, "upload", up.filename, up.mime, f);
    }
    case "export": {
      const exp = listExports(db).find((e) => e.id === id.id);
      if (!exp) return null;
      const f = await dataFile(dataDir, exp.path);
      if (!f || f.kind !== "zip") return null;
      return fromDisk(id, "export", basename(f.path), "application/zip", f);
    }
    case "app": {
      const rec = getSubmissionRecord(db, id.id);
      const s = rec?.submission;
      if (!rec) return null;
      switch (id.part) {
        case "cv":
          return s ? pdf(dataDir, id, s.uploadedPath, s.uploadedFilename) : null;
        case "presubmit":
          return s ? screenshot(dataDir, id, "screenshot", s.preSubmitScreenshotPath, "pre-submit") : null;
        case "confirmation":
          return s ? screenshot(dataDir, id, "screenshot", s.confirmationScreenshotPath, "confirmation") : null;
        case "jd-screenshot":
          return rec.snapshot ? screenshot(dataDir, id, "jd_screenshot", rec.snapshot.pageScreenshotPath, "jd") : null;
        case "jd": {
          const snap = rec.snapshot;
          if (!snap?.jdText) return null;
          const company = snap.company ?? getCompany(db, getJob(db, rec.application.jobId)?.companyId ?? 0)?.name ?? "";
          const text = [`${snap.title ?? ""} — ${company}`, snap.url ?? "", `Captured ${snap.capturedAt}`, "", snap.jdText, ""].join("\n");
          return {
            ref: { id: formatFileId(id), kind: "jd_snapshot", filename: "jd.txt", mime: "text/plain" },
            path: null,
            size: Buffer.byteLength(text),
            text,
          };
        }
      }
    }
  }
}

/** FileRefs for the ids that resolve (the viewer never gets a broken file). */
export async function fileRefs(db: Db, dataDir: string, ids: readonly FileId[]): Promise<FileRef[]> {
  const out: FileRef[] = [];
  for (const id of ids) {
    const f = await resolveFile(db, dataDir, id);
    if (f) out.push(f.ref);
  }
  return out;
}

/** One FileRef or null. */
export async function fileRef(db: Db, dataDir: string, id: FileId): Promise<FileRef | null> {
  return (await resolveFile(db, dataDir, id))?.ref ?? null;
}

/** RFC 6266 Content-Disposition with an ASCII fallback and the UTF-8 name (RFC 5987). */
export function contentDisposition(type: "inline" | "attachment", filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\()]/g, "_");
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
