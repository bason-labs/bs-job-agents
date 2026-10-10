import { describe, expect, it } from "vitest";
import { MAX_FILE_BYTES, formatBytes, kindForFile, validateFile } from "./files";

function file(name: string, size: number, type = "") {
  const f = new File(["x"], name, { type });
  Object.defineProperty(f, "size", { value: size });
  return f;
}

describe("validateFile", () => {
  it("accepts PDF, DOC, DOCX, TXT, PNG and JPG up to 10 MB", () => {
    for (const name of ["cv.pdf", "cv.doc", "cv.docx", "notes.txt", "shot.png", "shot.jpg", "shot.jpeg", "CV.PDF"]) {
      expect(validateFile(file(name, 1024))).toEqual({ ok: true });
    }
    expect(validateFile(file("cv.pdf", MAX_FILE_BYTES))).toEqual({ ok: true });
  });

  it("rejects other file types with a readable reason", () => {
    const r = validateFile(file("tool.exe", 100));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("type");
      expect(r.message).toMatch(/tool\.exe/);
      expect(r.message).toMatch(/PDF, DOC, DOCX, TXT, PNG or JPG/);
    }
  });

  it("rejects files over 10 MB", () => {
    const r = validateFile(file("big.pdf", MAX_FILE_BYTES + 1));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("size");
      expect(r.message).toMatch(/10 MB/);
    }
  });

  it("rejects empty files", () => {
    const r = validateFile(file("empty.pdf", 0));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("empty");
  });
});

describe("kindForFile", () => {
  it("maps names and mime types to viewer kinds", () => {
    expect(kindForFile("a.pdf")).toBe("pdf");
    expect(kindForFile("a.PNG")).toBe("image");
    expect(kindForFile("a.jpeg")).toBe("image");
    expect(kindForFile("a.txt")).toBe("text");
    expect(kindForFile("a.docx")).toBe("other");
    expect(kindForFile("blob", "application/pdf")).toBe("pdf");
  });
});

describe("formatBytes", () => {
  it("formats sizes for chips", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
  });
});
