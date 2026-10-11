"use client";

import type { SavedAnswer } from "@bs-job-agents/shared";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog, IconButton, useToast } from "@/components/ui";
import { errorText } from "@/components/schedules/apiError";
import { formatDate } from "@/components/schedules/datetime";
import type { CriteriaData } from "./data";

export interface SavedAnswersProps {
  initial: SavedAnswer[];
  data: CriteriaData;
}

/**
 * Answers Ba told Apply to remember (UC-12). Apply reuses them on every form that asks the
 * same question, so a wrong one (or a planted label, PM M4) must be easy to see and remove.
 * The API can only forget an answer (DELETE /saved-answers/:key); Apply asks again next time.
 */
export function SavedAnswers({ initial, data }: SavedAnswersProps) {
  const [answers, setAnswers] = useState(initial);
  const [pending, setPending] = useState<SavedAnswer | null>(null);
  const { toast } = useToast();

  const remove = async (a: SavedAnswer) => {
    setPending(null);
    try {
      await data.deleteAnswer(a.key);
      setAnswers((as) => as.filter((x) => x.key !== a.key));
      toast({ title: `Forgot the answer for “${a.label}”` });
    } catch (e) {
      toast({ title: `Couldn't delete the answer: ${errorText(e)}`, tone: "err" });
    }
  };

  return (
    <section aria-label="Saved answers" className="space-y-2 rounded-2xl border border-border bg-surface/60 p-4">
      <div>
        <p className="text-xs font-medium">Saved answers</p>
        <p className="mt-0.5 text-[11px] text-muted">
          Answers you asked Apply to remember. It reuses them on any form with the same question; expected salary always follows the rule above.
        </p>
      </div>
      {answers.length === 0 ? (
        <p className="text-xs text-muted italic">No saved answers yet. When Apply asks you something in chat, tick “Remember this answer” to keep it here.</p>
      ) : (
        <ul data-testid="saved-answers" className="divide-y divide-border/60 rounded-xl border border-border">
          {answers.map((a) => (
            <li key={a.key} className="flex items-center gap-3 px-3 py-2 text-xs">
              <span className="w-2/5 shrink-0 text-muted">{a.label}</span>
              <span className="min-w-0 flex-1">
                <span className="block">{a.answer}</span>
                <span className="text-[10px] text-muted">saved {formatDate(a.updatedAt)}</span>
              </span>
              <IconButton size="sm" label={`Forget the answer for ${a.label}`} icon={<Trash2 aria-hidden />} onClick={() => setPending(a)} className="hover:text-danger" />
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
        title={pending ? `Forget the answer for “${pending.label}”?` : ""}
        description="Apply stops using it. The next form that asks will ask you again in chat."
        confirmLabel="Forget answer"
        onConfirm={() => pending && void remove(pending)}
      />
    </section>
  );
}
