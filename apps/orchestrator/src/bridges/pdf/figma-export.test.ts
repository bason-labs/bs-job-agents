// Regression: pdf.js 4 got no text out of Figma's PDF exports ("invalid font name" on the
// embedded fonts), so QA would have seen every CV as blank. A real bridge export must extract.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractText, pdfInfo } from "./index.js";

const FIXTURE = fileURLToPath(new URL("./__fixtures__/figma-export.pdf", import.meta.url));

describe("text from a real Figma export (figma-console-mcp exportAsync PDF)", () => {
  it("extracts the CV text, with words intact", async () => {
    const { text } = await extractText(FIXTURE);
    expect(text.length).toBeGreaterThan(1000);
    expect(text).toContain("SOFTWARE ENGINEER");
    expect(text).toContain("huynhthienba4@gmail.com");
    expect(text).not.toMatch(/\bwit h\b|\bper formance\b/);
  });
  it("is one A4 page", async () => {
    expect((await pdfInfo(FIXTURE)).onePageA4).toBe(true);
  });
});
