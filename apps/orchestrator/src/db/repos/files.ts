import { desc, eq, inArray } from "drizzle-orm";
import type { Conn } from "../client.js";
import { exports, uploads } from "../schema.js";
import { nowIso, type ClockOpts } from "../time.js";
import type { ExportRecord, Upload } from "../types.js";

// ---------------------------------------------------------------- uploads (UC-24)

export interface CreateUploadInput {
  filename: string;
  mime: string;
  size: number;
  /** Under data/uploads/. Type and 10 MB limit are checked by the API. */
  path: string;
  sha256: string;
  messageId?: number | null;
}

export function createUpload(db: Conn, input: CreateUploadInput, opts?: ClockOpts): Upload {
  return db
    .insert(uploads)
    .values({ ...input, messageId: input.messageId ?? null, uploadedAt: nowIso(opts) })
    .returning()
    .get();
}

export function getUpload(db: Conn, id: number): Upload | undefined {
  return db.select().from(uploads).where(eq(uploads.id, id)).get();
}

/** On send, link the message's attachments to it. */
export function attachUploads(db: Conn, uploadIds: readonly number[], messageId: number): number {
  if (uploadIds.length === 0) return 0;
  return db.update(uploads).set({ messageId }).where(inArray(uploads.id, [...uploadIds])).run().changes;
}

export function listUploadsForMessage(db: Conn, messageId: number): Upload[] {
  return db.select().from(uploads).where(eq(uploads.messageId, messageId)).orderBy(uploads.id).all();
}

// ---------------------------------------------------------------- exports (UC-13b)

export function recordExport(db: Conn, input: { path: string; applicationCount: number }, opts?: ClockOpts): ExportRecord {
  return db
    .insert(exports)
    .values({ ...input, createdAt: nowIso(opts) })
    .returning()
    .get();
}

/** Newest first. */
export function listExports(db: Conn): ExportRecord[] {
  return db.select().from(exports).orderBy(desc(exports.createdAt), desc(exports.id)).all();
}

/** Settings show the last export date. */
export function getLastExport(db: Conn): ExportRecord | undefined {
  return listExports(db)[0];
}
