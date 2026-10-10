// SHA-256 helpers (spec §9.1, PM decision 2): lowercase hex, the form `Sha256Schema` accepts.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/** SHA-256 of in-memory bytes, lowercase hex. */
export function sha256Bytes(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** SHA-256 of a file, streamed (PDFs and screenshots never need to fit in memory). Lowercase hex. */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
