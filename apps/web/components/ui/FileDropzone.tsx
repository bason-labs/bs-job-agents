"use client";

import { Upload } from "lucide-react";
import { forwardRef, useId, useImperativeHandle, useRef, useState, type DragEvent, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { ACCEPT_ATTR, ACCEPTED_LABEL, validateFile } from "@/lib/files";

export interface FileDropzoneHandle {
  /** Opens the file picker (wrap mode's own "Attach file" button). */
  open: () => void;
  /** Takes files from elsewhere (a paste, F8) through the same checks as a drop. */
  add: (files: File[]) => void;
}

export interface FileDropzoneProps {
  /** Receives only files that passed validation (type + ≤10 MB). */
  onFiles: (files: File[]) => void;
  multiple?: boolean;
  disabled?: boolean;
  label?: string;
  hint?: string;
  className?: string;
  /**
   * Wrap mode: `children` become the drop target (e.g. the chat composer, UC-24) instead of the
   * dashed zone; open the picker through the ref. Rejected files are listed the same way.
   */
  children?: ReactNode;
  /** Wrap mode: classes for the drop target; it carries data-drag-over="true" while files hover. */
  zoneClassName?: string;
  /** Wrap mode: shown inside the target while files are dragged over it. */
  dropHint?: ReactNode;
}

/**
 * Click or drag-and-drop file picker (UC-24). The native input is visually
 * hidden; the styled zone opens it. Rejected files are listed with a reason.
 */
export const FileDropzone = forwardRef<FileDropzoneHandle, FileDropzoneProps>(function FileDropzone(
  {
    onFiles,
    multiple = false,
    disabled = false,
    label = "Drop files here or choose files",
    hint = `${ACCEPTED_LABEL} · up to 10 MB each`,
    className,
    children,
    zoneClassName,
    dropHint,
  },
  ref,
) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const errorId = useId();
  const handle = (list: FileList | File[] | null) => {
    if (!list) return;
    let files = Array.from(list);
    if (!multiple) files = files.slice(0, 1);
    const accepted: File[] = [];
    const rejected: string[] = [];
    for (const f of files) {
      const check = validateFile(f);
      if (check.ok) accepted.push(f);
      else rejected.push(check.message);
    }
    setErrors(rejected);
    if (accepted.length) onFiles(accepted);
  };
  // No deps: the handle is rebuilt each render, so `add` uses the current props.
  useImperativeHandle(ref, () => ({
    open: () => inputRef.current?.click(),
    add: (files: File[]) => {
      if (!disabled) handle(files);
    },
  }));

  const isFileDrag = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  const wrap = children !== undefined;

  const dropHandlers = {
    onDragEnter: (e: DragEvent) => {
      if (disabled || !isFileDrag(e)) return;
      e.preventDefault();
      setDragOver(true);
    },
    onDragOver: (e: DragEvent) => {
      if (disabled || !isFileDrag(e)) return;
      e.preventDefault();
    },
    onDragLeave: (e: DragEvent<HTMLDivElement>) => {
      // Ignore leave events fired when moving between children.
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      setDragOver(false);
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      if (!disabled) handle(e.dataTransfer?.files ?? null);
    },
  };

  const input = (
    <input
      ref={inputRef}
      data-testid="file-dropzone-input"
      type="file"
      tabIndex={-1}
      aria-hidden
      className="sr-only"
      accept={ACCEPT_ATTR}
      multiple={multiple}
      disabled={disabled}
      onChange={(e) => {
        handle(e.target.files);
        e.target.value = "";
      }}
    />
  );

  const errorList = errors.length ? (
    <ul id={errorId} role="alert" className="mt-2 space-y-1 text-xs text-danger">
      {errors.map((msg) => (
        <li key={msg}>{msg}</li>
      ))}
    </ul>
  ) : null;

  if (wrap) {
    return (
      <div className={className}>
        <div data-testid="file-dropzone" data-drag-over={dragOver ? "true" : "false"} {...dropHandlers} className={zoneClassName}>
          {dragOver && dropHint ? <p className="px-2 pb-1 text-xs text-accent">{dropHint}</p> : null}
          {children}
          {input}
        </div>
        {errorList}
      </div>
    );
  }

  return (
    <div className={className}>
      <div
        data-testid="file-dropzone"
        data-drag-over={dragOver ? "true" : "false"}
        {...dropHandlers}
        className={cn(
          "flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-6 py-8 text-center transition",
          dragOver ? "border-accent bg-accent/10 shadow-glow" : "border-border bg-surface/60",
          disabled && "opacity-50",
        )}
      >
        <Upload aria-hidden className={cn("size-6", dragOver ? "text-accent" : "text-muted")} />
        <button
          type="button"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
          aria-describedby={errors.length ? errorId : undefined}
          className="text-sm font-medium text-fg underline-offset-4 hover:text-accent hover:underline disabled:no-underline"
        >
          {dragOver ? "Drop to attach" : label}
        </button>
        <p className="text-xs text-muted">{hint}</p>
        {input}
      </div>
      {errorList}
    </div>
  );
});
