// PM3 M2: the orchestrator refuses a state change without the web app's Origin. Server components
// call it directly (no browser, no Origin), so their client is read-only: a mutation fails here,
// before any request, instead of as a 403.
import { afterEach, describe, expect, it, vi } from "vitest";
import { getServerApi } from "./server";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getServerApi (live)", () => {
  it("reads over HTTP but never sends a state-changing request", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ runs: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchSpy);
    const api = await getServerApi("live");
    await expect(api.listRuns()).resolves.toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await expect(api.chooseOption({ messageId: "1", key: "ask_user", optionId: "1" })).rejects.toMatchObject({ code: "internal", message: expect.stringMatching(/read-only/) });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
