// UC-12 (unknown form questions) and the §7.5 expected-salary rule. Apply reports
// `pendingQuestions` for fields it could not fill; the engine answers what saved answers and the
// form defaults already decide, and Lead asks Ba the rest, one at a time.
import {
  NEGOTIABLE_TEXT,
  normalizeAnswerKey,
  type Currency,
  type PendingQuestion,
  type QuestionAnswer,
  type SalaryPolicy,
} from "@bs-job-agents/shared";

export interface QuestionContext {
  salaryPolicy: SalaryPolicy;
  salaryAmount: number | null;
  currency: Currency | null;
  /** The form's language (the job's): "Negotiable" on EN forms, "Thỏa thuận" on VI forms. */
  formLanguage: "en" | "vi";
  savedAnswers: readonly { key: string; label: string; answer: string }[];
}

export type QuestionResolution =
  | { kind: "answer"; answer: QuestionAnswer; source: "saved_answer" | "form_defaults" }
  /** Optional and nobody needs to be asked: left blank and recorded as `skipped`. */
  | { kind: "skip"; answer: QuestionAnswer }
  /** Lead asks Ba (UC-12); the card offers Skip for optional fields and Negotiable for salary. */
  | { kind: "ask"; question: PendingQuestion; allowSkip: boolean; allowNegotiable: boolean };

const answer = (q: PendingQuestion, value: string | null): QuestionAnswer => ({ field: q.field, label: q.label, value });

/** Decide one pending question (UC-12; salary per §7.5). */
export function resolvePendingQuestion(q: PendingQuestion, ctx: QuestionContext): QuestionResolution {
  const key = normalizeAnswerKey(q.label);
  const saved = key === "" ? undefined : ctx.savedAnswers.find((s) => s.key === key);
  if (saved) {
    // A choice takes a saved answer only when it is one of the options.
    const options = q.options ?? [];
    const option = options.length === 0 ? saved.answer : options.find((o) => o.trim().toLowerCase() === saved.answer.trim().toLowerCase());
    if (option !== undefined) return { kind: "answer", answer: answer(q, option), source: "saved_answer" };
  }
  const negotiable = NEGOTIABLE_TEXT[ctx.formLanguage];
  if (q.kind === "salary") {
    switch (ctx.salaryPolicy) {
      case "negotiable":
        return { kind: "answer", answer: answer(q, negotiable), source: "form_defaults" };
      case "fixed":
        if (ctx.salaryAmount !== null) return { kind: "answer", answer: answer(q, String(ctx.salaryAmount)), source: "form_defaults" };
        return { kind: "ask", question: q, allowSkip: !q.required, allowNegotiable: true };
      case "ask":
        return { kind: "ask", question: q, allowSkip: !q.required, allowNegotiable: true };
      case "blank_if_optional":
        if (!q.required) return { kind: "skip", answer: answer(q, null) };
        // Required: write Negotiable if the field takes text, otherwise ask Ba.
        if (!q.options || q.options.length === 0) return { kind: "answer", answer: answer(q, negotiable), source: "form_defaults" };
        return { kind: "ask", question: q, allowSkip: false, allowNegotiable: false };
    }
  }
  // Optional fields never block a submission (§5.2 Apply); required ones need Ba.
  if (!q.required) return { kind: "skip", answer: answer(q, null) };
  return { kind: "ask", question: q, allowSkip: false, allowNegotiable: false };
}

export type BaAnswerMode = "answer" | "skip" | "negotiable";

/** Check Ba's answer from the question card (shared AnswerQuestionRequest). */
export function validateBaAnswer(
  q: PendingQuestion,
  input: { mode: BaAnswerMode; value: string | null },
  ctx: Pick<QuestionContext, "formLanguage">,
): { ok: true; answer: QuestionAnswer } | { ok: false; error: string } {
  switch (input.mode) {
    case "skip":
      if (q.required) return { ok: false, error: `${q.label} is required; it cannot be left blank` };
      return { ok: true, answer: answer(q, null) };
    case "negotiable":
      if (q.kind !== "salary") return { ok: false, error: `${q.label} is not a salary question` };
      return { ok: true, answer: answer(q, NEGOTIABLE_TEXT[ctx.formLanguage]) };
    case "answer": {
      const value = input.value?.trim() ?? "";
      if (!value) return { ok: false, error: "type an answer" };
      if (q.options && q.options.length > 0) {
        const option = q.options.find((o) => o.trim().toLowerCase() === value.toLowerCase());
        if (!option) return { ok: false, error: `${q.label}: choose one of ${q.options.join(", ")}` };
        return { ok: true, answer: answer(q, option) };
      }
      return { ok: true, answer: answer(q, value) };
    }
  }
}
