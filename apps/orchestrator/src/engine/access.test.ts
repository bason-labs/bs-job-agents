// API research (AD-3, AD-4): engine/access.ts decides how a source is read. The secrets file is read
// only when the path is the account API and the board sends a token: never for a public-API board,
// a no-token board (TopCV, ITviec) or a board read in the browser.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceAccessRecordSchema, type BoardSource, type SourceAccessRecord } from "@bs-job-agents/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BoardApiScanner, type BoardMapper } from "../adapters/board-api/index.js";
import { HostGate } from "../adapters/http/index.js";
import { FileSecretStore } from "../adapters/secrets/index.js";
import { findRepoRoot } from "../config.js";
import { openTestDb } from "../db/client.js";
import { sourceAccess } from "./access.js";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function store(): FileSecretStore {
  const dir = mkdtempSync(join(tmpdir(), "access-"));
  dirs.push(dir);
  const path = join(dir, "secrets.json");
  writeFileSync(path, JSON.stringify({ itviec: { _session: "s" }, linkedin: { li_at: "x" } }), { mode: 0o600 });
  return new FileSecretStore({ path, repoRoot: findRepoRoot() });
}

const base = (source: BoardSource, over: Partial<SourceAccessRecord>): SourceAccessRecord =>
  SourceAccessRecordSchema.parse({
    source,
    researchedAt: "2026-10-19",
    publicApi: "none found",
    internalApiGetEndpoints: [{ method: "GET", host: `${source}.com`, pathPattern: "/api/jobs", purpose: "search", requiresAuth: true }],
    applyEndpoints: "none found",
    auth: { kind: "cookie", names: ["_session"], howToCopy: "DevTools" },
    termsOfUse: { url: "https://x/terms", clauses: ["No bots."] },
    accountRisk: "Low.",
    riskLevel: "low",
    chosenPath: "account_api",
    ...over,
  });

const noop: BoardMapper = { source: "itviec", scan: async () => ({ jobs: [] }) };

describe("sourceAccess reads the secrets file only when a token matters", () => {
  it("public API, no-token account API and browser boards never read it; a token account API board does", () => {
    const secrets = store();
    const read = vi.spyOn(secrets, "credentials");
    const records: Partial<Record<BoardSource, SourceAccessRecord>> = {
      itviec: base("itviec", { publicApi: { usable: true, needsDeveloperKey: false, endpoints: [{ method: "GET", host: "itviec.com", pathPattern: "/api/jobs", purpose: "search", requiresAuth: false }] }, chosenPath: "public_api" }),
      topcv: base("topcv", { auth: { kind: "none", names: [], howToCopy: "" } }),
      linkedin: base("linkedin", { riskLevel: "high" }),
      upwork: base("upwork", {}),
    };
    const boards = new BoardApiScanner({
      fetch: () => Promise.reject(new Error("no network")),
      gate: new HostGate(),
      secrets,
      mappers: { itviec: noop, topcv: noop, linkedin: noop, upwork: noop },
      records: (s) => records[s]!,
    });
    const db = openTestDb();
    expect(sourceAccess(db, boards, "itviec")).toMatchObject({ path: "public_api", tokenMissing: false });
    expect(sourceAccess(db, boards, "topcv")).toMatchObject({ path: "account_api", labelKey: "account_api_direct" });
    // High risk, not approved: read in the browser, so the token does not matter yet.
    expect(sourceAccess(db, boards, "linkedin")).toMatchObject({ path: "browser", needsApproval: true });
    expect(read).not.toHaveBeenCalled();
    expect(sourceAccess(db, boards, "upwork")).toMatchObject({ path: "account_api", tokenMissing: true });
    expect(read).toHaveBeenCalledWith("upwork");
  });
});
