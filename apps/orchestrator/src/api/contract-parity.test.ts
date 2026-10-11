// Phase 3 QA: the orchestrator's REST routes against the shared API_CONTRACT. Fails on drift:
// - a contract route the server does not serve, or a served route that is not in the contract;
// - a route whose handler answers (respond) or parses its body/query (parseWith) with another
//   schema than the contract's (the few deliberate local variants are listed with their reason).
// apps/web/lib/api/parity.test.ts checks the web client and mock against the same table.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as shared from "@bs-job-agents/shared";
import { API_ROUTES, apiEndpoints, type ApiMethod, type ApiRouteKey } from "@bs-job-agents/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiHarness, type ApiHarness } from "./testing.js";

const ROUTES_DIR = join(import.meta.dirname, "routes");
const SCHEMAS = shared as unknown as Record<string, unknown>;

interface Handler {
  file: string;
  method: ApiMethod;
  key: ApiRouteKey;
  responds: string[];
  parses: string[];
}

/** Every `app.<method>(API_ROUTES.<key>` registration in routes/, with the schemas its handler uses. */
function handlers(): Handler[] {
  const out: Handler[] = [];
  const reg = /\b(?:app|child)\.(get|post|put|patch|delete)(?:<[^>]*>)?\(\s*API_ROUTES\.([A-Za-z]+)/g;
  for (const file of readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
    const text = readFileSync(join(ROUTES_DIR, file), "utf8");
    const matches = [...text.matchAll(reg)];
    matches.forEach((m, i) => {
      const block = text.slice(m.index, matches[i + 1]?.index ?? text.length);
      out.push({
        file,
        method: m[1]!.toUpperCase() as ApiMethod,
        key: m[2] as ApiRouteKey,
        responds: [...block.matchAll(/\brespond\(\s*([A-Za-z]+)/g)].map((x) => x[1]!),
        parses: [...block.matchAll(/\bparseWith\(\s*([A-Za-z]+)/g)].map((x) => x[1]!),
      });
    });
  }
  return out;
}

/** Deliberate local variants of a contract schema, each with its reason. */
const LOCAL_VARIANTS: Record<string, { schema: string; why: string }[]> = {
  "POST reviewApprove": [
    { schema: "ApproveBodySchema", why: "ApproveRequestSchema.strict(): a mistyped dryRun is refused, never stripped into a live approval" },
    { schema: "ApproveResultSchema", why: "ApproveResponseSchema with reapproval always present" },
  ],
};

/** Contract body schemas a route does not parse, with the reason. */
const UNPARSED_BODIES: Record<string, string> = {
  "POST reviewConfirmInjection": "the route itself is Ba's confirmation; the body ({ confirmed: true }) carries nothing else",
};

let h: ApiHarness;
beforeAll(async () => {
  h = await createApiHarness();
});
afterAll(async () => {
  await h.close();
});

const label = (method: string, key: string) => `${method} ${key}`;

describe("orchestrator routes = API_CONTRACT", () => {
  it("serves every (method, route) of the contract", () => {
    const missing = apiEndpoints().filter((e) => !h.app.hasRoute({ method: e.method, url: e.path }));
    expect(missing.map((e) => `${e.method} ${e.path}`)).toEqual([]);
  });

  it("registers no route outside the contract (every handler's method and API_ROUTES key are in it)", () => {
    const contract = new Set(apiEndpoints().map((e) => label(e.method, e.key)));
    const found = handlers();
    expect(found.length).toBeGreaterThan(50);
    expect(found.filter((x) => !contract.has(label(x.method, x.key))).map((x) => `${x.file}: ${label(x.method, x.key)}`)).toEqual([]);
    // A literal path would bypass API_ROUTES (and this check).
    for (const file of readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
      expect(readFileSync(join(ROUTES_DIR, file), "utf8"), file).not.toMatch(/\b(?:app|child)\.(?:get|post|put|patch|delete)(?:<[^>]*>)?\(\s*["'`]/);
    }
  });

  it("answers and parses with the contract's own schemas", () => {
    const problems: string[] = [];
    const byKey = new Map(apiEndpoints().map((e) => [label(e.method, e.key), e]));
    for (const x of handlers()) {
      const e = byKey.get(label(x.method, x.key));
      if (!e) continue;
      const local = new Set((LOCAL_VARIANTS[label(x.method, x.key)] ?? []).map((v) => v.schema));
      if (typeof e.response === "object") {
        const ok = x.responds.length > 0 && x.responds.every((n) => local.has(n) || SCHEMAS[n] === e.response);
        if (!ok) problems.push(`${label(x.method, x.key)} responds with ${x.responds.join(", ") || "nothing checked"}`);
      }
      const expected = [e.body, e.query].filter((s): s is Exclude<typeof s, null | "multipart"> => s !== null && s !== "multipart");
      for (const want of expected) {
        if (UNPARSED_BODIES[label(x.method, x.key)]) continue;
        if (!x.parses.some((n) => local.has(n) || SCHEMAS[n] === want)) problems.push(`${label(x.method, x.key)} does not parse its contract body/query (parses ${x.parses.join(", ") || "nothing"})`);
      }
      for (const n of x.parses) {
        if (!local.has(n) && !expected.includes(SCHEMAS[n] as never)) problems.push(`${label(x.method, x.key)} parses ${n}, which the contract does not list`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("every API_ROUTES path is unique (two keys never name one path)", () => {
    const paths = Object.values(API_ROUTES);
    expect(new Set(paths).size).toBe(paths.length);
  });
});
