import { CriteriaResponseSchema, SavedAnswerSchema, normalizeAnswerKey } from "@bs-job-agents/shared";
import { searchProfileFixture } from "@bs-job-agents/shared/fixtures";
import { describe, expect, it } from "vitest";
import { apiErrorInfo } from "@/components/schedules/apiError";
import { testMock } from "@/lib/api/mock/testing";
import { createCriteriaData, readCriteria } from "./data";
import { formToRequest, profileToForm } from "./logic";

describe("criteria adapter (GET/PUT /criteria, /criteria/versions, /criteria/profiles)", () => {
  it("reads the active profile v3 and its history, newest first", async () => {
    const r = await readCriteria(createCriteriaData(testMock()));
    expect(r.profile).toMatchObject({ version: 3, active: true, roles: searchProfileFixture.roles });
    expect(r.versions.map((v) => [v.version, v.active])).toEqual([
      [3, true],
      [2, false],
      [1, false],
    ]);
  });

  it("saves a new active version; the server rejects invalid fields with 400", async () => {
    const mock = testMock();
    const data = createCriteriaData(mock);
    const saved = CriteriaResponseSchema.parse(await data.save({ ...formToRequest(profileToForm(searchProfileFixture)), maxJobs: 8 }));
    expect(saved).toMatchObject({ version: 4, active: true, maxJobs: 8 });
    expect((await data.versions()).versions[0]).toMatchObject({ version: 4, active: true });
    expect(mock.state.criteriaVersion).toBe(4);
    const bad = await data.save({ ...formToRequest(profileToForm(searchProfileFixture)), roles: [] }).catch((e: unknown) => e);
    expect(apiErrorInfo(bad)).toMatchObject({ status: 400, code: "validation_failed" });
  });

  it("maps 404 (no criteria yet) to null, and the first save creates v1", async () => {
    const data = createCriteriaData(testMock({ state: (s) => (s.profiles = []) }));
    expect(await data.get()).toBeNull();
    expect((await data.versions()).versions).toEqual([]);
    const first = await data.save({ ...formToRequest(profileToForm(null)), roles: ["Frontend Engineer"], locations: ["Ho Chi Minh City"] });
    expect(first).toMatchObject({ version: 1, name: "Default", active: true });
  });

  it("lists the newest version of each profile for the schedule modal", async () => {
    const data = createCriteriaData(testMock());
    expect((await data.profiles()).map((p) => [p.name, p.version])).toEqual([["Default", 3]]);
  });
});

describe("saved answers (UC-12: “remember this answer”; GET/DELETE /saved-answers)", () => {
  it("lists the remembered answers, newest first, keyed by the shared normalised label", async () => {
    const answers = await createCriteriaData(testMock()).savedAnswers();
    expect(answers.map((a) => a.label)).toEqual(["Work permit", "Notice period"]);
    for (const a of answers) {
      expect(() => SavedAnswerSchema.parse(a)).not.toThrow();
      expect(a.key).toBe(normalizeAnswerKey(a.label));
    }
  });

  it("forgets an answer, and answers 404 for one that isn't there", async () => {
    const data = createCriteriaData(testMock());
    await data.deleteAnswer("notice period");
    expect((await data.savedAnswers()).map((a) => a.key)).not.toContain("notice period");
    expect(apiErrorInfo(await data.deleteAnswer("notice period").catch((e: unknown) => e))).toMatchObject({ status: 404, code: "not_found" });
  });
});
