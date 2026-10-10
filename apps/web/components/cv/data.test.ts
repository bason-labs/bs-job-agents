import { describe, expect, it } from "vitest";
import { createFixtureMasterCvData } from "./data";
import { factFromRequest } from "./logic";

const make = () => createFixtureMasterCvData(undefined, () => new Date("2026-10-11T03:00:00Z"));

describe("fixture master CV store", () => {
  it("saves a new version and records it in the history", async () => {
    const data = make();
    const cv = await data.get();
    cv.facts[0]!.text += " Shipped weekly.";
    const saved = await data.save(cv);
    expect(saved.version).toBe(8);
    expect(saved.facts[0]!.text).toMatch(/Shipped weekly\.$/);
    expect((await data.versions())[0]).toEqual({ version: 8, savedAt: "2026-10-11T03:00:00.000Z", factCount: 7 });
  });

  it("rejects invalid master data (duplicate fact ids)", async () => {
    const data = make();
    const cv = await data.get();
    await expect(data.save({ ...cv, facts: [...cv.facts, cv.facts[0]!] })).rejects.toThrow(/duplicate/);
  });

  it("closes CV's question once a fact covers the topic, or when Ba says no", async () => {
    const data = make();
    const [request] = await data.factRequests();
    expect(request).toMatchObject({ topic: "GraphQL", company: "NovaPay" });
    const cv = await data.get();
    await data.save({ ...cv, facts: [...cv.facts, { ...factFromRequest(cv.facts, request!), text: "GraphQL (Apollo Client) at Aegona" }] });
    expect(await data.factRequests()).toEqual([]);

    const other = make();
    await other.dismissFactRequest("fr_1");
    expect(await other.factRequests()).toEqual([]);
  });
});
