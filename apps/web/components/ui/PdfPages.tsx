"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
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

const VISIBILITY_STEPS = Array.from({ length: 21 }, (_, i) => i / 20);

export interface PdfPagesProps {
  url: string;
  /** Percent, 100 = 1:1 PDF points. */
  zoom: number;
  onPageCount?: (count: number) => void;
  /** The page that currently takes up the most of the screen. */
  onCurrentPage?: (page: number) => void;
}

/**
 * Renders every page of a PDF to canvases with PDF.js (spec §11 file viewer).
 * Callers key it by url, so state starts fresh for each document.
 */
export function PdfPages({ url, zoom, onPageCount, onCurrentPage }: PdfPagesProps) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onPageCount, onCurrentPage });
  useLayoutEffect(() => {
    callbacks.current = { onPageCount, onCurrentPage };
  });

  useEffect(() => {
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
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

  // Current page = the page with the most visible pixels (ties → the earlier page).
  useEffect(() => {
    const root = containerRef.current;
    if (!doc || !root || typeof IntersectionObserver === "undefined") return;
    const visible = new Map<number, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) visible.set(Number((e.target as HTMLElement).dataset.page), e.isIntersecting ? e.intersectionRect.height : 0);
        let best = 1;
        let bestPx = -1;
        for (const [page, px] of [...visible].sort((a, b) => a[0] - b[0])) {
          if (px > bestPx) {
            best = page;
            bestPx = px;
          }
        }
        callbacks.current.onCurrentPage?.(best);
      },
      { threshold: VISIBILITY_STEPS },
    );
    root.querySelectorAll("[data-page]").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [doc]);

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
      <div data-testid="pdf-loading">
        <Skeleton className="h-[842px] w-[595px] max-w-[85vw]" />
      </div>
    );
  }
  return (
    <div ref={containerRef} data-testid="pdf-pages" className="flex flex-col items-center gap-6">
      {Array.from({ length: doc.numPages }, (_, i) => (
        <PdfPage key={i} doc={doc} pageNumber={i + 1} zoom={zoom} />
      ))}
    </div>
  );
}

function PdfPage({ doc, pageNumber, zoom }: { doc: PDFDocumentProxy; pageNumber: number; zoom: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [rendered, setRendered] = useState(false);
  // PDF.js refuses two renders on one canvas at once: each zoom level waits
  // for the previous (cancelled) render to settle.
  const previous = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    let task: RenderTask | null = null;
    let cancelled = false;
    const run = previous.current.then(async () => {
      if (cancelled) return;
      const page = await doc.getPage(pageNumber);
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
      await task.promise;
      if (!cancelled) setRendered(true);
    });
    previous.current = run.catch(() => {}); // a cancelled render rejects; that's expected
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, pageNumber, zoom]);

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
