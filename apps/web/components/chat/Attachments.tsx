"use client";

import type { ChatMessage } from "@bs-job-agents/shared";
import { Paperclip } from "lucide-react";
import type { WebApi } from "@/lib/api/contract";
import { useApi } from "@/lib/api/react";
import { formatBytes, kindForFile } from "@/lib/files";
import { useFileViewer, type ViewerFile } from "@/components/ui/FileViewer";
import { useChat } from "./ChatContext";

/**
 * F8: what a sent message's chips open. The message's `attachments` (name, mime, size and the file
 * id GET /files serves) come first; an older copy with only `uploadIds` falls back to the uploads
 * this tab made, then to "Attachment" (the viewer then sniffs the type from the response).
 */
export function attachmentFiles(
  message: Pick<ChatMessage, "uploadIds" | "attachments">,
  api: Pick<WebApi, "fileUrl">,
  uploads: Readonly<Record<string, { filename: string; mime: string; size: number }>>,
): ViewerFile[] {
  const fromServer = message.attachments ?? [];
  const known = new Set(fromServer.map((a) => a.id));
  const files: ViewerFile[] = fromServer.map((a) => ({
    name: a.filename,
    kind: kindForFile(a.filename, a.mime),
    mime: a.mime,
    url: api.fileUrl(a.file.id),
    downloadUrl: api.fileUrl(a.file.id, { download: true }),
    sizeBytes: a.size,
  }));
  for (const id of message.uploadIds) {
    if (known.has(id)) continue;
    const u = uploads[id];
    const fileId = `upload-${id}`;
    files.push({
      name: u?.filename ?? "Attachment",
      kind: u ? kindForFile(u.filename, u.mime) : "other",
      ...(u ? { mime: u.mime, sizeBytes: u.size } : {}),
      url: api.fileUrl(fileId),
      downloadUrl: api.fileUrl(fileId, { download: true }),
    });
  }
  return files;
}

/** One chip: an image shows a thumbnail; clicking opens the viewer (Download is inside it). */
export function AttachmentChip({ file }: { file: ViewerFile }) {
  const { openFile } = useFileViewer();
  const image = file.kind === "image" && file.url;
  return (
    <button
      type="button"
      onClick={() => openFile(file)}
      data-testid="message-attachment"
      data-kind={file.kind}
      className="inline-flex max-w-full cursor-pointer items-center gap-2 rounded-xl border border-border bg-surface p-1.5 pr-3 text-xs text-fg transition hover:border-accent"
    >
      {image ? (
        // eslint-disable-next-line @next/next/no-img-element -- Ba's upload from the orchestrator, not a static asset
        <img src={file.url} alt="" data-testid="attachment-thumbnail" className="size-12 shrink-0 rounded-lg border border-border object-cover" />
      ) : (
        <Paperclip aria-hidden className="ml-1.5 size-3.5 shrink-0 text-muted" />
      )}
      <span className="flex min-w-0 flex-col items-start">
        <span className="max-w-56 truncate">{file.name}</span>
        {file.sizeBytes ? <span className="text-muted">{formatBytes(file.sizeBytes)}</span> : null}
      </span>
    </button>
  );
}

/** The chips under Ba's message bubble (UC-24). */
export function MessageAttachments({ message }: { message: Pick<ChatMessage, "uploadIds" | "attachments"> }) {
  const api = useApi();
  const { uploads } = useChat();
  const files = attachmentFiles(message, api, uploads);
  if (!files.length) return null;
  return (
    <div className="flex max-w-[80%] flex-wrap justify-end gap-2" aria-label="Attachments">
      {files.map((f, i) => (
        <AttachmentChip key={`${i}-${f.url ?? f.name}`} file={f} />
      ))}
    </div>
  );
}
