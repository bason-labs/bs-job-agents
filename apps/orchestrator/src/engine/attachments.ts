// F8 (live bug 2026-10-11, "I can't read the screenshot"): the files Ba attaches to a chat message
// reach the bot that answers it, without widening what that bot may read (rule 5 for Lead):
// - only a conversation task (lead.chat, <bot>.consult, <bot>.discussion), only the uploads linked
//   to the very message it answers, only types a bot can view (PNG/JPEG, PDF, TXT);
// - each is copied into the task's own folder, data/tasks/<id>/attachments/upload-<id>.<ext>
//   (named by the orchestrator: Ba's file name is untrusted and never part of a path), and its
//   first bytes must be what its type says;
// - the runner then allows Claude to Read that one folder (Lead gets no other file access) and
//   hands Codex the images with `-i`; the prompt lists them in an UNTRUSTED_CONTENT block.
// A file that is missing or does not match is left out (the history still names it).
import { join } from "node:path";
import { ALLOWED_UPLOAD_TYPES } from "@bs-job-agents/shared";
import { getUpload } from "../db/index.js";
import type { RunnerAttachment } from "../runner/types.js";
import type { EngineCore } from "./core.js";
import { errorMessage } from "./errors.js";

/** `upload-<id><ext>`: the file name's extension when UC-24 allows it for the mime type, else the type's own. */
export function uploadCopyName(file: { uploadId: string; filename: string; mime: string }): string {
  const id = file.uploadId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40) || "file";
  const allowed: readonly string[] = (ALLOWED_UPLOAD_TYPES as Record<string, readonly string[]>)[file.mime] ?? [];
  const fromName = /\.[A-Za-z0-9]{1,5}$/.exec(file.filename)?.[0]?.toLowerCase();
  return `upload-${id}${fromName && allowed.includes(fromName) ? fromName : (allowed[0] ?? "")}`;
}

/** Upload types a bot can look at, with the magic bytes a copy must start with (TXT: no NUL byte). */
const VIEWABLE: Record<string, ((head: Buffer) => boolean) | undefined> = {
  "image/png": (h) => h.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/jpeg": (h) => h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff,
  "application/pdf": (h) => h.subarray(0, 5).toString("latin1") === "%PDF-",
  "text/plain": (h) => !h.includes(0),
};

/** The attachments folder of a task (inside its own read folder, data/tasks/<id>/). */
export const attachmentsDir = (core: EngineCore, taskId: number): string => join(core.paths.abs(core.paths.taskDir(taskId)), "attachments");

const isSafeDataPath = (path: string): boolean => path !== "" && !path.startsWith("/") && !path.includes("\0") && !path.split(/[\\/]/).includes("..");

/**
 * Copy the viewable uploads of the message a conversation task answers into the task's
 * attachments folder. `input` is the task's ConversationInput / LeadChatInput.
 */
export async function prepareConversationAttachments(core: EngineCore, taskId: number, input: unknown): Promise<{ attachments: RunnerAttachment[]; dir: string } | null> {
  const { messageId, uploadIds } = (input ?? {}) as { messageId?: unknown; uploadIds?: unknown };
  if (!Array.isArray(uploadIds) || uploadIds.length === 0) return null;
  const dir = attachmentsDir(core, taskId);
  const attachments: RunnerAttachment[] = [];
  for (const raw of uploadIds) {
    const upload = getUpload(core.db, Number(raw));
    if (!upload || upload.messageId === null || String(upload.messageId) !== String(messageId)) continue;
    const matches = VIEWABLE[upload.mime];
    if (!matches || !isSafeDataPath(upload.path)) continue;
    const dest = join(dir, uploadCopyName({ uploadId: String(upload.id), filename: upload.filename, mime: upload.mime }));
    try {
      // Checked before the copy, so the folder the bot may read never holds a file that lies about its type.
      const head = await core.deps.files.readHead(core.paths.abs(upload.path), 8, core.paths.dataDir);
      if (!head || !matches(head)) {
        core.log.warn(`task ${taskId}: upload ${upload.id} is missing or not a ${upload.mime} file; it is not shown to the bot`);
        continue;
      }
      await core.deps.files.copy(core.paths.abs(upload.path), dest);
    } catch (err) {
      core.log.warn(`task ${taskId}: could not copy upload ${upload.id} for the bot: ${errorMessage(err)}`);
      continue;
    }
    attachments.push({ path: dest, name: upload.filename, mime: upload.mime });
  }
  return attachments.length > 0 ? { attachments, dir } : null;
}
