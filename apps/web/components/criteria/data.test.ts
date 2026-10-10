import { SavedAnswerSchema, normalizeAnswerKey } from "@bs-job-agents/shared";
import { describe, expect, it } from "vitest";
import { createFixtureCriteriaData } from "./data";

const NOW = () => new Date("2026-10-11T03:00:00Z");

describe("saved answers (UC-12: “remember this answer”)", () => {
  it("lists the remembered answers, newest first, keyed by the shared normalised label", async () => {
    const answers = await createFixtureCriteriaData(undefined, NOW).savedAnswers();
    expect(answers.map((a) => a.label)).toEqual(["Thời gian có thể bắt đầu làm việc", "Work permit", "Notice period"]);
    for (const a of answers) {
      expect(() => SavedAnswerSchema.parse(a)).not.toThrow();
      expect(a.key).toBe(normalizeAnswerKey(a.label));
    }
  });

  it("updates an answer and stamps the time", async () => {
    const data = createFixtureCriteriaData(undefined, NOW);
    const saved = await data.saveAnswer({ label: "Notice period", answer: "1 month" });
    expect(saved).toEqual({ key: "notice period", label: "Notice period", answer: "1 month", updatedAt: "2026-10-11T03:00:00.000Z" });
    expect((await data.savedAnswers())[0]).toEqual(saved);
  });

  it("deletes an answer, and saving it again restores it (Undo)", async () => {
    const data = createFixtureCriteriaData(undefined, NOW);
    const [first] = await data.savedAnswers();
    await data.deleteAnswer(first!.key);
    expect((await data.savedAnswers()).map((a) => a.key)).not.toContain(first!.key);
    await data.saveAnswer({ label: first!.label, answer: first!.answer });
    expect((await data.savedAnswers()).map((a) => a.key)).toContain(first!.key);
  });

  it("refuses an empty answer", async () => {
    await expect(createFixtureCriteriaData().saveAnswer({ label: "Notice period", answer: "  " })).rejects.toThrow();
  });
});
