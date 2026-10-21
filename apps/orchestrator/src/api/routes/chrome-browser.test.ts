// Live 2026-10-20: Ba picks the Chrome browser bots use from the ones the bots reported.
import { ChromeBrowserViewSchema } from "@bs-job-agents/shared";
import { afterEach, describe, expect, it } from "vitest";
import { getPreferredBrowser, recordSeenBrowsers } from "../../db/index.js";
import { createApiHarness, type ApiHarness } from "../testing.js";

let h: ApiHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const MAC = { deviceId: "3e83d913-aaaa-4bbb-8ccc-1234567890ab", name: "Ba's MacBook", os: "macOS", isLocal: true };

describe("GET/PUT /settings/chrome-browser", () => {
  it("lists the reported browsers; Ba picks one of them (never an id typed in) and can clear it", async () => {
    h = await createApiHarness();
    expect(ChromeBrowserViewSchema.parse((await h.get("/settings/chrome-browser")).json())).toEqual({ preferred: null, seen: [] });
    recordSeenBrowsers(h.t.db, [MAC], { now: h.t.clock.now() });
    const view = ChromeBrowserViewSchema.parse((await h.get("/settings/chrome-browser")).json());
    expect(view.seen).toEqual([{ ...MAC, seenAt: expect.any(String) }]);
    expect((await h.put("/settings/chrome-browser", { deviceId: "not-reported-0000" })).statusCode).toBe(409);
    const set = await h.put("/settings/chrome-browser", { deviceId: MAC.deviceId });
    expect(set.statusCode).toBe(200);
    expect(ChromeBrowserViewSchema.parse(set.json()).preferred).toEqual(MAC);
    expect(getPreferredBrowser(h.t.db)).toEqual(MAC);
    expect(ChromeBrowserViewSchema.parse((await h.put("/settings/chrome-browser", { deviceId: null })).json()).preferred).toBeNull();
    expect((await h.put("/settings/chrome-browser", { deviceId: 7 })).statusCode).toBe(400);
  });
});
