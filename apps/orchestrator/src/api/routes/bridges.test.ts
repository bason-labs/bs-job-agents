import { BridgesResponseSchema } from "@bs-job-agents/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createApiHarness, type ApiHarness } from "../testing.js";
import { BRIDGES_CACHE_MS } from "./bridges.js";

let h: ApiHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

describe("GET /bridges (§11 Chrome extension status)", () => {
  it("reports each engine's Chrome extension from the engine's probe, cached briefly", async () => {
    h = await createApiHarness();
    h.t.browser.set("codex", false);
    const first = BridgesResponseSchema.parse((await h.get("/bridges")).json());
    expect(first.chrome).toEqual([
      { engine: "claude", connected: true },
      { engine: "codex", connected: false },
    ]);
    h.t.browser.set("codex", true);
    expect(BridgesResponseSchema.parse((await h.get("/bridges")).json()).chrome[1]!.connected).toBe(false);
    h.t.clock.advance(BRIDGES_CACHE_MS);
    expect(BridgesResponseSchema.parse((await h.get("/bridges")).json()).chrome[1]!.connected).toBe(true);
  });

  it("is unknown (null) when the engine does not run", async () => {
    h = await createApiHarness({ state: { state: "degraded", reason: "engine_start_failed", detail: "x", startedAt: "2026-10-10T08:00:00.000Z" } });
    expect(BridgesResponseSchema.parse((await h.get("/bridges")).json()).chrome.map((c) => c.connected)).toEqual([null, null]);
  });
});
