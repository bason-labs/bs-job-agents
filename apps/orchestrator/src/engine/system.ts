// Production implementations of the simplest ports: the system clock and a node:fs FileStore.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, copyFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Clock, FileStore } from "./ports.js";

/** setTimeout caps delays at 2^31-1 ms (~24.8 days); longer timers re-arm. */
const MAX_DELAY_MS = 2 ** 31 - 1;

interface SystemTimer {
  timeout: NodeJS.Timeout | null;
}

export const systemClock: Clock = {
  now: () => new Date(),
  setTimer(delayMs, fn) {
    const handle: SystemTimer = { timeout: null };
    const due = Date.now() + Math.max(0, delayMs);
    const arm = () => {
      const left = due - Date.now();
      handle.timeout = setTimeout(left > MAX_DELAY_MS ? arm : fn, Math.min(Math.max(0, left), MAX_DELAY_MS));
      handle.timeout.unref?.();
    };
    arm();
    return handle;
  },
  clearTimer(handle) {
    const t = (handle as SystemTimer | null)?.timeout;
    if (t) clearTimeout(t);
  },
};

/** FileStore on the local disk; SHA-256 is streamed. W2c's helper can replace it. */
export const nodeFileStore: FileStore = {
  async copy(from, to) {
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
  },
  sha256(path) {
    return new Promise((resolve, reject) => {
      const hash = createHash("sha256");
      createReadStream(path)
        .on("error", reject)
        .on("data", (chunk) => hash.update(chunk))
        .on("end", () => resolve(hash.digest("hex")));
    });
  },
  async exists(path) {
    return access(path).then(
      () => true,
      () => false,
    );
  },
};
