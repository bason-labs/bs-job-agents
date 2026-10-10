// Chat uploads (UC-24, §9 `uploads`).
import { z } from "zod";
import { IdSchema, IsoDateTimeSchema, LIMITS, Sha256Schema } from "../common/primitives.js";

/** PDF, DOC/DOCX, TXT, PNG/JPG. */
export const ALLOWED_UPLOAD_TYPES = {
  "application/pdf": [".pdf"],
  "application/msword": [".doc"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
  "text/plain": [".txt"],
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
} as const satisfies Record<string, readonly string[]>;

export type AllowedUploadMime = keyof typeof ALLOWED_UPLOAD_TYPES;
export const UploadMimeSchema = z.enum(Object.keys(ALLOWED_UPLOAD_TYPES) as [AllowedUploadMime, ...AllowedUploadMime[]]);

const extOf = (filename: string) => {
  const i = filename.lastIndexOf(".");
  return i < 0 ? "" : filename.slice(i).toLowerCase();
};

/** Returns null if allowed, otherwise a message naming the file (UC-24). */
export function checkUploadFile(file: { filename: string; mime: string; size: number }): string | null {
  const exts = (ALLOWED_UPLOAD_TYPES as Record<string, readonly string[]>)[file.mime];
  if (!exts || !exts.includes(extOf(file.filename))) {
    return `${file.filename}: only PDF, DOC/DOCX, TXT, PNG or JPG files can be attached`;
  }
  if (file.size > LIMITS.uploadMaxBytes) {
    return `${file.filename}: files can be at most 10 MB`;
  }
  return null;
}

export const UploadSchema = z.object({
  id: IdSchema,
  filename: z.string().min(1),
  mime: UploadMimeSchema,
  size: z.number().int().nonnegative().max(LIMITS.uploadMaxBytes),
  path: z.string().min(1),
  sha256: Sha256Schema,
  uploadedAt: IsoDateTimeSchema,
  messageId: IdSchema.nullable(),
});
export type Upload = z.infer<typeof UploadSchema>;
