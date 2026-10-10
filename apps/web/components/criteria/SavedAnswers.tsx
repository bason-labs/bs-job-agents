"use client";

import type { SavedAnswer } from "@bs-job-agents/shared";
import { Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button, IconButton, Input, useToast } from "@/components/ui";
import { formatDate } from "@/components/schedules/datetime";
import type { CriteriaData } from "./data";

export interface SavedAnswersProps {
  initial: SavedAnswer[];
  data: CriteriaData;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Answers Ba told Apply to remember (UC-12). Apply reuses them on every form that asks the
 * same question, so a wrong one (or a planted label, PM M4) must be easy to see and remove.
 */
export function SavedAnswers({ initial, data }: SavedAnswersProps) {
  const [answers, setAnswers] = useState(initial);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const { toast } = useToast();

  const upsert = (saved: SavedAnswer) => setAnswers((as) => [saved, ...as.filter((a) => a.key !== saved.key)]);

  const save = async (a: SavedAnswer) => {
    try {
      upsert(await data.saveAnswer({ label: a.label, answer: draft }));
      setEditing(null);
      toast({ title: `Updated the answer for “${a.label}”` });
    } catch (e) {
      toast({ title: `Couldn't save the answer: ${errorText(e)}`, tone: "err" });
    }
  };

  const remove = async (a: SavedAnswer) => {
    try {
      await data.deleteAnswer(a.key);
      setAnswers((as) => as.filter((x) => x.key !== a.key));
      toast({
        title: `Forgot the answer for “${a.label}”`,
        action: { label: "Undo", onClick: () => void data.saveAnswer({ label: a.label, answer: a.answer }).then(upsert) },
      });
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
              {editing === a.key ? (
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <Input
                    aria-label={`Answer for ${a.label}`}
                    value={draft}
                    autoFocus
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void save(a);
                      if (e.key === "Escape") {
                        e.stopPropagation();
                        setEditing(null);
                      }
                    }}
                    className="py-1 text-xs"
                  />
                  <Button size="sm" pill variant="primary" disabled={!draft.trim()} onClick={() => void save(a)}>
                    Save
                  </Button>
                  <Button size="sm" pill variant="ghost" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                </span>
              ) : (
                <>
                  <span className="min-w-0 flex-1">
                    <span className="block">{a.answer}</span>
                    <span className="text-[10px] text-muted">saved {formatDate(a.updatedAt)}</span>
                  </span>
                  <IconButton
                    size="sm"
                    label={`Edit the answer for ${a.label}`}
                    icon={<Pencil aria-hidden />}
                    onClick={() => {
                      setDraft(a.answer);
                      setEditing(a.key);
                    }}
                  />
                  <IconButton size="sm" label={`Delete the answer for ${a.label}`} icon={<Trash2 aria-hidden />} onClick={() => void remove(a)} className="hover:text-danger" />
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
