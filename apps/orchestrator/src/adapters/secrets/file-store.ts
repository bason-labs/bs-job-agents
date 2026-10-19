// AD-4 (REQ-24, design §5.3): FileSecretStore reads `{ "<source>": { "<name>": "<value>" } }` from the
// file named by ORCH_SECRETS_FILE (default ~/.config/bs-job-agents/secrets.json). It refuses a path
// inside the repository at start, warns when the file is readable by anyone but its owner, and reads
// the file on every call, so a renewed token works without a restart. A missing file, board or value
// is a missing credential, never an error; the file's content never reaches a log line.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { defaultSecretsFile } from "../../config.js";
import type { Logger, SecretStore } from "../../engine/ports.js";
import { Redactor } from "./redactor.js";

export { defaultSecretsFile };

export class SecretsFileRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretsFileRefusedError";
  }
}

/** The path with symlinks resolved as far as it exists (the file itself may not exist yet). */
function realish(path: string): string {
  let existing = resolve(path);
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    rest.unshift(existing.slice(parent.length).replace(/^[\\/]/, ""));
    existing = parent;
  }
  return join(realpathSync(existing), ...rest);
}

function isInside(path: string, root: string): boolean {
  const rel = relative(realish(root), realish(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export interface FileSecretStoreOptions {
  path: string;
  repoRoot: string;
  redactor?: Redactor;
  log?: Logger;
}

export class FileSecretStore implements SecretStore {
  readonly path: string;
  readonly redactor: Redactor;
  private readonly log: Logger | undefined;

  constructor(opts: FileSecretStoreOptions) {
    this.path = resolve(opts.path);
    if (isInside(this.path, opts.repoRoot)) {
      throw new SecretsFileRefusedError(`the secrets file ${this.path} is inside the repository (${opts.repoRoot}); keep it outside, e.g. ${defaultSecretsFile()} (ORCH_SECRETS_FILE)`);
    }
    this.redactor = opts.redactor ?? new Redactor();
    this.log = opts.log;
    if (existsSync(this.path) && (statSync(this.path).mode & 0o077) !== 0) {
      this.log?.warn(`the secrets file ${this.path} is readable by others; run: chmod 600 "${this.path}"`);
    }
  }

  credentials(source: string): Record<string, string> | null {
    const all = this.read();
    const entry = all?.[source];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const values = Object.fromEntries(Object.entries(entry).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== ""));
    if (Object.keys(values).length === 0) return null;
    this.redactor.register(Object.values(values));
    return values;
  }

  has(source: string): boolean {
    return this.credentials(source) !== null;
  }

  private read(): Record<string, unknown> | null {
    if (!existsSync(this.path)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      this.log?.warn(`the secrets file ${this.path} is not valid JSON; expected { "<source>": { "<name>": "<value>" } }`);
      return null;
    }
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  }
}
