import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sha256Schema } from "@bs-job-agents/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Bytes, sha256File } from "./hash.js";

describe("sha256", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bridges-hash-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("hashes bytes as lowercase hex that passes Sha256Schema", () => {
    const digest = sha256Bytes(Buffer.from("abc"));
    expect(digest).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(Sha256Schema.safeParse(digest).success).toBe(true);
  });

  it("hashes a file by streaming it and matches the in-memory digest", async () => {
    // > 64 KiB so the read stream delivers several chunks.
    const content = Buffer.alloc(300_000);
    for (let i = 0; i < content.length; i++) content[i] = (i * 31) % 251;
    const path = join(dir, "big.bin");
    await writeFile(path, content);

    const expected = createHash("sha256").update(content).digest("hex");
    await expect(sha256File(path)).resolves.toBe(expected);
    expect(sha256Bytes(content)).toBe(expected);
  });

  it("hashes an empty file", async () => {
    const path = join(dir, "empty.pdf");
    await writeFile(path, "");
    await expect(sha256File(path)).resolves.toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("rejects a missing file", async () => {
    await expect(sha256File(join(dir, "missing.pdf"))).rejects.toThrow(/ENOENT/);
  });
});
