"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type * as PdfJsModule from "pdfjs-dist";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { Skeleton } from "./Skeleton";

type PdfJs = typeof PdfJsModule;
let pdfjsPromise: Promise<PdfJs> | null = null;

/** Loads pdfjs-dist on demand (client only) and points it at its worker. */
function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= import("pdfjs-dist").then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
    return pdfjs;
  });
  return pdfjsPromise;
}

export interface PdfPagesProps {
  url: string;
  /** Percent, 100 = 1:1 PDF points. */
  zoom: number;
  onPageCount?: (count: number) => void;
  onCurrentPage?: (page: number) => void;
}

/** Renders every page of a PDF to canvases with PDF.js (spec §11 file viewer). */
export function PdfPages({ url, zoom, onPageCount, onCurrentPage }: PdfPagesProps) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const callbacks = useRef({ onPageCount, onCurrentPage });
  useLayoutEffect(() => {
    callbacks.current = { onPageCount, onCurrentPage };
  });
  const handleVisible = useCallback((n: number) => callbacks.current.onCurrentPage?.(n), []);

  useEffect(() => {
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    // Callers key this component by url, so state starts fresh per document.
    loadPdfJs()
      .then((pdfjs) => pdfjs.getDocument({ url }).promise)
      .then((d) => {
        loaded = d;
        if (cancelled) return void d.destroy();
        setDoc(d);
        callbacks.current.onPageCount?.(d.numPages);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
      void loaded?.destroy();
    };
  }, [url]);

  if (error) {
    return (
      <div role="alert" className="rounded-2xl border border-border bg-surface p-8 text-center text-sm">
        <p>Couldn&apos;t render this PDF.</p>
        <p className="mt-1 text-xs text-muted">Use Download to open it.</p>
      </div>
    );
  }
  if (!doc) {
    return (
      <div data-testid="pdf-loading" className="space-y-3">
        <Skeleton className="h-[842px] w-[595px] max-w-[85vw]" />
      </div>
    );
  }
  return (
    <div data-testid="pdf-pages" className="flex flex-col items-center gap-6">
      {Array.from({ length: doc.numPages }, (_, i) => (
        <PdfPage key={i} doc={doc} pageNumber={i + 1} zoom={zoom} onVisible={handleVisible} />
      ))}
    </div>
  );
}

function PdfPage({ doc, pageNumber, zoom, onVisible }: { doc: PDFDocumentProxy; pageNumber: number; zoom: number; onVisible: (n: number) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [rendered, setRendered] = useState(false);

  useEffect(() => {
    let task: RenderTask | null = null;
    let cancelled = false;
    void doc.getPage(pageNumber).then((page) => {
      const canvas = canvasRef.current;
      if (cancelled || !canvas) return;
      const viewport = page.getViewport({ scale: zoom / 100 });
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      task = page.render({ canvasContext: ctx, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
      task.promise.then(
        () => !cancelled && setRendered(true),
        () => {}, // cancelled by a newer zoom level
      );
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, pageNumber, zoom]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && onVisible(pageNumber), { threshold: 0.5 });
    io.observe(el);
    return () => io.disconnect();
  }, [onVisible, pageNumber]);

  return (
    <canvas
      ref={canvasRef}
      data-testid="pdf-page"
      data-page={pageNumber}
      data-rendered={rendered || undefined}
      aria-label={`Page ${pageNumber}`}
      className="rounded bg-white shadow-2xl"
    />
  );
}
