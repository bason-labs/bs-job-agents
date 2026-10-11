"use client";

import type { MessageCard } from "@bs-job-agents/shared";
import { Check } from "lucide-react";
import { useState } from "react";
import type { AnswerInput } from "@/lib/api/contract";
import { errorMessage } from "@/lib/api/errors";
import { useApi } from "@/lib/api/react";
import { cn } from "@/lib/cn";
import { formatThousands } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Input } from "@/components/ui/Input";
import { NumberInput } from "@/components/ui/NumberInput";
import { useChat } from "./ChatContext";
import { isLatestQuestion, questionPlaceholder } from "./model";

type QuestionCardData = Extract<MessageCard, { type: "question" }>;

interface Answered {
  mode: AnswerInput["mode"];
  value: string | null;
  remember: boolean;
}

function answerText(a: Answered, kind: string): string {
  if (a.mode === "skip") return "Left blank — optional";
  if (a.mode === "negotiable") return "Negotiable / Thỏa thuận";
  return kind === "salary" || kind === "number" ? formatThousands(Number(a.value)) : (a.value ?? "");
}

/**
 * UC-12 question card: a form field Apply has no answer for. Required vs optional label, Send,
 * Negotiable / Thỏa thuận (salary), Skip — leave blank (optional only), and "remember this answer".
 * Live only while its task waits for this question (PM S24: inert once the task moved on).
 */
export function QuestionCard({ card }: { card: QuestionCardData }) {
  const api = useApi();
  const { messages, taskPhase } = useChat();
  const q = card.question;
  const numeric = q.kind === "salary" || q.kind === "number";
  const [text, setText] = useState("");
  const [amount, setAmount] = useState<number | null>(null);
  const [remember, setRemember] = useState(true);
  const [pending, setPending] = useState<AnswerInput["mode"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answered, setAnswered] = useState<Answered | null>(null);

  const phase = taskPhase(card.taskId);
  const latest = isLatestQuestion(messages, card.taskId, q.field);
  const state = answered || card.answered ? "answered" : latest && phase !== "ended" && phase !== "running" ? "live" : "closed";

  const send = async (mode: AnswerInput["mode"], value: string | null) => {
    setPending(mode);
    setError(null);
    try {
      await api.answerQuestion(card.taskId, { field: q.field, mode, value, remember });
      setAnswered({ mode, value, remember });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(null);
    }
  };
  const typed = numeric ? (amount === null ? "" : String(amount)) : text.trim();

  return (
    <div
      data-testid="question-card"
      data-state={state}
      data-field={q.field}
      className={cn(
        "space-y-2 rounded-2xl border p-3",
        state !== "live" ? "border-border bg-surface-2/30" : q.required ? "border-warn/40 bg-warn/5" : "border-border bg-surface-2/40",
      )}
    >
      <p className="text-xs">
        <span className={q.required ? "text-warn" : "text-muted"}>{q.required ? "Required field" : "Optional field — you can skip it"}</span>
      </p>
      <p className="font-medium">{q.label}</p>

      {state === "answered" ? (
        <div className="space-y-1 text-xs">
          <p className="flex items-center gap-1.5 text-ok">
            <Check aria-hidden className="size-3.5" />
            {answered ? answerText(answered, q.kind) : "Answered"}
          </p>
          {answered ? (
            <p className="text-muted">
              {answered.mode === "skip"
                ? "It's optional, so the form can still be submitted."
                : answered.remember
                  ? "Saved as a remembered answer for future forms."
                  : "Used for this form only."}
            </p>
          ) : null}
        </div>
      ) : state === "closed" ? (
        <p className="text-xs text-muted">This question is closed: the form is no longer waiting for it.</p>
      ) : (
        <>
          {q.options?.length ? (
            <div className="flex flex-wrap gap-2" role="group" aria-label={q.label}>
              {q.options.map((o) => (
                <Button key={o} size="sm" pill disabled={pending !== null} onClick={() => void send("answer", o)}>
                  {o}
                </Button>
              ))}
            </div>
          ) : (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (typed) void send("answer", typed);
              }}
            >
              {numeric ? (
                <NumberInput aria-label={q.label} value={amount} onValueChange={setAmount} placeholder={questionPlaceholder(q.kind)} className="flex-1" />
              ) : (
                <Input aria-label={q.label} value={text} onChange={(e) => setText(e.target.value)} placeholder={questionPlaceholder(q.kind)} className="flex-1" />
              )}
              <Button type="submit" variant="primary" disabled={!typed || pending !== null} loading={pending === "answer"}>
                Send
              </Button>
            </form>
          )}
          {q.kind === "salary" || !q.required ? (
            <div className="flex flex-wrap gap-2 text-xs">
              {q.kind === "salary" ? (
                <Button size="sm" pill disabled={pending !== null} loading={pending === "negotiable"} onClick={() => void send("negotiable", null)}>
                  Negotiable / Thỏa thuận
                </Button>
              ) : null}
              {!q.required ? (
                <Button size="sm" pill disabled={pending !== null} loading={pending === "skip"} onClick={() => void send("skip", null)}>
                  Skip — leave blank
                </Button>
              ) : null}
            </div>
          ) : null}
          <Checkbox checked={remember} onCheckedChange={setRemember} label={<span className="text-xs text-muted">Remember this answer for future forms</span>} />
          {error ? (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
