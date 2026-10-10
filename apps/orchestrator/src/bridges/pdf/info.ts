// Page count and page size of a PDF (spec §6.2 fixed limits: A4 portrait, one page).
import { readPdfBytes, withPdf } from "./pdfjs.js";

export { PdfToolError, type PdfToolErrorCode } from "./pdfjs.js";

export interface PdfPageSize {
  widthPt: number;
  heightPt: number;
}

export interface PdfInfo {
  pageCount: number;
  /** Size of the first page (0 when the document has no pages). */
  widthPt: number;
  heightPt: number;
  pages: PdfPageSize[];
  /** Every page is A4 portrait. */
  isA4: boolean;
  /** Exactly one A4 portrait page: the CV rule. */
  onePageA4: boolean;
}

/** A4 in PostScript points. Figma exports its 595×842 frames as 595×842 pt. */
export const A4_PORTRAIT_PT: PdfPageSize = { widthPt: 595.28, heightPt: 841.89 };
const A4_TOLERANCE_PT = 1.5;

export function isA4Portrait(size: PdfPageSize, tolerancePt = A4_TOLERANCE_PT): boolean {
  return (
    Math.abs(size.widthPt - A4_PORTRAIT_PT.widthPt) <= tolerancePt &&
    Math.abs(size.heightPt - A4_PORTRAIT_PT.heightPt) <= tolerancePt
  );
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function pdfInfoFromBytes(bytes: Uint8Array): Promise<PdfInfo> {
  return withPdf(bytes, async (doc) => {
    const pages: PdfPageSize[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      // The viewport applies the crop box, /Rotate and /UserUnit: the size a reader shows.
      const viewport = page.getViewport({ scale: 1 });
      pages.push({ widthPt: round2(viewport.width), heightPt: round2(viewport.height) });
      page.cleanup();
    }
    const first = pages[0] ?? { widthPt: 0, heightPt: 0 };
    const isA4 = pages.length > 0 && pages.every((p) => isA4Portrait(p));
    return {
      pageCount: pages.length,
      widthPt: first.widthPt,
      heightPt: first.heightPt,
      pages,
      isA4,
      onePageA4: isA4 && pages.length === 1,
    };
  });
}

export async function pdfInfo(path: string): Promise<PdfInfo> {
  return pdfInfoFromBytes(await readPdfBytes(path));
}
