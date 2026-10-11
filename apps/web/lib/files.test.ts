import { ALLOWED_UPLOAD_TYPES, LIMITS, checkUploadFile } from "@bs-job-agents/shared";
import { describe, expect, it } from "vitest";
import { ACCEPTED_EXTENSIONS, ACCEPT_ATTR, MAX_FILE_BYTES, filesFromClipboard, formatBytes, kindForFile, kindForMime, pastedImageName, validateFile } from "./files";

describe("upload rules come from @bs-job-agents/shared (UC-24)", () => {
  it("uses the shared size limit and extensions, so the picker and the API agree", () => {
    expect(MAX_FILE_BYTES).toBe(LIMITS.uploadMaxBytes);
    const sharedExts = Object.values(ALLOWED_UPLOAD_TYPES).flat().map((e) => e.slice(1));
    expect([...ACCEPTED_EXTENSIONS]).toEqual(sharedExts);
    expect(ACCEPT_ATTR).toBe(".pdf,.doc,.docx,.txt,.png,.jpg,.jpeg");
  });

  it("accepts in the browser exactly what the API accepts", () => {
    const mimeFor: Record<string, string> = Object.fromEntries(
      Object.entries(ALLOWED_UPLOAD_TYPES).flatMap(([mime, exts]) => exts.map((e) => [e.slice(1), mime])),
    );
    for (const ext of ACCEPTED_EXTENSIONS) {
      const name = `file.${ext}`;
      expect(validateFile({ name, size: 1024 }).ok, ext).toBe(true);
      expect(checkUploadFile({ filename: name, mime: mimeFor[ext]!, size: 1024 }), ext).toBeNull();
    }
    expect(validateFile({ name: "big.pdf", size: LIMITS.uploadMaxBytes + 1 }).ok).toBe(false);
    expect(checkUploadFile({ filename: "big.pdf", mime: "application/pdf", size: LIMITS.uploadMaxBytes + 1 })).not.toBeNull();
  });
});

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

describe("pasted files (F8: Cmd+V of a screenshot)", () => {
  const at = new Date(2026, 9, 11, 17, 14, 30);
  const clipboard = (files: File[], text = "") => ({ files: files as unknown as FileList, getData: (t: string) => (t === "text/plain" ? text : "") });

  it("names a clipboard image pasted-image-<time> with its type's extension", () => {
    expect(pastedImageName("image/png", at)).toBe("pasted-image-20261011-171430.png");
    expect(pastedImageName("image/jpeg", at)).toBe("pasted-image-20261011-171430.jpg");
    const [shot, second] = filesFromClipboard(clipboard([new File(["png"], "image.png", { type: "image/png" }), new File(["x"], "", { type: "image/png" })]), at);
    expect([shot!.name, shot!.type, second!.name]).toEqual(["pasted-image-20261011-171430.png", "image/png", "pasted-image-20261011-171430-2.png"]);
  });

  it("keeps a copied file's own name, and a text paste stays text", () => {
    const pdf = new File(["%PDF"], "JD Acme.pdf", { type: "application/pdf" });
    expect(filesFromClipboard(clipboard([pdf]), at)).toEqual([pdf]);
    expect(filesFromClipboard(clipboard([new File(["png"], "image.png", { type: "image/png" })], "Hello from Word"), at)).toEqual([]);
    expect(filesFromClipboard(clipboard([]), at)).toEqual([]);
    expect(filesFromClipboard(null, at)).toEqual([]);
  });

  it("picks the viewer kind by mime for uploads (file.kind is just 'upload')", () => {
    expect(kindForMime("image/png")).toBe("image");
    expect(kindForMime("image/jpeg")).toBe("image");
    expect(kindForMime("application/pdf")).toBe("pdf");
    expect(kindForMime("text/plain; charset=utf-8")).toBe("text");
    expect(kindForMime("application/msword")).toBe("other");
    expect(kindForMime(undefined)).toBe("other");
  });
});
