import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Bytes } from "./hash.js";
import { copyFileVerified, pdfFileNameForFrame, Sha256MismatchError } from "./files.js";

describe("pdfFileNameForFrame", () => {
  it("keeps frame names that are already safe", () => {
    expect(pdfFileNameForFrame("NOVAPAY_SENIOR-FE_EN_v1")).toBe("NOVAPAY_SENIOR-FE_EN_v1.pdf");
  });

  it("never lets a frame name become a path", () => {
    expect(pdfFileNameForFrame("../../etc/passwd")).toBe("etc_passwd.pdf");
    expect(pdfFileNameForFrame("a/b\\c:d")).toBe("a_b_c_d.pdf");
    expect(pdfFileNameForFrame(".hidden")).toBe("hidden.pdf");
  });

  it("drops accents and spaces", () => {
    expect(pdfFileNameForFrame("CÔNG TY Sao Việt_FE_VI_v2")).toBe("CONG_TY_Sao_Viet_FE_VI_v2.pdf");
  });

  it("caps the length and refuses names with nothing usable", () => {
    expect(pdfFileNameForFrame("X".repeat(300))).toHaveLength(120 + ".pdf".length);
    expect(() => pdfFileNameForFrame("../..")).toThrow(/frame name/);
    expect(() => pdfFileNameForFrame("")).toThrow(/frame name/);
  });
});

describe("copyFileVerified", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bridges-copy-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("copies the file and confirms the copy's SHA-256", async () => {
    const src = join(dir, "cv.pdf");
    const bytes = Buffer.from("%PDF-1.7 approved");
    await writeFile(src, bytes);
    const dest = join(dir, "applications", "42", "BA_HUYNH_NOVAPAY_EN.pdf");
    const res = await copyFileVerified(src, dest, sha256Bytes(bytes));
    expect(res).toEqual({ path: dest, sha256: sha256Bytes(bytes), bytes: bytes.length });
    expect(await readFile(dest)).toEqual(bytes);
  });

  it("aborts on a mismatch and leaves no copy", async () => {
    const src = join(dir, "cv.pdf");
    await writeFile(src, "%PDF-1.7 edited after approval");
    const dest = join(dir, "applications", "42", "cv.pdf");
    const err = await copyFileVerified(src, dest, sha256Bytes("%PDF-1.7 approved")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Sha256MismatchError);
    expect(err).toMatchObject({ expected: sha256Bytes("%PDF-1.7 approved"), actual: sha256Bytes("%PDF-1.7 edited after approval") });
    expect(existsSync(dest)).toBe(false);
  });

  it("PM2 S13: never follows a symbolic link at the destination; the link is replaced by the copy", async () => {
    const src = join(dir, "cv.pdf");
    const bytes = Buffer.from("%PDF-1.7 approved");
    await writeFile(src, bytes);
    const victim = join(dir, "victim.txt");
    await writeFile(victim, "keep me");
    const dest = join(dir, "applications", "42", "cv.pdf");
    await mkdir(join(dir, "applications", "42"), { recursive: true });
    await symlink(victim, dest);
    await copyFileVerified(src, dest, sha256Bytes(bytes));
    expect(await readFile(victim, "utf8")).toBe("keep me");
    expect((await lstat(dest)).isSymbolicLink()).toBe(false);
    expect(await readFile(dest)).toEqual(bytes);
  });

  it("PM2 S13: on a mismatch a destination link is removed, never written through", async () => {
    const src = join(dir, "cv.pdf");
    await writeFile(src, "%PDF-1.7 edited");
    const victim = join(dir, "victim.txt");
    await writeFile(victim, "keep me");
    const dest = join(dir, "cv-copy.pdf");
    await symlink(victim, dest);
    await expect(copyFileVerified(src, dest, sha256Bytes("%PDF-1.7 approved"))).rejects.toBeInstanceOf(Sha256MismatchError);
    expect(await readFile(victim, "utf8")).toBe("keep me");
    expect(existsSync(dest)).toBe(false);
    expect((await readdir(dir)).sort()).toEqual(["cv.pdf", "victim.txt"]);
  });

  it("refuses an expected hash that is not lowercase hex", async () => {
    const src = join(dir, "cv.pdf");
    await writeFile(src, "x");
    await expect(copyFileVerified(src, join(dir, "y.pdf"), "ABC")).rejects.toThrow(/SHA-256/);
  });
});
