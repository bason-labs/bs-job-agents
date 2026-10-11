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

const PASTE_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg" };
const pad = (n: number) => String(n).padStart(2, "0");

/** "pasted-image-20261011-171430.png": a clipboard image's name, by the local time it was pasted. */
export function pastedImageName(mime: string, at: Date): string {
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `pasted-image-${stamp}.${PASTE_EXT[mime] ?? "png"}`;
}

/**
 * The files a paste carries (Cmd+V of a screenshot, or of files copied in Finder), with clipboard
 * images renamed `pasted-image-<time>.<ext>` (browsers call them all "image.png"). Empty when the
 * clipboard holds text: pasting text (even from Word, which adds a picture of it) stays a text paste.
 */
export function filesFromClipboard(data: Pick<DataTransfer, "files" | "getData"> | null, at: Date): File[] {
  if (!data || data.files.length === 0 || data.getData("text/plain").trim() !== "") return [];
  return Array.from(data.files).map((file, i) => {
    if (!file.type.startsWith("image/") || !(file.name === "" || /^image\.\w+$/i.test(file.name))) return file;
    const name = pastedImageName(file.type, at).replace(/(\.\w+)$/, i === 0 ? "$1" : `-${i + 1}$1`);
    return new File([file], name, { type: file.type, lastModified: file.lastModified });
  });
}

/** The viewer kind for a file known only by its mime (an upload's `file.kind` is just "upload"). */
export function kindForMime(mime: string | undefined): FileKind {
  return mime ? kindForFile("", mime.split(";")[0]!.trim().toLowerCase()) : "other";
}
