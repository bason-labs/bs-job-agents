import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CSRF_HEADER, LIMITS, UploadsResponseSchema } from "@bs-job-agents/shared";
import { afterEach, describe, expect, it } from "vitest";
import { getUpload } from "../../db/index.js";
import { FILE_BYTES, TEST_HOST, WEB_ORIGIN, createApiHarness, type ApiHarness } from "../testing.js";

let h: ApiHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

interface Part {
  name: string;
  type: string;
  data: Buffer | string;
}

function multipart(files: Part[]): { payload: Buffer; contentType: string } {
  const boundary = "----bsja-test-boundary";
  const chunks = files.flatMap((f) => [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.name}"\r\nContent-Type: ${f.type}\r\n\r\n`),
    Buffer.from(f.data),
    Buffer.from("\r\n"),
  ]);
  return { payload: Buffer.concat([...chunks, Buffer.from(`--${boundary}--\r\n`)]), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function upload(x: ApiHarness, files: Part[], headers: Record<string, string> = {}) {
  const { payload, contentType } = multipart(files);
  return x.app.inject({
    method: "POST",
    url: "/uploads",
    headers: { host: TEST_HOST, origin: WEB_ORIGIN, [CSRF_HEADER]: "1", "content-type": contentType, ...headers },
    payload,
  });
}

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

describe("POST /uploads (UC-24)", () => {
  it("stores PDF, DOCX, TXT and images in data/uploads under their content hash; the viewer gets them by id", async () => {
    h = await createApiHarness();
    const res = await upload(h, [
      { name: "JD NovaPay.pdf", type: "application/pdf", data: FILE_BYTES.pdf },
      { name: "screenshot.png", type: "image/png", data: FILE_BYTES.png },
      { name: "notes.txt", type: "text/plain", data: "Senior Frontend Engineer, HCMC" },
      { name: "old-cv.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", data: FILE_BYTES.zip },
    ]);
    expect(res.statusCode, res.body).toBe(201);
    const body = UploadsResponseSchema.parse(res.json());
    expect(body.rejected).toEqual([]);
    expect(body.uploads.map((u) => [u.filename, u.mime, u.path])).toEqual([
      ["JD NovaPay.pdf", "application/pdf", `uploads/${sha(FILE_BYTES.pdf)}.pdf`],
      ["screenshot.png", "image/png", `uploads/${sha(FILE_BYTES.png)}.png`],
      ["notes.txt", "text/plain", `uploads/${sha("Senior Frontend Engineer, HCMC")}.txt`],
      ["old-cv.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", `uploads/${sha(FILE_BYTES.zip)}.docx`],
    ]);
    expect(body.uploads[0]).toMatchObject({ size: FILE_BYTES.pdf.length, sha256: sha(FILE_BYTES.pdf), messageId: null });
    expect(readFileSync(join(h.dataDir, body.uploads[0]!.path)).equals(FILE_BYTES.pdf)).toBe(true);
    const file = await h.get(`/files/upload-${body.uploads[0]!.id}`);
    expect(file.statusCode).toBe(200);
    expect(file.headers["content-type"]).toBe("application/pdf");
  });

  it("rejects, naming each file: a type not allowed, more than 10 MB, content that is not what it claims", async () => {
    h = await createApiHarness();
    const big = Buffer.concat([FILE_BYTES.pdf, Buffer.alloc(LIMITS.uploadMaxBytes)]);
    const res = await upload(h, [
      { name: "setup.exe", type: "application/octet-stream", data: "MZ binary" },
      { name: "huge.pdf", type: "application/pdf", data: big },
      { name: "fake.pdf", type: "application/pdf", data: "<html>not a pdf</html>" },
      { name: "ok.pdf", type: "application/pdf", data: FILE_BYTES.pdf },
    ]);
    expect(res.statusCode).toBe(201);
    const body = UploadsResponseSchema.parse(res.json());
    expect(body.uploads.map((u) => u.filename)).toEqual(["ok.pdf"]);
    expect(body.rejected).toEqual([
      { filename: "setup.exe", reason: "setup.exe: only PDF, DOC/DOCX, TXT, PNG or JPG files can be attached" },
      { filename: "huge.pdf", reason: "huge.pdf: files can be at most 10 MB" },
      { filename: "fake.pdf", reason: "fake.pdf: the file's content is not a PDF" },
    ]);
    expect(readdirSync(join(h.dataDir, "uploads"))).toEqual([`${sha(FILE_BYTES.pdf)}.pdf`]);
  });

  it("all files rejected: 200 with the reasons and nothing stored", async () => {
    h = await createApiHarness();
    const res = await upload(h, [{ name: "a.exe", type: "application/x-msdownload", data: "MZ" }]);
    expect(res.statusCode).toBe(200);
    expect(UploadsResponseSchema.parse(res.json()).uploads).toEqual([]);
    expect(existsSync(join(h.dataDir, "uploads"))).toBe(false);
  });

  it("never uses the client's file name as a path", async () => {
    h = await createApiHarness();
    const body = UploadsResponseSchema.parse((await upload(h, [{ name: "../../../etc/passwd.pdf", type: "application/pdf", data: FILE_BYTES.pdf }])).json());
    expect(body.uploads[0]!.filename).toBe("passwd.pdf");
    expect(body.uploads[0]!.path).toBe(`uploads/${sha(FILE_BYTES.pdf)}.pdf`);
    expect(getUpload(h.t.db, Number(body.uploads[0]!.id))?.path).toBe(`uploads/${sha(FILE_BYTES.pdf)}.pdf`);
  });

  it("the same file twice is two uploads of one stored file", async () => {
    h = await createApiHarness();
    await upload(h, [{ name: "a.pdf", type: "application/pdf", data: FILE_BYTES.pdf }]);
    const second = UploadsResponseSchema.parse((await upload(h, [{ name: "b.pdf", type: "application/pdf", data: FILE_BYTES.pdf }])).json());
    expect(second.uploads[0]!.id).toBe("2");
    expect(readdirSync(join(h.dataDir, "uploads"))).toHaveLength(1);
  });

  it("is multipart only, needs the CSRF header and the web app's origin, and at least one file", async () => {
    h = await createApiHarness();
    expect((await h.post("/uploads", { file: "x" })).statusCode).toBe(415);
    expect((await upload(h, [{ name: "a.pdf", type: "application/pdf", data: FILE_BYTES.pdf }], { [CSRF_HEADER]: "" })).statusCode).toBe(403);
    expect((await upload(h, [{ name: "a.pdf", type: "application/pdf", data: FILE_BYTES.pdf }], { origin: "http://evil.example" })).statusCode).toBe(403);
    expect((await upload(h, [])).statusCode).toBe(400);
    // Other routes still refuse multipart.
    const { payload, contentType } = multipart([{ name: "a.pdf", type: "application/pdf", data: FILE_BYTES.pdf }]);
    const other = await h.app.inject({ method: "POST", url: "/exports", headers: { host: TEST_HOST, origin: WEB_ORIGIN, [CSRF_HEADER]: "1", "content-type": contentType }, payload });
    expect(other.statusCode).toBe(415);
  });
});
