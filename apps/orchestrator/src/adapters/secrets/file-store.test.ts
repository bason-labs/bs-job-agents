// AD-4 (REQ-24): board credentials live only in a local JSON file outside the repository, read
// through the SecretStore port; every value read is registered with the redactor.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findRepoRoot } from "../../config.js";
import { isInside } from "./file-store.js";
import { FileSecretStore, Redactor, SecretsFileRefusedError, defaultSecretsFile } from "./index.js";

const TOKEN = "li_at-AQEDAR-very-secret-value-123";
const CSRF = "ajax:1234567890123";
let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function secretsFile(content: unknown, mode = 0o600): string {
  dir = mkdtempSync(join(tmpdir(), "bsja-secrets-"));
  const path = join(dir, "secrets.json");
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  chmodSync(path, mode);
  return path;
}

function logger() {
  const lines: string[] = [];
  return { lines, log: { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m), error: (m: string) => lines.push(m) } };
}

const repoRoot = findRepoRoot();

describe("FileSecretStore", () => {
  it("reads several named values per board and registers each with the redactor", () => {
    const redactor = new Redactor();
    const store = new FileSecretStore({ path: secretsFile({ linkedin: { li_at: TOKEN, "csrf-token": CSRF } }), repoRoot, redactor });
    expect(store.credentials("linkedin")).toEqual({ li_at: TOKEN, "csrf-token": CSRF });
    expect(store.has("linkedin")).toBe(true);
    expect(store.credentials("itviec")).toBeNull();
    expect(store.has("itviec")).toBe(false);
    expect(redactor.redact(`Cookie: li_at=${TOKEN}; csrf ${CSRF}`)).toBe("Cookie: li_at=[redacted]; csrf [redacted]");
  });

  it("refuses a path inside the repository written with other letter case (macOS file systems ignore case)", () => {
    const upper = repoRoot.toUpperCase();
    expect(() => new FileSecretStore({ path: join(upper, "data", "secrets.json"), repoRoot, caseInsensitive: true })).toThrow(SecretsFileRefusedError);
    // Folding applies to the part of the path that does not exist yet, too.
    expect(isInside(join(repoRoot, "NEW-FOLDER", "secrets.json"), join(repoRoot, "new-folder"), true)).toBe(true);
    if (process.platform === "darwin") expect(() => new FileSecretStore({ path: join(upper, "data", "secrets.json"), repoRoot })).toThrow(/inside the repository/);
  });

  it("refuses a path inside the repository (REQ-24.AC-2)", () => {
    expect(() => new FileSecretStore({ path: join(repoRoot, "data", "secrets.json"), repoRoot })).toThrow(SecretsFileRefusedError);
    expect(() => new FileSecretStore({ path: join(repoRoot, "apps", "..", "secrets.json"), repoRoot })).toThrow(/inside the repository/);
  });

  it("a missing file or a board without values is a missing credential, never an error", () => {
    dir = mkdtempSync(join(tmpdir(), "bsja-secrets-"));
    const store = new FileSecretStore({ path: join(dir, "nope.json"), repoRoot });
    expect(store.credentials("itviec")).toBeNull();
    const empty = new FileSecretStore({ path: secretsFile({ itviec: {} }), repoRoot });
    expect(empty.credentials("itviec")).toBeNull();
  });

  it("an unreadable file is logged without its content", () => {
    const { lines, log } = logger();
    const store = new FileSecretStore({ path: secretsFile(`{"itviec": {"session": "${TOKEN}"`), repoRoot, log });
    expect(store.credentials("itviec")).toBeNull();
    expect(lines.join("\n")).toMatch(/not valid JSON/);
    expect(lines.join("\n")).not.toContain(TOKEN);
  });

  it("warns when anyone but its owner can read the file", () => {
    const { lines, log } = logger();
    new FileSecretStore({ path: secretsFile({}, 0o644), repoRoot, log });
    expect(lines.join("\n")).toMatch(/readable by others.*chmod 600/);
    const quiet = logger();
    new FileSecretStore({ path: secretsFile({}, 0o600), repoRoot, log: quiet.log });
    expect(quiet.lines).toEqual([]);
  });

  it("the default file is in the user's config folder, outside the repo", () => {
    expect(defaultSecretsFile({ HOME: "/Users/ba" })).toBe("/Users/ba/.config/bs-job-agents/secrets.json");
    expect(defaultSecretsFile({ HOME: "/Users/ba", XDG_CONFIG_HOME: "/cfg" })).toBe("/cfg/bs-job-agents/secrets.json");
  });
});

describe("Redactor", () => {
  it("redacts every registered value, longest first, and leaves short values alone", () => {
    const r = new Redactor();
    r.register(["abcdefgh", "abcdefghijkl", "ab"]);
    expect(r.redact("x abcdefghijkl y abcdefgh z ab")).toBe("x [redacted] y [redacted] z ab");
  });
});
