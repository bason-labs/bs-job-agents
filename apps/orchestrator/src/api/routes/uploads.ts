// POST /uploads (UC-24): the composer's attachments, multipart/form-data (the one route that is not
// JSON). Each file is checked on its own: an allowed type (PDF, DOC/DOCX, TXT, PNG/JPG), at most
// 10 MB, and bytes that are what the type says. A refused file is listed with a message naming it;
// the others are stored. Files go to data/uploads/<sha256>.<ext>: the client's file name is only a
// display name, never a path. The message links them on send (W3a part 2).
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import multipart from "@fastify/multipart";
import {
  ALLOWED_UPLOAD_TYPES,
  API_ROUTES,
  LIMITS,
  UploadsResponseSchema,
  checkUploadFile,
  type Upload,
} from "@bs-job-agents/shared";
import type { FastifyInstance } from "fastify";
import { createUpload, mappers } from "../../db/index.js";
import { requireDb, type ApiContext } from "../context.js";
import { badRequest } from "../errors.js";
import { respond } from "../http.js";

export const UPLOADS_DIR = "uploads";
const MAX_FILES = 10;

/** The name Ba sees: no folders, no control characters, at most 200 characters. */
export function displayName(raw: string | undefined): string {
  const base = (raw ?? "").split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200);
  return clean === "" || clean === "." || clean === ".." ? "file" : clean;
}

const LABELS: Record<string, string> = {
  "application/pdf": "PDF",
  "application/msword": "Word document",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word document",
  "text/plain": "text file",
  "image/png": "PNG image",
  "image/jpeg": "JPG image",
};

/** The bytes are what the declared type says (§10.2 rule 4: uploads are untrusted). */
function contentMatches(mime: string, bytes: Buffer): boolean {
  switch (mime) {
    case "application/pdf":
      return bytes.subarray(0, 5).toString("latin1") === "%PDF-";
    case "image/png":
      return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "image/jpeg":
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    case "application/msword":
      return bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
    case "text/plain":
      return !bytes.includes(0);
    default:
      return false;
  }
}

export function uploadRoutes(app: FastifyInstance, ctx: ApiContext): void {
  // Multipart only here: its parser is registered in this route's own context.
  void app.register(async (child) => {
    await child.register(multipart, {
      throwFileSizeLimit: false,
      limits: { fileSize: LIMITS.uploadMaxBytes + 1, files: MAX_FILES, fields: 5, fieldSize: 1024, parts: MAX_FILES + 5, headerPairs: 50 },
    });
    child.post(API_ROUTES.uploads, { config: { multipart: true } }, async (req, reply) => {
      const db = requireDb(ctx);
      const now = ctx.now();
      const uploads: Upload[] = [];
      const rejected: { filename: string; reason: string }[] = [];
      let files = 0;
      for await (const part of req.parts()) {
        if (part.type !== "file") continue;
        files++;
        const filename = displayName(part.filename);
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of part.file as AsyncIterable<Buffer>) {
          size += chunk.length;
          if (size <= LIMITS.uploadMaxBytes) chunks.push(chunk);
        }
        const tooBig = part.file.truncated || size > LIMITS.uploadMaxBytes;
        const problem = checkUploadFile({ filename, mime: part.mimetype, size: tooBig ? LIMITS.uploadMaxBytes + 1 : size });
        if (problem) {
          rejected.push({ filename, reason: problem });
          continue;
        }
        const bytes = Buffer.concat(chunks);
        if (!contentMatches(part.mimetype, bytes)) {
          rejected.push({ filename, reason: `${filename}: the file's content is not a ${LABELS[part.mimetype] ?? part.mimetype}` });
          continue;
        }
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const ext = (ALLOWED_UPLOAD_TYPES as Record<string, readonly string[]>)[part.mimetype]!.find((e) => filename.toLowerCase().endsWith(e)) ?? "";
        const rel = `${UPLOADS_DIR}/${sha256}${ext}`;
        mkdirSync(join(ctx.config.dataDir, UPLOADS_DIR), { recursive: true });
        // Same content, same file: it never changes once written.
        await writeFile(join(ctx.config.dataDir, rel), bytes, { flag: "wx", mode: 0o600 }).catch((err: NodeJS.ErrnoException) => {
          if (err.code !== "EEXIST") throw err;
        });
        uploads.push(mappers.toUpload(createUpload(db, { filename, mime: part.mimetype, size: bytes.length, path: rel, sha256 }, { now })));
      }
      if (files === 0) throw badRequest("attach at least one file");
      void reply.code(uploads.length > 0 ? 201 : 200);
      return respond(UploadsResponseSchema, { uploads, rejected });
    });
  });
}
