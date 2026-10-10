// Reading-order PDF text for ATS checks (spec §5.2 QA, §6.2), PDF.js-based like pdfminer/pypdf.
//
// Figma exports text as many positioned glyph runs ("wit" + "h"). macOS PDFKit turns those
// into false word splits; here runs on the same line are glued unless the gap between them is
// at least a word space, so "wit"+"h" reads "with" and a real gap reads as one space.
import { readPdfBytes, withPdf } from "./pdfjs.js";

export interface ExtractedLine {
  text: string;
  /** Left edge and baseline of the line's first run, in PDF points (origin bottom-left). */
  x: number;
  y: number;
  /** Largest font size on the line, in points. */
  fontSize: number;
}

export interface ExtractedPage {
  pageNumber: number;
  text: string;
  lines: ExtractedLine[];
}

export interface ExtractedText {
  /** All pages; pages are separated by a blank line. */
  text: string;
  pages: ExtractedPage[];
}

export interface ExtractTextOptions {
  /**
   * `content` (default): the order the PDF draws text, which for Figma is the layer order and
   * keeps columns together, as content-order ATS parsers see it. `visual`: top-to-bottom, then
   * left-to-right.
   */
  order?: "content" | "visual";
  /** Collapse runs of spaces and trim lines (default true). */
  normalizeWhitespace?: boolean;
}

/** A gap of at least this many em between two runs on a line is a word space. */
const WORD_GAP_EM = 0.15;
/** Baselines closer than this many em belong to the same line. */
const SAME_LINE_EM = 0.35;
/** A run that starts further left than this many em before the line's end starts a new line. */
const BACKTRACK_EM = 0.5;

interface Run {
  str: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
}

interface LineAcc {
  parts: string[];
  x: number;
  y: number;
  endX: number;
  fontSize: number;
}

interface PdfjsTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL: boolean;
}

function isTextItem(item: unknown): item is PdfjsTextItem {
  return typeof item === "object" && item !== null && "str" in item && "transform" in item;
}

function toRun(item: PdfjsTextItem): Run {
  const [, , c = 0, d = 0, e = 0, f = 0] = item.transform;
  const fontSize = Math.hypot(c, d) || item.height || 1;
  return { str: item.str, x: e, y: f, width: item.width, fontSize };
}

const endsWithSpace = (parts: string[]) => /\s$/.test(parts[parts.length - 1] ?? "");

function buildLines(items: unknown[]): LineAcc[] {
  const lines: LineAcc[] = [];
  let current: LineAcc | null = null;
  for (const item of items) {
    if (!isTextItem(item) || item.str.length === 0) continue;
    const run = toRun(item);
    const em = Math.max(run.fontSize, current?.fontSize ?? 0);
    const sameLine =
      current !== null &&
      Math.abs(run.y - current.y) <= SAME_LINE_EM * em &&
      run.x >= current.endX - BACKTRACK_EM * em;
    if (current && sameLine) {
      const gap = run.x - current.endX;
      if (gap >= WORD_GAP_EM * em && !endsWithSpace(current.parts) && !/^\s/.test(run.str)) {
        current.parts.push(" ");
      }
      current.parts.push(run.str);
      current.endX = Math.max(current.endX, run.x + run.width);
      current.fontSize = Math.max(current.fontSize, run.fontSize);
    } else {
      current = { parts: [run.str], x: run.x, y: run.y, endX: run.x + run.width, fontSize: run.fontSize };
      lines.push(current);
    }
  }
  return lines;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function finishLines(acc: LineAcc[], opts: Required<ExtractTextOptions>): ExtractedLine[] {
  const ordered =
    opts.order === "visual" ? [...acc].sort((a, b) => b.y - a.y || a.x - b.x) : acc;
  const out: ExtractedLine[] = [];
  for (const line of ordered) {
    let text = line.parts.join("").normalize("NFC");
    if (opts.normalizeWhitespace) text = text.replace(/[ \t\u00a0]+/g, " ").trim();
    if (text.length === 0) continue;
    out.push({ text, x: round2(line.x), y: round2(line.y), fontSize: round2(line.fontSize) });
  }
  return out;
}

export async function extractTextFromBytes(bytes: Uint8Array, options: ExtractTextOptions = {}): Promise<ExtractedText> {
  const opts: Required<ExtractTextOptions> = {
    order: options.order ?? "content",
    normalizeWhitespace: options.normalizeWhitespace ?? true,
  };
  return withPdf(bytes, async (doc) => {
    const pages: ExtractedPage[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const lines = finishLines(buildLines(content.items), opts);
      pages.push({ pageNumber: n, text: lines.map((l) => l.text).join("\n"), lines });
      page.cleanup();
    }
    const text = pages
      .map((p) => p.text)
      .filter((t) => t.length > 0)
      .join("\n\n");
    return { text, pages };
  });
}

export async function extractText(path: string, options?: ExtractTextOptions): Promise<ExtractedText> {
  return extractTextFromBytes(await readPdfBytes(path), options);
}
