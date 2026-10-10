// pdfjs-dist (legacy Node build) loader shared by pdfInfo and extractText.
// Spec §6.2: checks use a PDF.js/pdfminer-style extractor, never macOS PDFKit.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type * as PdfjsModule from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";

export type PdfToolErrorCode = "read_failed" | "invalid_pdf";

export class PdfToolError extends Error {
  override readonly name = "PdfToolError";
  constructor(
    readonly code: PdfToolErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

type Pdfjs = typeof PdfjsModule;

let pdfjs: Promise<Pdfjs> | undefined;
function loadPdfjs(): Promise<Pdfjs> {
  pdfjs ??= import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjs;
}

// Font and CMap data ship inside pdfjs-dist; in Node they are read from disk by path.
const pdfjsRoot = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
const STANDARD_FONT_DATA = join(pdfjsRoot, "standard_fonts") + "/";
const CMAPS = join(pdfjsRoot, "cmaps") + "/";

export async function readPdfBytes(path: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(path));
  } catch (err) {
    throw new PdfToolError("read_failed", `cannot read ${path}: ${(err as Error).message}`, { cause: err });
  }
}

/** Opens a PDF from bytes. The caller must `destroy()` the document. */
export async function openPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  const { getDocument, VerbosityLevel } = await loadPdfjs();
  try {
    // pdfjs may take ownership of the buffer, so hand it a copy.
    const task = getDocument({
      data: new Uint8Array(bytes),
      verbosity: VerbosityLevel.ERRORS,
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
      standardFontDataUrl: STANDARD_FONT_DATA,
      cMapUrl: CMAPS,
      cMapPacked: true,
    });
    return await task.promise;
  } catch (err) {
    throw new PdfToolError("invalid_pdf", `not a readable PDF: ${(err as Error).message}`, { cause: err });
  }
}

/** Runs `fn` on an opened document and always releases it. */
export async function withPdf<T>(bytes: Uint8Array, fn: (doc: PDFDocumentProxy) => Promise<T>): Promise<T> {
  const doc = await openPdf(bytes);
  try {
    return await fn(doc);
  } finally {
    await doc.destroy();
  }
}
