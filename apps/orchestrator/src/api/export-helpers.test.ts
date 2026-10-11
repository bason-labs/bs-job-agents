// Phase 3 QA (S18): the export's CSV cells cannot run as spreadsheet formulas (UC-13b: company and
// job text come from job sites), and a download's Content-Disposition cannot be split or spoofed by
// a stored file name.
import { describe, expect, it } from "vitest";
import { csvCell } from "./export.js";
import { contentDisposition } from "./files.js";

describe("csvCell (CSV injection)", () => {
  it("prefixes a cell that starts like a formula, and quotes it", () => {
    expect(csvCell("=1+1")).toBe(`"'=1+1"`);
    expect(csvCell("+cmd")).toBe(`"'+cmd"`);
    expect(csvCell("-2")).toBe(`"'-2"`);
    expect(csvCell("@SUM(A1)")).toBe(`"'@SUM(A1)"`);
    expect(csvCell("\t=1")).toBe(`"'\t=1"`);
  });

  it("also when spaces come first (some spreadsheet apps trim them)", () => {
    expect(csvCell(" =HYPERLINK(\"http://evil.example\")")).toBe(`"' =HYPERLINK(""http://evil.example"")"`);
    expect(csvCell("   @x")).toBe(`"'   @x"`);
  });

  it("leaves ordinary text alone and quotes commas, quotes and newlines", () => {
    expect(csvCell("NovaPay")).toBe("NovaPay");
    expect(csvCell("Senior FE, React")).toBe(`"Senior FE, React"`);
    expect(csvCell('say "hi"')).toBe(`"say ""hi"""`);
    expect(csvCell("a\nb")).toBe(`"a\nb"`);
    expect(csvCell(null)).toBe(`""`);
    expect(csvCell("Hồ Chí Minh")).toBe("Hồ Chí Minh");
  });
});

describe("contentDisposition (downloads)", () => {
  it("never lets a file name break out of the header", () => {
    const h = contentDisposition("attachment", 'a"\r\nX-Evil: y\\.pdf');
    expect(h).not.toMatch(/[\r\n]/);
    const fallback = /filename="([^"]*)"/.exec(h)![1]!;
    expect(fallback).not.toMatch(/["\\\r\n]/);
    expect(h).toMatch(/^attachment; filename="[^"]*"; filename\*=UTF-8''[A-Za-z0-9%._~!-]*$/);
  });

  it("keeps a Vietnamese name exactly in filename* and an ASCII stand-in in filename", () => {
    const h = contentDisposition("inline", "CV_Huỳnh_Bá.pdf");
    expect(h).toContain(`filename*=UTF-8''${encodeURIComponent("CV_Huỳnh_Bá.pdf")}`);
    expect(/filename="([^"]*)"/.exec(h)![1]).toMatch(/^[\x20-\x7e]+$/);
  });
});
