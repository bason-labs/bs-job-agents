import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_HOST, DEFAULT_WEB_ORIGINS, checkDataDir, findRepoRoot, resolveConfig } from "./config.js";

const root = findRepoRoot();

describe("findRepoRoot", () => {
  it("is the folder that holds pnpm-workspace.yaml", () => {
    expect(existsSync(join(root, "pnpm-workspace.yaml"))).toBe(true);
    expect(existsSync(join(root, "apps", "orchestrator"))).toBe(true);
  });
});

describe("resolveConfig", () => {
  it("defaults to data/, bots/ and workflows/ at the repo root, port 4100 and the web app on port 3000", () => {
    const c = resolveConfig({});
    expect(c.dataDir).toBe(join(root, "data"));
    expect(c.botsDir).toBe(join(root, "bots"));
    expect(c.workflowsDir).toBe(join(root, "workflows"));
    expect(c.port).toBe(4100);
    expect(c.webOrigins).toEqual(DEFAULT_WEB_ORIGINS);
    expect(DEFAULT_WEB_ORIGINS).toEqual(["http://localhost:3000", "http://127.0.0.1:3000"]);
  });

  it("binds 127.0.0.1 only, whatever the environment says (S18)", () => {
    expect(resolveConfig({ ORCH_HOST: "0.0.0.0", HOST: "0.0.0.0" }).host).toBe("127.0.0.1");
    expect(DEFAULT_HOST).toBe("127.0.0.1");
  });

  it("resolves relative folder overrides against the repo root, not the process cwd", () => {
    const c = resolveConfig({ ORCH_DATA_DIR: "tmp/data-x", ORCH_BOTS_DIR: "/abs/bots", ORCH_WORKFLOWS_DIR: "wf" });
    expect(c.dataDir).toBe(join(root, "tmp", "data-x"));
    expect(c.botsDir).toBe("/abs/bots");
    expect(c.workflowsDir).toBe(join(root, "wf"));
  });

  it("reads the web app's origins from ORCH_WEB_ORIGINS and refuses one that is not a bare origin", () => {
    expect(resolveConfig({ ORCH_WEB_ORIGINS: "http://localhost:3100, http://127.0.0.1:3100" }).webOrigins).toEqual([
      "http://localhost:3100",
      "http://127.0.0.1:3100",
    ]);
    expect(() => resolveConfig({ ORCH_WEB_ORIGINS: "http://localhost:3000/app" })).toThrow(/ORCH_WEB_ORIGINS/);
    expect(() => resolveConfig({ ORCH_WEB_ORIGINS: "*" })).toThrow(/ORCH_WEB_ORIGINS/);
  });

  it("reads board credentials from ORCH_SECRETS_FILE, by default in the user's config folder (AD-4)", () => {
    expect(resolveConfig({ HOME: "/Users/ba" }).secretsFile).toBe("/Users/ba/.config/bs-job-agents/secrets.json");
    expect(resolveConfig({ ORCH_SECRETS_FILE: "/Users/ba/secrets.json" }).secretsFile).toBe("/Users/ba/secrets.json");
    // Relative: against the repo root, where FileSecretStore refuses it.
    expect(resolveConfig({ ORCH_SECRETS_FILE: "secrets.json" }).secretsFile).toBe(join(root, "secrets.json"));
  });

  it("keeps the ORCH_PORT override", () => {
    expect(resolveConfig({ ORCH_PORT: "5000" }).port).toBe(5000);
  });
});

describe("checkDataDir (S19, the runner's read-dir rule)", () => {
  it("accepts an absolute path without spaces, commas or parentheses", () => {
    expect(checkDataDir("/Users/bason/Documents/bason-labs/bs-job-agents/data")).toEqual({ ok: true });
  });

  it.each([
    ["/Users/bason/Library/Application Support/bs-job-agents/data", "space"],
    ["/Users/bason/jobs,2026/data", "comma"],
    ["/Users/bason/jobs (copy)/data", "parenthes"],
    ["/Users/bason/jobs\tx/data", "space"],
  ])("refuses %s", (path, word) => {
    const r = checkDataDir(path);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.detail).toMatch(new RegExp(word));
  });

  it("refuses a relative path", () => {
    expect(checkDataDir("data").ok).toBe(false);
  });
});
