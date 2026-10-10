// Transcript of one attempt (§5.5 step 3): data/transcripts/<taskId>-<attempt>.jsonl.
// Raw CLI stdout lines are appended verbatim; anything the runner adds is a JSON line whose
// type starts with "runner." (spawn, stderr, exit, repair, result), so the file stays JSONL.
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

export class TranscriptWriter {
  private failed = false;

  private constructor(private readonly stream: WriteStream) {
    stream.on("error", () => {
      // A transcript write error must not crash the run; the result still reaches the engine.
      this.failed = true;
    });
  }

  /** Create parent folders and open for appending. Throws when the file cannot be created. */
  static async open(path: string): Promise<TranscriptWriter> {
    await mkdir(dirname(path), { recursive: true });
    const handle = await open(path, "a");
    await handle.close();
    return new TranscriptWriter(createWriteStream(path, { flags: "a" }));
  }

  /** A raw CLI line. A line that is not a single JSON value is wrapped so the file stays JSONL. */
  raw(line: string): void {
    if (line.length === 0) return;
    if (!line.includes("\n") && line.trimStart().startsWith("{")) this.write(line);
    else this.note({ type: "runner.raw", text: line });
  }

  /** A runner record, e.g. { type: "runner.repair", errors: [...] }. */
  note(record: { type: `runner.${string}` } & Record<string, unknown>): void {
    this.write(JSON.stringify(record));
  }

  get hadError(): boolean {
    return this.failed;
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.stream.end(() => resolve()));
  }

  private write(line: string): void {
    if (!this.failed) this.stream.write(`${line}\n`);
  }
}
