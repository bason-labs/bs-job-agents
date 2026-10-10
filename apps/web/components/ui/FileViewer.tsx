"use client";

import * as RadixDialog from "@radix-ui/react-dialog";
import { ClipboardList, Download, ExternalLink, FileText, Image as ImageIcon, Minus, Paperclip, Pin, Plus, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/files";
import { buttonClass } from "./Button";
import { PdfPages } from "./PdfPages";

export type ViewerKind = "pdf" | "image" | "text" | "form" | "other";

export interface ViewerFile {
  name: string;
  kind: ViewerKind;
  /** Preview source (PDF, image or text file). */
  url?: string;
  /** Original file for Download; defaults to `url`. Orchestrator: GET /files/:id?download=1. */
  downloadUrl?: string;
  /** Inline text (e.g. frozen JD snapshot) when there is no url. */
  text?: string;
  /** Shown after the name: "JD snapshot", "confirmation screenshot". */
  subtitle?: string;
  /** Form-preview variant: the fields Apply filled, just before submit. */
  fields?: { label: string; value: string }[];
  consentText?: string;
  formHeader?: string;
  /** Adds "Open in Figma ↗" (CV versions). */
  figmaUrl?: string;
  sizeBytes?: number;
}

const ZOOM_MIN = 50;
const ZOOM_MAX = 200;
const ZOOM_STEP = 25;

const KIND_ICON: Record<ViewerKind, ReactNode> = {
  pdf: <FileText aria-hidden className="size-4 text-accent" />,
  image: <ImageIcon aria-hidden className="size-4 text-accent" />,
  text: <Pin aria-hidden className="size-4 text-accent" />,
  form: <ClipboardList aria-hidden className="size-4 text-accent" />,
  other: <FileText aria-hidden className="size-4 text-muted" />,
};

export interface FileViewerProps {
  file: ViewerFile | null;
  onOpenChange: (open: boolean) => void;
}

/**
 * In-app file viewer (spec §11 file viewer rule). Clicking a file opens this
 * first; Download lives inside. Esc, ✕ or a click on the backdrop closes it.
 */
export function FileViewer({ file, onOpenChange }: FileViewerProps) {
  return (
    <RadixDialog.Root open={file !== null} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-[45] bg-black/60 backdrop-blur-sm" />
        <RadixDialog.Content
          data-testid="file-viewer"
          aria-describedby={undefined}
          className="fixed inset-0 z-[46] flex flex-col outline-none"
        >
          {file ? <ViewerBody key={file.url ?? file.name} file={file} onClose={() => onOpenChange(false)} /> : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

function ViewerBody({ file, onClose }: { file: ViewerFile; onClose: () => void }) {
  const [zoom, setZoom] = useState(100);
  const [pages, setPages] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [text, setText] = useState<string | null>(file.text ?? null);
  const href = file.downloadUrl ?? file.url;

  useEffect(() => {
    if (file.kind !== "text" || file.text !== undefined || !file.url) return;
    let cancelled = false;
    fetch(file.url)
      .then((r) => r.text())
      .then((t) => !cancelled && setText(t))
      .catch(() => !cancelled && setText("Couldn't load this file."));
    return () => {
      cancelled = true;
    };
  }, [file]);

  // Inline text without a file: download it as a .txt blob.
  const blobHref = useMemo(() => {
    if (href || file.kind !== "text" || text === null) return null;
    return URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  }, [href, file.kind, text]);
  useEffect(() => () => void (blobHref && URL.revokeObjectURL(blobHref)), [blobHref]);

  const subtitle =
    file.kind === "pdf" ? (pages ? `page ${page} of ${pages}` : "loading…") : (file.subtitle ?? (file.kind === "form" ? "pre-submit form" : undefined));
  const downloadHref = href ?? blobHref;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-surface/95 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          {KIND_ICON[file.kind]}
          <RadixDialog.Title className="truncate font-semibold">{file.name}</RadixDialog.Title>
          {subtitle ? (
            <span data-testid="file-viewer-subtitle" className="shrink-0 text-xs text-muted">
              · {subtitle}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {file.kind !== "other" ? (
            <div className="flex items-center rounded-xl border border-border text-muted">
              <button
                type="button"
                aria-label="Zoom out"
                disabled={zoom <= ZOOM_MIN}
                onClick={() => setZoom((z) => Math.max(ZOOM_MIN, z - ZOOM_STEP))}
                className="px-2.5 py-1.5 hover:text-fg disabled:opacity-40"
              >
                <Minus aria-hidden className="size-3.5" />
              </button>
              <span data-testid="file-viewer-zoom" className="tabular w-12 text-center text-xs">
                {zoom}%
              </span>
              <button
                type="button"
                aria-label="Zoom in"
                disabled={zoom >= ZOOM_MAX}
                onClick={() => setZoom((z) => Math.min(ZOOM_MAX, z + ZOOM_STEP))}
                className="px-2.5 py-1.5 hover:text-fg disabled:opacity-40"
              >
                <Plus aria-hidden className="size-3.5" />
              </button>
            </div>
          ) : null}
          {file.figmaUrl ? (
            <a href={file.figmaUrl} target="_blank" rel="noopener noreferrer" className={buttonClass({ size: "sm" })}>
              Open in Figma <ExternalLink aria-hidden className="size-3.5" />
            </a>
          ) : null}
          {downloadHref ? (
            <a href={downloadHref} download={file.name} className={buttonClass({ variant: "primary", size: "sm" })}>
              <Download aria-hidden className="size-4" /> Download
            </a>
          ) : (
            <button type="button" disabled className={buttonClass({ variant: "primary", size: "sm" })}>
              <Download aria-hidden className="size-4" /> Download
            </button>
          )}
          <RadixDialog.Close aria-label="Close" title="Close (Esc)" className={buttonClass({ size: "sm", className: "px-2.5" })}>
            <X aria-hidden className="size-4" />
          </RadixDialog.Close>
        </div>
      </div>
      <div
        data-testid="file-viewer-body"
        className="flex flex-1 justify-center overflow-auto p-4 sm:p-8"
        onClick={(e) => e.target === e.currentTarget && onClose()}
      >
        <div className="h-fit">
          <Preview file={file} zoom={zoom} text={text} onPageCount={setPages} onCurrentPage={setPage} />
        </div>
      </div>
    </>
  );
}

function Preview({
  file,
  zoom,
  text,
  onPageCount,
  onCurrentPage,
}: {
  file: ViewerFile;
  zoom: number;
  text: string | null;
  onPageCount: (n: number) => void;
  onCurrentPage: (n: number) => void;
}) {
  if (file.kind === "pdf" && file.url) {
    return <PdfPages key={file.url} url={file.url} zoom={zoom} onPageCount={onPageCount} onCurrentPage={onCurrentPage} />;
  }
  if (file.kind === "image" && file.url) {
    // eslint-disable-next-line @next/next/no-img-element -- user files from the orchestrator, not static assets
    return <img src={file.url} alt={file.name} className="max-w-none rounded shadow-2xl" style={{ width: `${7.6 * zoom}px` }} />;
  }
  if (file.kind === "text") {
    return (
      <div className="w-[680px] max-w-[90vw] bg-white p-10 text-slate-800 shadow-2xl" style={{ zoom: zoom / 100 }}>
        {file.subtitle ? <p className="mb-3 text-[10px] tracking-wider text-slate-400 uppercase">{file.subtitle}</p> : null}
        <pre data-testid="file-viewer-text" className="font-sans text-sm leading-relaxed whitespace-pre-wrap">
          {text ?? "Loading…"}
        </pre>
      </div>
    );
  }
  if (file.kind === "form") {
    return (
      <div data-testid="file-viewer-form" className="w-[760px] max-w-[90vw] overflow-hidden rounded-lg bg-white text-slate-800 shadow-2xl" style={{ zoom: zoom / 100 }}>
        <div className="bg-emerald-600 px-5 py-2 text-xs text-white">{file.formHeader ?? "Filled form — just before submit"}</div>
        <div className="space-y-3 p-8">
          {(file.fields ?? []).map((f) => (
            <div key={f.label}>
              <p className="text-xs text-slate-500">{f.label}</p>
              <div className="rounded-md border border-slate-300 px-3 py-2 text-sm">{f.value}</div>
            </div>
          ))}
          {file.consentText ? (
            <div className="flex items-center gap-2 text-sm">
              <span className="grid size-4 place-items-center rounded bg-emerald-600 text-[10px] text-white">✓</span>
              <span>{file.consentText}</span>
            </div>
          ) : null}
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-2 rounded-2xl border border-border bg-surface p-8 text-center">
      <FileText aria-hidden className="mx-auto size-8 text-muted" />
      <p>No preview for this file type.</p>
      <p className="text-xs text-muted">Use Download to open it.</p>
    </div>
  );
}

// ---------- provider + file chip ----------

interface FileViewerContextValue {
  openFile: (file: ViewerFile) => void;
  closeFile: () => void;
}

const FileViewerContext = createContext<FileViewerContextValue | null>(null);

/** Mount once near the root; any FileButton or useFileViewer().openFile() uses it. */
export function FileViewerProvider({ children }: { children: ReactNode }) {
  const [file, setFile] = useState<ViewerFile | null>(null);
  const openFile = useCallback((f: ViewerFile) => setFile(f), []);
  const closeFile = useCallback(() => setFile(null), []);
  const value = useMemo(() => ({ openFile, closeFile }), [openFile, closeFile]);
  return (
    <FileViewerContext.Provider value={value}>
      {children}
      <FileViewer file={file} onOpenChange={(open) => !open && closeFile()} />
    </FileViewerContext.Provider>
  );
}

export function useFileViewer(): FileViewerContextValue {
  const ctx = useContext(FileViewerContext);
  if (!ctx) throw new Error("useFileViewer must be used within a FileViewerProvider");
  return ctx;
}

/** File chip: clicking opens the viewer (never downloads straight away). */
export function FileButton({ file, className }: { file: ViewerFile; className?: string }) {
  const { openFile } = useFileViewer();
  return (
    <button
      type="button"
      onClick={() => openFile(file)}
      className={cn(
        "inline-flex max-w-full items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-xs text-fg transition hover:border-accent",
        className,
      )}
    >
      <Paperclip aria-hidden className="size-3.5 shrink-0 text-muted" />
      <span className="truncate">{file.name}</span>
      {file.sizeBytes ? <span className="shrink-0 text-muted">{formatBytes(file.sizeBytes)}</span> : null}
    </button>
  );
}
