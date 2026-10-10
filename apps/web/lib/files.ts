// File rules shared by FileDropzone, chat attachments (UC-24) and FileViewer. The
// allowed types and the size limit come from @bs-job-agents/shared, so the browser
// check and the API's checkUploadFile agree.
import { ALLOWED_UPLOAD_TYPES, LIMITS } from "@bs-job-agents/shared";

export const MAX_FILE_BYTES = LIMITS.uploadMaxBytes;
/** Without the dot: pdf, doc, docx, txt, png, jpg, jpeg. */
export const ACCEPTED_EXTENSIONS: readonly string[] = Object.values(ALLOWED_UPLOAD_TYPES)
  .flat()
  .map((ext) => ext.slice(1));
export const ACCEPT_ATTR = Object.values(ALLOWED_UPLOAD_TYPES).flat().join(",");
export const ACCEPTED_LABEL = "PDF, DOC, DOCX, TXT, PNG or JPG";

export type FileKind = "pdf" | "image" | "text" | "other";

export type FileCheck =
  | { ok: true }
  | { ok: false; reason: "type" | "size" | "empty"; message: string };

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

export function validateFile(file: Pick<File, "name" | "size">): FileCheck {
  const ext = extension(file.name);
  if (!(ACCEPTED_EXTENSIONS as readonly string[]).includes(ext)) {
    return { ok: false, reason: "type", message: `${file.name}: only ${ACCEPTED_LABEL} files are accepted.` };
  }
  if (file.size === 0) {
    return { ok: false, reason: "empty", message: `${file.name} is empty.` };
  }
  if (file.size > MAX_FILE_BYTES) {
    return { ok: false, reason: "size", message: `${file.name} is ${formatBytes(file.size)}; the limit is 10 MB.` };
  }
  return { ok: true };
}

export function kindForFile(name: string, mime = ""): FileKind {
  const ext = extension(name);
  if (ext === "pdf" || mime === "application/pdf") return "pdf";
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext) || mime.startsWith("image/")) return "image";
  if (ext === "txt" || mime.startsWith("text/")) return "text";
  return "other";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}
