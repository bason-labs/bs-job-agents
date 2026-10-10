import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ApiErrorSchema, MasterCvSchema, OkResponseSchema, SavedAnswersResponseSchema } from "@bs-job-agents/shared";
import { masterCvFixture } from "@bs-job-agents/shared/fixtures";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { listSavedAnswers, saveAnswer } from "../../db/index.js";
import { fileMasterCv } from "../../engine/index.js";
import { createApiHarness, writeDataFile, type ApiHarness } from "../testing.js";

let h: ApiHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

describe("master CV (UC-20, §6.1)", () => {
  it("404 before Ba creates it; the first save is version 1 in data/master-cv.yaml, readable by the engine", async () => {
    h = await createApiHarness();
    expect((await h.get("/master-cv")).statusCode).toBe(404);
    const res = await h.put("/master-cv", { ...masterCvFixture, version: 1 });
    expect(res.statusCode).toBe(200);
    expect(MasterCvSchema.parse(res.json())).toMatchObject({ version: 1, contact: masterCvFixture.contact });
    const text = readFileSync(join(h.dataDir, "master-cv.yaml"), "utf8");
    expect(MasterCvSchema.parse(parse(text))).toEqual(MasterCvSchema.parse({ ...masterCvFixture, version: 1 }));
    expect(fileMasterCv(join(h.dataDir, "master-cv.yaml")).version()).toBe(1);
    expect(MasterCvSchema.parse((await h.get("/master-cv")).json()).facts).toEqual(MasterCvSchema.parse(masterCvFixture).facts);
  });

  it("saving bumps the version; a save based on an older version is refused (409)", async () => {
    h = await createApiHarness();
    await h.put("/master-cv", { ...masterCvFixture, version: 1 });
    const edited = { ...masterCvFixture, version: 1, facts: [...masterCvFixture.facts, { id: "docker-1", type: "skill", text: "Docker" }] };
    const saved = MasterCvSchema.parse((await h.put("/master-cv", edited)).json());
    expect(saved.version).toBe(2);
    expect(saved.facts.at(-1)).toMatchObject({ id: "docker-1", textVi: null, tags: [] });
    const stale = await h.put("/master-cv", edited);
    expect(stale.statusCode).toBe(409);
    expect(ApiErrorSchema.parse(stale.json()).error.details).toMatchObject({ reason: "master_cv_changed", currentVersion: 2 });
  });

  it("validates the facts (duplicate ids, bad email) and reports a hand-edited file it cannot read", async () => {
    h = await createApiHarness();
    const dup = { ...masterCvFixture, version: 1, facts: [masterCvFixture.facts[0], masterCvFixture.facts[0]] };
    expect((await h.put("/master-cv", dup)).statusCode).toBe(400);
    expect((await h.put("/master-cv", { ...masterCvFixture, contact: { ...masterCvFixture.contact, email: "nope" } })).statusCode).toBe(400);
    writeDataFile(h.dataDir, "master-cv.yaml", "version: 3\nfacts: [unclosed\n");
    const broken = await h.get("/master-cv");
    expect(broken.statusCode).toBe(409);
    expect(ApiErrorSchema.parse(broken.json()).error.details).toMatchObject({ reason: "master_cv_invalid" });
  });
});

describe("saved answers (UC-12 remember this answer)", () => {
  it("lists them and deletes one by its key", async () => {
    h = await createApiHarness();
    saveAnswer(h.t.db, { label: "Notice period:", answer: "2 weeks" });
    saveAnswer(h.t.db, { label: "Thời gian báo trước", answer: "2 tuần" });
    const list = SavedAnswersResponseSchema.parse((await h.get("/saved-answers")).json()).answers;
    expect(list.map((a) => [a.key, a.answer])).toEqual([
      ["notice period", "2 weeks"],
      ["thời gian báo trước", "2 tuần"],
    ]);
    const res = await h.del(`/saved-answers/${encodeURIComponent("thời gian báo trước")}`);
    expect(res.statusCode).toBe(200);
    expect(OkResponseSchema.parse(res.json())).toEqual({ ok: true });
    expect(listSavedAnswers(h.t.db).map((a) => a.key)).toEqual(["notice period"]);
    expect((await h.del("/saved-answers/nope")).statusCode).toBe(404);
  });
});
