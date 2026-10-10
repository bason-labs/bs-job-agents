"use client";

import { Upload } from "lucide-react";
import { useId, useRef, useState, type DragEvent } from "react";
import { cn } from "@/lib/cn";
import { ACCEPT_ATTR, ACCEPTED_LABEL, validateFile } from "@/lib/files";

export interface FileDropzoneProps {
  /** Receives only files that passed validation (type + ≤10 MB). */
  onFiles: (files: File[]) => void;
  multiple?: boolean;
  disabled?: boolean;
  label?: string;
  hint?: string;
  className?: string;
}

/**
 * Click or drag-and-drop file picker (UC-24). The native input is visually
 * hidden; the styled zone opens it. Rejected files are listed with a reason.
 */
export function FileDropzone({
  onFiles,
  multiple = false,
  disabled = false,
  label = "Drop files here or choose files",
  hint = `${ACCEPTED_LABEL} · up to 10 MB each`,
  className,
}: FileDropzoneProps) {
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

  const isFileDrag = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

  return (
    <div className={className}>
      <div
        data-testid="file-dropzone"
        data-drag-over={dragOver ? "true" : "false"}
        onDragEnter={(e) => {
          if (disabled || !isFileDrag(e)) return;
          e.preventDefault();
          setDragOver(true);
        }}
        onDragOver={(e) => {
          if (disabled || !isFileDrag(e)) return;
          e.preventDefault();
        }}
        onDragLeave={(e) => {
          // Ignore leave events fired when moving between children.
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          setDragOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (!disabled) handle(e.dataTransfer?.files ?? null);
        }}
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
      </div>
      {errors.length ? (
        <ul id={errorId} role="alert" className="mt-2 space-y-1 text-xs text-danger">
          {errors.map((msg) => (
            <li key={msg}>{msg}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
