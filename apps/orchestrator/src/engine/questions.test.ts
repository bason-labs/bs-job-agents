// UC-12 and §7.5: which of Apply's pending questions the engine answers from saved answers and
// the salary rule, which ones Lead asks Ba (one at a time), and how Ba's answer is checked.
import type { PendingQuestion } from "@bs-job-agents/shared";
import { describe, expect, it } from "vitest";
import { resolvePendingQuestion, validateBaAnswer, type QuestionContext } from "./questions.js";

const salary = (required: boolean, options: string[] | null = null): PendingQuestion => ({
  field: "salary",
  label: "Expected salary (VND)",
  required,
  kind: "salary",
  options,
});
const notice: PendingQuestion = { field: "notice", label: "Notice period", required: true, kind: "text", options: null };
const portfolio: PendingQuestion = { field: "portfolio", label: "Portfolio URL", required: false, kind: "text", options: null };

function ctx(over: Partial<QuestionContext> = {}): QuestionContext {
  return { salaryPolicy: "blank_if_optional", salaryAmount: null, currency: null, formLanguage: "en", savedAnswers: [], ...over };
}

describe("resolvePendingQuestion (UC-12)", () => {
  it("a saved answer fills any question, matched by normalised label", () => {
    const r = resolvePendingQuestion({ ...notice, label: "Notice period:" }, ctx({ savedAnswers: [{ key: "notice period", label: "Notice period", answer: "2 weeks" }] }));
    expect(r).toEqual({ kind: "answer", answer: { field: "notice", label: "Notice period:", value: "2 weeks" }, source: "saved_answer" });
  });

  it("an unknown required field is asked; an unknown optional field never blocks (left blank)", () => {
    expect(resolvePendingQuestion(notice, ctx())).toEqual({ kind: "ask", question: notice, allowSkip: false, allowNegotiable: false });
    expect(resolvePendingQuestion(portfolio, ctx())).toEqual({ kind: "skip", answer: { field: "portfolio", label: "Portfolio URL", value: null } });
  });

  it("Leave blank when optional (default): optional salary → blank; required text salary → Negotiable / Thỏa thuận", () => {
    expect(resolvePendingQuestion(salary(false), ctx())).toMatchObject({ kind: "skip" });
    expect(resolvePendingQuestion(salary(true), ctx())).toMatchObject({ kind: "answer", answer: { value: "Negotiable" }, source: "form_defaults" });
    expect(resolvePendingQuestion(salary(true), ctx({ formLanguage: "vi" }))).toMatchObject({ answer: { value: "Thỏa thuận" } });
  });

  it("Leave blank when optional: a required salary with fixed choices is asked", () => {
    expect(resolvePendingQuestion(salary(true, ["< 20M", "20–30M", "> 30M"]), ctx())).toMatchObject({ kind: "ask", allowSkip: false, allowNegotiable: false });
  });

  it("Write Negotiable / Thỏa thuận: by the form's language", () => {
    expect(resolvePendingQuestion(salary(false), ctx({ salaryPolicy: "negotiable" }))).toMatchObject({ kind: "answer", answer: { value: "Negotiable" } });
    expect(resolvePendingQuestion(salary(true), ctx({ salaryPolicy: "negotiable", formLanguage: "vi" }))).toMatchObject({ answer: { value: "Thỏa thuận" } });
  });

  it("Use a fixed amount: the saved amount", () => {
    expect(resolvePendingQuestion(salary(true), ctx({ salaryPolicy: "fixed", salaryAmount: 30_000_000, currency: "VND" }))).toMatchObject({
      kind: "answer",
      answer: { value: "30000000" },
      source: "form_defaults",
    });
  });

  it("Ask me each time: asked, with Skip for an optional field and Negotiable for salary", () => {
    expect(resolvePendingQuestion(salary(false), ctx({ salaryPolicy: "ask" }))).toEqual({ kind: "ask", question: salary(false), allowSkip: true, allowNegotiable: true });
    expect(resolvePendingQuestion(salary(true), ctx({ salaryPolicy: "ask" }))).toMatchObject({ kind: "ask", allowSkip: false, allowNegotiable: true });
  });
});

describe("validateBaAnswer (UC-12 question card)", () => {
  it("answer: the typed value", () => {
    expect(validateBaAnswer(notice, { mode: "answer", value: "30 days" }, ctx())).toEqual({ ok: true, answer: { field: "notice", label: "Notice period", value: "30 days" } });
    expect(validateBaAnswer(notice, { mode: "answer", value: "  " }, ctx())).toMatchObject({ ok: false });
  });

  it("Skip — leave blank: optional fields only (the server rejects skip for required ones)", () => {
    expect(validateBaAnswer(salary(false), { mode: "skip", value: null }, ctx())).toEqual({ ok: true, answer: { field: "salary", label: "Expected salary (VND)", value: null } });
    expect(validateBaAnswer(notice, { mode: "skip", value: null }, ctx())).toEqual({ ok: false, error: "Notice period is required; it cannot be left blank" });
  });

  it("Negotiable / Thỏa thuận: salary questions only, in the form's language", () => {
    expect(validateBaAnswer(salary(true), { mode: "negotiable", value: null }, ctx({ formLanguage: "vi" }))).toMatchObject({ ok: true, answer: { value: "Thỏa thuận" } });
    expect(validateBaAnswer(notice, { mode: "negotiable", value: null }, ctx())).toMatchObject({ ok: false });
  });

  it("a choice must be one of the options", () => {
    const q: PendingQuestion = { field: "level", label: "Level", required: true, kind: "choice", options: ["Junior", "Senior"] };
    expect(validateBaAnswer(q, { mode: "answer", value: "senior" }, ctx())).toEqual({ ok: true, answer: { field: "level", label: "Level", value: "Senior" } });
    expect(validateBaAnswer(q, { mode: "answer", value: "Principal" }, ctx())).toMatchObject({ ok: false });
  });
});
