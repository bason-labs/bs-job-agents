// Test support: small generated PDFs (pdf-lib is a devDependency; production code never imports this file).
import { writeFile } from "node:fs/promises";
import { PageSizes, PDFDocument, StandardFonts } from "pdf-lib";

/**
 * One text run. Without `x`, the run starts where the previous run ended plus `gapEm` × size;
 * without `y`, it sits on the previous run's baseline.
 */
export interface FixtureRun {
  text: string;
  y?: number;
  x?: number;
  size?: number;
  /** Gap before this run, in em, when `x` is omitted. 0 = glued to the previous run. */
  gapEm?: number;
}

export interface FixturePage {
  /** [width, height] in points; default A4 portrait. */
  size?: [number, number];
  runs?: FixtureRun[];
}

export const A4: [number, number] = [...PageSizes.A4] as [number, number];
export const FIGMA_A4: [number, number] = [595, 842];
export const LETTER: [number, number] = [...PageSizes.Letter] as [number, number];

/** Builds a PDF where every run is its own text object, like Figma's glyph-run export. */
export async function makePdf(pages: FixturePage[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const spec of pages) {
    const page = doc.addPage(spec.size ?? A4);
    let cursorX = 0;
    let baseline = 0;
    for (const run of spec.runs ?? []) {
      const size = run.size ?? 11;
      const x = run.x ?? cursorX + (run.gapEm ?? 0) * size;
      baseline = run.y ?? baseline;
      page.drawText(run.text, { x, y: baseline, size, font });
      cursorX = x + font.widthOfTextAtSize(run.text, size);
    }
  }
  return doc.save();
}

export async function writePdf(path: string, pages: FixturePage[]): Promise<Uint8Array> {
  const bytes = await makePdf(pages);
  await writeFile(path, bytes);
  return bytes;
}

/** Width of a space in Helvetica, in em (used to place words the way a layout engine would). */
export const HELVETICA_SPACE_EM = 0.278;
