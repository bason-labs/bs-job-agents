// PDF file helpers for the export → approve → apply path (spec §9.1, PM decision 2).
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Sha256Schema } from "@bs-job-agents/shared";
import { sha256File } from "./hash.js";

/**
 * File name for a Drafts frame's PDF (data/pdf/<name>.pdf). Frame names come from a bot, so
 * everything but letters, digits, `.`, `_` and `-` becomes `_`, accents are dropped, and the
 * name can never start with a dot or contain a path separator.
 */
export function pdfFileNameForFrame(frameName: string): string {
  const base = frameName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, (c) => (c === "đ" ? "d" : "D"))
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 120);
  if (base === "") throw new Error(`frame name "${frameName}" has no usable characters for a file name`);
  return `${base}.pdf`;
}

export class Sha256MismatchError extends Error {
  override readonly name = "Sha256MismatchError";
  constructor(
    readonly path: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`SHA-256 of ${path} is ${actual}, expected ${expected}`);
  }
}

/**
 * Copies `src` to `dest` and checks the copy's SHA-256 against `expectedSha256` (the approved
 * cv_versions.pdf_sha256). On a mismatch the copy is removed and Sha256MismatchError is thrown:
 * that is the abort before Apply (PM decision 2b).
 */
export async function copyFileVerified(
  src: string,
  dest: string,
  expectedSha256: string,
): Promise<{ path: string; sha256: string; bytes: number }> {
  if (!Sha256Schema.safeParse(expectedSha256).success) throw new Error(`expected SHA-256 is not lowercase hex: "${expectedSha256}"`);
  const path = resolve(dest);
  await mkdir(dirname(path), { recursive: true });
  await copyFile(src, path);
  const actual = await sha256File(path);
  if (actual !== expectedSha256) {
    await rm(path, { force: true });
    throw new Sha256MismatchError(path, expectedSha256, actual);
  }
  return { path, sha256: actual, bytes: (await stat(path)).size };
}
