// Production implementations of the simplest ports: the system clock and a node:fs FileStore
// built on W2c's PDF file tools (streamed SHA-256, verified copy).
import { constants } from "node:fs";
import { access, copyFile, mkdir, open, readFile, realpath } from "node:fs/promises";
import { dirname, sep } from "node:path";
import { copyFileVerified } from "../bridges/pdf/files.js";
import { sha256File } from "../bridges/pdf/hash.js";
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

export const nodeFileStore: FileStore = {
  async copy(from, to) {
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
  },
  async copyVerified(from, to, expectedSha256) {
    const { sha256 } = await copyFileVerified(from, to, expectedSha256);
    return { sha256 };
  },
  sha256: (path) => sha256File(path),
  async exists(path) {
    return access(path).then(
      () => true,
      () => false,
    );
  },
  async readText(path) {
    try {
      return await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  },
  async readHead(path, bytes, within) {
    try {
      if (within !== undefined) {
        // Folder links resolved: the file must really sit inside `within` (PM2 M1).
        const [real, root] = await Promise.all([realpath(path), realpath(within)]);
        if (real !== root && !real.startsWith(root + sep)) return null;
      }
      // O_NOFOLLOW: a link as the file itself is never followed; fstat: a regular file only.
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!(await handle.stat()).isFile()) return null;
        const buffer = Buffer.alloc(bytes);
        const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
        return buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    } catch (err) {
      if (["ENOENT", "ENOTDIR", "ELOOP", "EISDIR"].includes((err as NodeJS.ErrnoException).code ?? "")) return null;
      throw err;
    }
  },
};
