import { describe, expect, it } from "vitest";
import { apiErrorInfo, errorDetails } from "@/components/schedules/apiError";
import { createFixtureMasterCvData } from "./data";
import { MASTER_CV } from "./fixtures";
import { factFromRequest } from "./logic";

const now = () => new Date("2026-10-11T03:00:00Z");
const make = () => createFixtureMasterCvData({ now });

async function current(data: ReturnType<typeof make>) {
  const read = await data.get();
  if (read.state !== "ok") throw new Error(`expected a master CV, got ${read.state}`);
  return read.cv;
}

describe("fixture master CV store (W3a GET/PUT /master-cv)", () => {
  it("reads the master CV", async () => {
    expect(await make().get()).toEqual({ state: "ok", cv: MASTER_CV });
  });

  it("saves a new version and records it in the history", async () => {
    const data = make();
    const cv = await current(data);
    cv.facts[0]!.text += " Shipped weekly.";
    const saved = await data.save(cv);
    expect(saved.version).toBe(8);
    expect(saved.facts[0]!.text).toMatch(/Shipped weekly\.$/);
    expect((await data.versions())[0]).toEqual({ version: 8, savedAt: "2026-10-11T03:00:00.000Z", factCount: 7 });
  });

  it("refuses a save based on an older version (409 master_cv_changed), like the API", async () => {
    const data = make();
    const mine = await current(data);
    const other = await current(data);
    await data.save({ ...other, facts: other.facts.slice(1) }); // another tab saves v8
    const refused = await data.save(mine).catch((e: unknown) => e);
    expect(apiErrorInfo(refused)).toMatchObject({ status: 409, code: "conflict", reason: "master_cv_changed" });
    expect(errorDetails(refused)).toMatchObject({ currentVersion: 8 });
  });

  it("reports a missing master CV, and the first save creates version 1", async () => {
    const data = createFixtureMasterCvData({ seed: null, now });
    expect(await data.get()).toEqual({ state: "missing" });
    const saved = await data.save({ ...MASTER_CV, version: 1 });
    expect(saved.version).toBe(1);
    expect((await data.get()).state).toBe("ok");
  });

  it("reports an unreadable master-cv.yaml", async () => {
    const data = createFixtureMasterCvData({ invalid: "facts.2.id: fact ids are lowercase slugs" });
    expect(await data.get()).toEqual({ state: "invalid", detail: "facts.2.id: fact ids are lowercase slugs" });
  });

  it("rejects invalid master data (duplicate fact ids)", async () => {
    const data = make();
    const cv = await current(data);
    await expect(data.save({ ...cv, facts: [...cv.facts, cv.facts[0]!] })).rejects.toThrow(/duplicate/);
  });

  it("closes CV's question once a fact covers the topic, or when Ba says no", async () => {
    const data = make();
    const [request] = await data.factRequests();
    expect(request).toMatchObject({ topic: "GraphQL", company: "NovaPay" });
    const cv = await current(data);
    await data.save({ ...cv, facts: [...cv.facts, { ...factFromRequest(cv.facts, request!), text: "GraphQL (Apollo Client) at Aegona" }] });
    expect(await data.factRequests()).toEqual([]);

    const other = make();
    await other.dismissFactRequest("fr_1");
    expect(await other.factRequests()).toEqual([]);
  });
});
