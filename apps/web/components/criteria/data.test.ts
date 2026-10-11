import { SavedAnswerSchema, normalizeAnswerKey } from "@bs-job-agents/shared";
import { describe, expect, it } from "vitest";
import { apiErrorInfo } from "@/components/schedules/apiError";
import { createFixtureCriteriaData } from "./data";

describe("saved answers (UC-12: “remember this answer”; W3a GET/DELETE /saved-answers)", () => {
  it("lists the remembered answers, newest first, keyed by the shared normalised label", async () => {
    const answers = await createFixtureCriteriaData().savedAnswers();
    expect(answers.map((a) => a.label)).toEqual(["Thời gian có thể bắt đầu làm việc", "Work permit", "Notice period"]);
    for (const a of answers) {
      expect(() => SavedAnswerSchema.parse(a)).not.toThrow();
      expect(a.key).toBe(normalizeAnswerKey(a.label));
    }
  });

  it("forgets an answer, and answers 404 for one that isn't there", async () => {
    const data = createFixtureCriteriaData();
    await data.deleteAnswer("notice period");
    expect((await data.savedAnswers()).map((a) => a.key)).not.toContain("notice period");
    expect(apiErrorInfo(await data.deleteAnswer("notice period").catch((e: unknown) => e))).toMatchObject({ status: 404, code: "not_found" });
  });
});
