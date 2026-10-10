import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractText, extractTextFromBytes } from "./text.js";
import { HELVETICA_SPACE_EM, makePdf, writePdf } from "./test-pdfs.js";

describe("extractText", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bridges-pdftext-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps words intact when the PDF splits them into glyph runs (the PDFKit 'wit h' bug)", async () => {
    const path = join(dir, "split.pdf");
    // "wit"+"h" and "per"+"formance" are glued runs; the word gap is a real space width, no space glyph.
    await writePdf(path, [
      {
        runs: [
          { text: "Senior engineer", x: 40, y: 780 },
          { text: "wit", gapEm: HELVETICA_SPACE_EM },
          { text: "h", gapEm: 0 },
          { text: "per", gapEm: HELVETICA_SPACE_EM },
          { text: "formance", gapEm: 0 },
          { text: "focus.", gapEm: HELVETICA_SPACE_EM },
        ],
      },
    ]);
    const { text } = await extractText(path);
    expect(text).toBe("Senior engineer with performance focus.");
    expect(text).not.toMatch(/wit h|per formance/);
  });

  it("extracts a plain sentence exactly, without doubling real spaces", async () => {
    const bytes = await makePdf([{ runs: [{ text: "Built a design system with performance budgets", x: 40, y: 700 }] }]);
    const { text } = await extractTextFromBytes(bytes);
    expect(text).toBe("Built a design system with performance budgets");
  });

  it("ignores kerning-sized gaps inside a word", async () => {
    const bytes = await makePdf([
      {
        runs: [
          { text: "Ty", x: 40, y: 700 },
          { text: "pe", gapEm: 0.04 },
          { text: "Script", gapEm: -0.03 },
          { text: "and", gapEm: HELVETICA_SPACE_EM },
          { text: "React", gapEm: HELVETICA_SPACE_EM },
        ],
      },
    ]);
    const { text } = await extractTextFromBytes(bytes);
    expect(text).toBe("TypeScript and React");
  });

  it("returns lines top to bottom in content order, with positions", async () => {
    const bytes = await makePdf([
      {
        runs: [
          { text: "BA HUYNH", x: 40, y: 800, size: 18 },
          { text: "Software Engineer", x: 40, y: 776 },
          { text: "Experience", x: 40, y: 740, size: 13 },
        ],
      },
    ]);
    const result = await extractTextFromBytes(bytes);
    expect(result.text).toBe("BA HUYNH\nSoftware Engineer\nExperience");
    const lines = result.pages[0]?.lines ?? [];
    expect(lines.map((l) => l.text)).toEqual(["BA HUYNH", "Software Engineer", "Experience"]);
    expect(lines[0]?.fontSize).toBeCloseTo(18, 0);
    expect(lines[0]?.y).toBeCloseTo(800, 0);
    expect(lines[1]?.x).toBeCloseTo(40, 0);
  });

  it("keeps content order by default and sorts visually on request", async () => {
    // Drawn bottom line first: content order differs from visual order.
    const bytes = await makePdf([
      {
        runs: [
          { text: "second", x: 40, y: 600 },
          { text: "first", x: 40, y: 700 },
        ],
      },
    ]);
    expect((await extractTextFromBytes(bytes)).text).toBe("second\nfirst");
    expect((await extractTextFromBytes(bytes, { order: "visual" })).text).toBe("first\nsecond");
  });

  it("does not merge two columns that share a baseline", async () => {
    const bytes = await makePdf([
      {
        runs: [
          { text: "Skills", x: 40, y: 700 },
          { text: "Experience", x: 300, y: 700 },
        ],
      },
    ]);
    const { pages } = await extractTextFromBytes(bytes);
    // Same baseline, far apart: one line with a space, never glued together.
    expect(pages[0]?.text).toBe("Skills Experience");
  });

  it("separates pages and reports each page", async () => {
    const bytes = await makePdf([
      { runs: [{ text: "Page one", x: 40, y: 700 }] },
      { runs: [{ text: "Page two", x: 40, y: 700 }] },
    ]);
    const result = await extractTextFromBytes(bytes);
    expect(result.pages.map((p) => p.pageNumber)).toEqual([1, 2]);
    expect(result.pages.map((p) => p.text)).toEqual(["Page one", "Page two"]);
    expect(result.text).toBe("Page one\n\nPage two");
  });

  it("returns empty text for a page without text", async () => {
    const result = await extractTextFromBytes(await makePdf([{}]));
    expect(result.text).toBe("");
    expect(result.pages[0]?.lines).toEqual([]);
  });

  it("returns NFC text for accented Latin", async () => {
    // Helvetica (WinAnsi) has no Vietnamese glyphs; Latin-1 accents still exercise normalisation.
    const bytes = await makePdf([{ runs: [{ text: "Café résumé, naïve", x: 40, y: 700 }] }]);
    const { text } = await extractTextFromBytes(bytes);
    expect(text).toBe("Café résumé, naïve");
    expect(text).toBe(text.normalize("NFC"));
  });

  it("collapses repeated spaces by default (the template's 'engineer  with')", async () => {
    const bytes = await makePdf([{ runs: [{ text: "engineer  with", x: 40, y: 700 }] }]);
    expect((await extractTextFromBytes(bytes)).text).toBe("engineer with");
  });
});
