"use client";

import { ArrowUp, Paperclip, X } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { ENGINE_NAMES } from "@/lib/api/map";
import type { BotSummary } from "@/lib/api/types";
import { filesFromClipboard, formatBytes, kindForFile } from "@/lib/files";
import { FileDropzone, type FileDropzoneHandle } from "@/components/ui/FileDropzone";
import { useFileViewer } from "@/components/ui/FileViewer";
import { IconButton } from "@/components/ui/IconButton";
import type { Suggestion } from "./model";

interface Attachment {
  id: number;
  file: File;
  url: string;
}

export interface ComposerHandle {
  /** Puts text in the box (suggestion chips that start work). */
  fill: (text: string) => void;
}

export interface ComposerProps {
  bot: BotSummary | undefined;
  botName: string;
  suggestions: readonly Suggestion[];
  /** Upload + send; resolves true when sent (the composer then clears). */
  onSend: (text: string, files: File[]) => Promise<boolean>;
  disabled?: boolean;
}

let nextAttachment = 1;

/**
 * Prototype composer: suggestion chips, attachment chips (click → viewer, × removes), a text box
 * (⏎ sends, Shift+⏎ new line, IME-safe for Vietnamese), 📎 Attach file and drag-and-drop (UC-24),
 * the bot · engine chip and the send button.
 */
export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer({ bot, botName, suggestions, onSend, disabled = false }, ref) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<Attachment[]>([]);
  const [sending, setSending] = useState(false);
  const dropzone = useRef<FileDropzoneHandle>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const { openFile } = useFileViewer();
  const display = bot?.displayName ?? botName;

  useImperativeHandle(ref, () => ({
    fill(value: string) {
      setText(value);
      requestAnimationFrame(() => {
        box.current?.focus();
        box.current?.setSelectionRange(value.length, value.length);
      });
    },
  }));

  // Grow the box with its text, up to ~6 lines.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const remove = (id: number) =>
    setFiles((xs) => {
      const gone = xs.find((x) => x.id === id);
      if (gone) URL.revokeObjectURL(gone.url);
      return xs.filter((x) => x.id !== id);
    });

  const submit = async (value = text) => {
    if (sending || disabled || (!value.trim() && files.length === 0)) return;
    setSending(true);
    try {
      const ok = await onSend(value.trim(), files.map((f) => f.file));
      if (ok) {
        files.forEach((f) => URL.revokeObjectURL(f.url));
        setFiles([]);
        setText("");
      }
    } finally {
      setSending(false);
    }
  };

  // F8: Cmd+V of a screenshot (or of files copied in Finder) attaches them like a drop, through
  // the same type and 10 MB checks; a text paste stays text.
  const onPaste = (e: ClipboardEvent<HTMLElement>) => {
    if (disabled) return;
    const pasted = filesFromClipboard(e.clipboardData, new Date());
    if (!pasted.length) return;
    e.preventDefault();
    dropzone.current?.add(pasted);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2 text-xs" data-testid="suggestions">
        {suggestions.map((s) => (
          <button
            key={s.label}
            type="button"
            disabled={sending || disabled}
            onClick={() => (s.send ? void submit(s.text) : (setText(s.text), box.current?.focus()))}
            className="rounded-full border border-border bg-surface/70 px-3 py-1 text-muted transition hover:text-fg disabled:opacity-50"
          >
            {s.label}
          </button>
        ))}
      </div>
      <FileDropzone
        ref={dropzone}
        multiple
        disabled={disabled}
        onFiles={(picked) => setFiles((xs) => [...xs, ...picked.map((file) => ({ id: nextAttachment++, file, url: URL.createObjectURL(file) }))])}
        dropHint="Drop to attach (PDF, Word, TXT, images · max 10 MB)"
        zoneClassName="rounded-3xl border border-border bg-surface/80 p-3 shadow-glow transition data-[drag-over=true]:border-dashed data-[drag-over=true]:border-accent data-[drag-over=true]:bg-accent/5"
      >
        {files.length ? (
          <ul className="mb-2 flex flex-wrap gap-2" aria-label="Attachments">
            {files.map((a) => {
              const kind = kindForFile(a.file.name, a.file.type);
              return (
                <li key={a.id} className="flex items-center gap-2 rounded-xl border border-border bg-surface-2 py-1 pr-1 pl-1.5 text-xs" data-testid="attachment-chip">
                  <button
                    type="button"
                    onClick={() => openFile({ name: a.file.name, kind, mime: a.file.type, url: a.url, sizeBytes: a.file.size })}
                    className="flex cursor-pointer items-center gap-1.5 hover:text-accent"
                  >
                    {kind === "image" ? (
                      // eslint-disable-next-line @next/next/no-img-element -- a local preview (blob: URL) of the file before it is sent
                      <img src={a.url} alt="" data-testid="attachment-thumbnail" className="size-8 shrink-0 rounded-md border border-border object-cover" />
                    ) : (
                      <Paperclip aria-hidden className="ml-1.5 size-3.5 text-muted" />
                    )}
                    <span className="max-w-48 truncate">{a.file.name}</span>
                  </button>
                  <span className="text-muted">{formatBytes(a.file.size)}</span>
                  <IconButton size="sm" label={`Remove ${a.file.name}`} icon={<X aria-hidden />} onClick={() => remove(a.id)} className="hover:text-danger" />
                </li>
              );
            })}
          </ul>
        ) : null}
        <textarea
          ref={box}
          rows={1}
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          aria-label={`Message ${display}`}
          placeholder={`Message ${display}…  (⏎ send · drop files here)`}
          className="block w-full resize-none bg-transparent px-1 py-1 text-sm leading-relaxed text-fg outline-none placeholder:text-muted/70"
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5 text-xs">
            <button
              type="button"
              disabled={disabled}
              onClick={() => dropzone.current?.open()}
              className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-muted transition hover:border-accent hover:text-fg disabled:opacity-50"
            >
              <Paperclip aria-hidden className="size-3.5" /> Attach file
            </button>
            <span className="truncate rounded-full border border-border px-2.5 py-1 text-muted" data-testid="engine-chip">
              {display}
              {bot ? ` · ${ENGINE_NAMES[bot.engine]}` : ""}
            </span>
          </div>
          <IconButton
            label="Send"
            variant="primary"
            icon={<ArrowUp aria-hidden />}
            disabled={sending || disabled || (!text.trim() && files.length === 0)}
            onClick={() => void submit()}
            className="rounded-full"
            data-testid="send"
          />
        </div>
      </FileDropzone>
    </div>
  );
});
