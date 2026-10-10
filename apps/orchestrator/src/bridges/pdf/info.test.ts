import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isA4Portrait, pdfInfo, pdfInfoFromBytes, PdfToolError } from "./info.js";
import { A4, FIGMA_A4, LETTER, makePdf, writePdf } from "./test-pdfs.js";

describe("pdfInfo", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bridges-pdfinfo-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads a one-page A4 PDF", async () => {
    const path = join(dir, "cv.pdf");
    await writePdf(path, [{ runs: [{ text: "BA HUYNH", x: 40, y: 800 }] }]);
    const info = await pdfInfo(path);
    expect(info.pageCount).toBe(1);
    expect(info.widthPt).toBeCloseTo(595.28, 1);
    expect(info.heightPt).toBeCloseTo(841.89, 1);
    expect(info.pages).toHaveLength(1);
    expect(info.isA4).toBe(true);
    expect(info.onePageA4).toBe(true);
  });

  it("accepts Figma's 595×842 frame export as A4", async () => {
    const info = await pdfInfoFromBytes(await makePdf([{ size: FIGMA_A4 }]));
    expect(info.widthPt).toBe(595);
    expect(info.heightPt).toBe(842);
    expect(info.onePageA4).toBe(true);
  });

  it("flags two pages", async () => {
    const info = await pdfInfoFromBytes(await makePdf([{ size: A4 }, { size: A4 }]));
    expect(info.pageCount).toBe(2);
    expect(info.pages).toHaveLength(2);
    expect(info.isA4).toBe(true);
    expect(info.onePageA4).toBe(false);
  });

  it("flags US Letter and A4 landscape", async () => {
    const letter = await pdfInfoFromBytes(await makePdf([{ size: LETTER }]));
    expect(letter.isA4).toBe(false);
    expect(letter.onePageA4).toBe(false);

    const landscape = await pdfInfoFromBytes(await makePdf([{ size: [A4[1], A4[0]] }]));
    expect(landscape.isA4).toBe(false);
  });

  it("flags a document whose later page is not A4", async () => {
    const info = await pdfInfoFromBytes(await makePdf([{ size: A4 }, { size: LETTER }]));
    expect(info.isA4).toBe(false);
    expect(info.pages[1]?.widthPt).toBeCloseTo(612, 0);
  });

  it("rejects bytes that are not a PDF with a typed error", async () => {
    const path = join(dir, "fake.pdf");
    await writeFile(path, "not a pdf at all");
    await expect(pdfInfo(path)).rejects.toBeInstanceOf(PdfToolError);
    await expect(pdfInfo(path)).rejects.toMatchObject({ code: "invalid_pdf" });
  });

  it("rejects a missing file with a typed error", async () => {
    await expect(pdfInfo(join(dir, "missing.pdf"))).rejects.toMatchObject({ code: "read_failed" });
  });

  it("isA4Portrait tolerates rounding but not other sizes", () => {
    expect(isA4Portrait({ widthPt: 595.28, heightPt: 841.89 })).toBe(true);
    expect(isA4Portrait({ widthPt: 595, heightPt: 842 })).toBe(true);
    expect(isA4Portrait({ widthPt: 596.5, heightPt: 842 })).toBe(true);
    expect(isA4Portrait({ widthPt: 600, heightPt: 842 })).toBe(false);
    expect(isA4Portrait({ widthPt: 842, heightPt: 595 })).toBe(false);
  });
});
