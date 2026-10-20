// API research (design §5.1, §5.6): how each source is read, for the Search criteria screen's labels,
// and Ba's approval of a high-risk board's account API. Never a credential value.
import { SourceAccessRecordSchema, SourceAccessResponseSchema, SourceAccessViewSchema, type BoardSource, type SourceAccessRecord } from "@bs-job-agents/shared";
import { afterEach, describe, expect, it } from "vitest";
import { BOARD_MAPPERS, BoardApiScanner } from "../../adapters/board-api/index.js";
import { HostGate } from "../../adapters/http/index.js";
import type { SecretStore } from "../../engine/ports.js";
import { createApiHarness, type ApiHarness } from "../testing.js";

const LI_AT = "AQEDAR-linkedin-SECRET-987654";
let h: ApiHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const linkedin: SourceAccessRecord = SourceAccessRecordSchema.parse({
  source: "linkedin",
  researchedAt: "2026-10-19T08:00:00.000Z",
  publicApi: "none found",
  internalApiGetEndpoints: [{ method: "GET", host: "www.linkedin.com", pathPattern: "/voyager/api/jobs", purpose: "search", requiresAuth: true }],
  applyEndpoints: "none found",
  auth: { kind: "cookie", names: ["li_at"], howToCopy: "DevTools" },
  termsOfUse: { url: "https://www.linkedin.com/legal/user-agreement", clauses: ["You agree not to use bots."] },
  accountRisk: "High: LinkedIn restricts accounts that automate.",
  riskLevel: "high",
  chosenPath: "account_api",
});
const itviec = SourceAccessRecordSchema.parse({ ...linkedin, source: "itviec", riskLevel: "low", accountRisk: "Low.", auth: { kind: "cookie", names: ["_session"], howToCopy: "" }, internalApiGetEndpoints: [{ method: "GET", host: "itviec.com", pathPattern: "/api/jobs", purpose: "search", requiresAuth: true }] });

function boards(creds: Record<string, Record<string, string>>) {
  const secrets: SecretStore = { credentials: (s) => creds[s] ?? null, has: (s) => creds[s] !== undefined };
  const records: Partial<Record<BoardSource, SourceAccessRecord>> = { linkedin, itviec };
  const noop = { source: "linkedin" as const, scan: async () => ({ jobs: [] }) };
  return new BoardApiScanner({
    fetch: async () => ({ ok: true, status: 200, text: async () => "{}" }),
    gate: new HostGate(),
    secrets,
    mappers: { linkedin: noop, itviec: { ...noop, source: "itviec" } },
    records: (s) => records[s] ?? SourceAccessRecordSchema.parse({ ...itviec, source: s, internalApiGetEndpoints: "none found", chosenPath: "browser" }),
  });
}

const view = async (source: string) => SourceAccessResponseSchema.parse((await h!.get("/sources/access")).json()).sources.find((s) => s.source === source)!;

describe("GET /sources/access", () => {
  it("a label per source: feeds public API, an account board, a risky one that needs approval, the browser", async () => {
    h = await createApiHarness({ engine: { boards: boards({ itviec: { _session: "x".repeat(20) } }) } });
    const res = await h.get("/sources/access");
    expect(res.statusCode).toBe(200);
    const { sources } = SourceAccessResponseSchema.parse(res.json());
    const by = Object.fromEntries(sources.map((s) => [s.source, s]));
    expect(sources).toHaveLength(10);
    expect(by.remotive).toMatchObject({ path: "public_api", labelKey: "public_api", termsOfUse: null, researchedAt: null });
    expect(by.itviec).toMatchObject({ path: "account_api", labelKey: "account_api", needsApproval: false, tokenMissing: false });
    expect(by.linkedin).toMatchObject({ path: "browser", labelKey: "account_api_needs_approval", needsApproval: true, approvedAt: null, riskLevel: "high", accountRisk: linkedin.accountRisk, termsOfUse: linkedin.termsOfUse, researchedAt: linkedin.researchedAt });
    expect(by.upwork).toMatchObject({ path: "browser", labelKey: "browser", needsApproval: false });
  });

  it("an approved account board without its token shows token missing; the response never carries a value", async () => {
    h = await createApiHarness({ engine: { boards: boards({ linkedin: { li_at: LI_AT } }) } });
    expect(await view("itviec")).toMatchObject({ path: "account_api", tokenMissing: true, labelKey: "account_api_token_missing" });
    expect((await h.post("/sources/linkedin/approval", { researchedAt: linkedin.researchedAt })).statusCode).toBe(200);
    expect(await view("linkedin")).toMatchObject({ path: "account_api", labelKey: "account_api", tokenMissing: false });
    expect((await h.get("/sources/access")).body).not.toContain(LI_AT);
  });

  it("without board APIs wired, every board reads in the browser", async () => {
    h = await createApiHarness();
    expect(await view("linkedin")).toMatchObject({ path: "browser", labelKey: "browser" });
  });
});

describe("POST/DELETE /sources/:source/approval", () => {
  it("approves the research Ba read, then revokes it", async () => {
    h = await createApiHarness({ engine: { boards: boards({ linkedin: { li_at: LI_AT } }) } });
    const res = await h.post("/sources/linkedin/approval", { researchedAt: linkedin.researchedAt });
    expect(SourceAccessViewSchema.parse(res.json())).toMatchObject({ source: "linkedin", path: "account_api", needsApproval: false, approvedAt: h.t.clock.now().toISOString() });
    const del = await h.del("/sources/linkedin/approval");
    expect(del.statusCode).toBe(200);
    expect(SourceAccessViewSchema.parse(del.json())).toMatchObject({ path: "browser", needsApproval: true, approvedAt: null });
  });

  it("LinkedIn in production (2026-10-20): needs approval, then reads Direct (no login); no token involved", async () => {
    const production = new BoardApiScanner({ fetch: async () => ({ ok: true, status: 200, text: async () => "" }), gate: new HostGate(), secrets: null });
    h = await createApiHarness({ engine: { boards: production } });
    const record = production.record("linkedin");
    expect(record).toMatchObject({ chosenPath: "account_api", riskLevel: "high", auth: { kind: "none" } });
    expect(await view("linkedin")).toMatchObject({ path: "browser", labelKey: "account_api_needs_approval", needsApproval: true, tokenMissing: false });
    expect((await h.post("/sources/linkedin/approval", { researchedAt: record.researchedAt })).statusCode).toBe(200);
    expect(await view("linkedin")).toMatchObject({ path: "account_api", labelKey: "account_api_direct", needsApproval: false, tokenMissing: false });
    expect(await view("vietnamworks")).toMatchObject({ path: "account_api", labelKey: "account_api_direct", needsApproval: false, approvedAt: null });
  });

  it("a board without an API reader is not approvable (409) and shows Browser", async () => {
    // The production records, but no LinkedIn mapper.
    const { linkedin: _li, ...others } = BOARD_MAPPERS;
    const noReader = new BoardApiScanner({ fetch: async () => ({ ok: true, status: 200, text: async () => "{}" }), gate: new HostGate(), secrets: null, mappers: others });
    h = await createApiHarness({ engine: { boards: noReader } });
    const record = noReader.record("linkedin");
    expect(await view("linkedin")).toMatchObject({ path: "browser", labelKey: "browser", needsApproval: false });
    const res = await h.post("/sources/linkedin/approval", { researchedAt: record.researchedAt });
    expect(res.statusCode).toBe(409);
    expect(JSON.stringify(res.json())).toMatch(/no API reader/);
    expect(await view("linkedin")).toMatchObject({ path: "browser", labelKey: "browser", approvedAt: null });
  });

  it("refuses stale research (409), a board with nothing to approve (409) and an unknown or feed source (404)", async () => {
    h = await createApiHarness({ engine: { boards: boards({}) } });
    expect((await h.post("/sources/linkedin/approval", { researchedAt: "2026-01-01" })).statusCode).toBe(409);
    expect((await h.post("/sources/itviec/approval", { researchedAt: itviec.researchedAt })).statusCode).toBe(409);
    expect((await h.post("/sources/upwork/approval", { researchedAt: itviec.researchedAt })).statusCode).toBe(409);
    expect((await h.post("/sources/remotive/approval", { researchedAt: "x" })).statusCode).toBe(404);
    expect((await h.post("/sources/nope/approval", { researchedAt: "x" })).statusCode).toBe(404);
    expect((await h.post("/sources/linkedin/approval", {})).statusCode).toBe(400);
  });
});
