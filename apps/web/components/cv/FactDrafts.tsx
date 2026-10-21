"use client";

// Facts from Ba's own words (owner request 2026-10-11): he answers CV's question, or tells
// something new, in free text (EN or VI); CV drafts the fact(s) and they are added with Undo.
// These are the pieces the Master CV editor puts on the page; it owns the state and the calls.
import type { FactDraftRetailor, FactRequestItem } from "@bs-job-agents/shared";
import { CircleHelp, Loader2, MessageSquarePlus, RefreshCw, Sparkles, Undo2 } from "lucide-react";
import { useId, useState, type KeyboardEvent } from "react";
import { Button, Textarea } from "@/components/ui";
import { cn } from "@/lib/cn";

/** A note under an answer box: CV found nothing to add (and why), or the draft failed. */
export interface DraftNote {
  tone: "note" | "error";
  text: string;
  /** Drafted facts the guard left out, with why ("the number 40 is not in your words"). */
  rejected?: { text: string; reasons: string[] }[];
}

const submitKey = (e: KeyboardEvent<HTMLTextAreaElement>, submit: () => void) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    submit();
  }
};

function Progress({ label }: { label: string }) {
  return (
    <p data-testid="fact-drafting" role="status" className="flex items-center gap-2 text-xs text-accent">
      <Loader2 aria-hidden className="size-3.5 animate-spin" />
      {label}
    </p>
  );
}

function Note({ note }: { note: DraftNote }) {
  return (
    <div data-testid="fact-draft-note" role={note.tone === "error" ? "alert" : "status"} className={cn("space-y-1 text-xs", note.tone === "error" ? "text-danger" : "text-muted")}>
      <p>{note.text}</p>
      {note.rejected?.length ? (
        <ul className="list-disc space-y-0.5 pl-4">
          {note.rejected.map((r, i) => (
            <li key={i}>
              Left out “{r.text}”: {r.reasons.join("; ")}.
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export interface AnswerBoxProps {
  value: string;
  onChange: (text: string) => void;
  onSubmit: () => void;
  drafting: boolean;
  disabled?: boolean;
  note: DraftNote | null;
}

/** CV's question with a free-text answer: Add (⌘/Ctrl+Enter) or "No, I don't". */
export function FactRequestCard({ request, onDecline, onEditFact, ...box }: AnswerBoxProps & { request: FactRequestItem; onDecline: () => void; onEditFact?: () => void }) {
  const id = useId();
  const submit = () => {
    if (box.value.trim() && !box.drafting && !box.disabled) box.onSubmit();
  };
  return (
    <div data-testid="fact-request" data-request-id={request.id} className="space-y-2 rounded-2xl border border-warn/40 bg-warn/5 p-3 text-xs">
      <p className="flex items-start gap-3">
        <CircleHelp aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" />
        {request.origin === "guidance" ? (
          // CV guidance (§5.8): asked once across jobs, about one fact and one field.
          <span id={id} className="min-w-0 flex-1" data-testid="guidance-request">
            <b>From CV guidance: {request.ruleLabel ?? request.topic}.</b> “{request.question}”
            {request.alsoJobIds && request.alsoJobIds.length > 0 ? ` Asked once for ${request.alsoJobIds.length + 1} jobs.` : ""}
          </span>
        ) : (
          <span id={id} className="min-w-0 flex-1">
            <b>CV asks:</b> “{request.question}” {request.company} asks for it ({request.reason.charAt(0).toLowerCase() + request.reason.slice(1)}).
          </span>
        )}
      </p>
      {onEditFact ? (
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted">Type the months in the fact itself: nothing is guessed for you.</span>
          <Button size="sm" pill variant="secondary" onClick={onEditFact} data-testid="edit-fact">
            Edit fact {request.factId}
          </Button>
        </div>
      ) : null}
      <Textarea
        rows={2}
        aria-label={`Your answer: ${request.question}`}
        aria-describedby={id}
        placeholder="Answer in your own words (EN or VI)…"
        value={box.value}
        disabled={box.drafting || box.disabled}
        onChange={(e) => box.onChange(e.target.value)}
        onKeyDown={(e) => submitKey(e, submit)}
        className="text-xs"
      />
      {box.drafting ? <Progress label="CV is writing the fact from your words…" /> : null}
      {box.note && !box.drafting ? <Note note={box.note} /> : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="mr-auto text-[11px] text-muted">Only what you write goes in; you can undo it.</span>
        <Button size="sm" pill variant="ghost" onClick={onDecline} disabled={box.drafting}>
          No, I don&apos;t
        </Button>
        <Button size="sm" pill variant="primary" onClick={submit} disabled={!box.value.trim() || box.disabled} loading={box.drafting} leftIcon={<MessageSquarePlus aria-hidden className="size-3.5" />}>
          Add
        </Button>
      </div>
    </div>
  );
}

/** "Tell me something new about your experience…": free text → new facts. */
export function FreeTextFacts(box: AnswerBoxProps) {
  const submit = () => {
    if (box.value.trim() && !box.drafting && !box.disabled) box.onSubmit();
  };
  return (
    <section data-testid="fact-free-text" aria-label="Add facts in your own words" className="space-y-2 rounded-2xl border border-border bg-surface/60 p-4">
      <p className="flex items-center gap-2 text-xs font-medium">
        <Sparkles aria-hidden className="size-4 text-accent" />
        Add facts in your own words
      </p>
      <Textarea
        rows={2}
        aria-label="Tell me something new about your experience"
        placeholder="Tell me something new about your experience… (EN or VI)"
        value={box.value}
        disabled={box.drafting || box.disabled}
        onChange={(e) => box.onChange(e.target.value)}
        onKeyDown={(e) => submitKey(e, submit)}
        className="text-xs"
      />
      {box.drafting ? <Progress label="CV is turning your words into facts…" /> : null}
      {box.note && !box.drafting ? <Note note={box.note} /> : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="mr-auto text-[11px] text-muted">CV writes the facts (EN and VI) from your words only; you can undo or edit them. ⌘/Ctrl+Enter adds.</span>
        <Button size="sm" pill variant="primary" onClick={submit} disabled={!box.value.trim() || box.disabled} loading={box.drafting}>
          Add facts
        </Button>
      </div>
    </section>
  );
}

/** Over a fact CV just added from Ba's words: Undo (the whole addition) and Edit. */
export function AddedBar({ factId, onUndo, onEdit, undoing }: { factId: string; onUndo: () => void; onEdit: () => void; undoing: boolean }) {
  return (
    <div data-testid="fact-added-bar" data-fact-id={factId} className="flex items-center gap-2 px-1 text-xs">
      <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-medium text-accent">Added</span>
      <span className="text-muted">from your words</span>
      <span className="ml-auto flex gap-1">
        <Button size="sm" variant="ghost" onClick={onUndo} loading={undoing} leftIcon={<Undo2 aria-hidden className="size-3.5" />}>
          Undo
        </Button>
        <Button size="sm" variant="ghost" onClick={onEdit}>
          Edit
        </Button>
      </span>
    </div>
  );
}

export interface RetailorResult {
  jobId: string;
  company: string;
  /** null = CV is tailoring again; else why not. */
  problem: string | null;
}

/** After answers to CV's questions: "Re-tailor CVs for: NovaPay, Hubble" → re-run their CV steps. */
export function RetailorBanner({
  jobs,
  onRetailor,
  onDismiss,
}: {
  jobs: FactDraftRetailor[];
  onRetailor: () => Promise<RetailorResult[]>;
  onDismiss: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<RetailorResult[] | null>(null);
  const run = async () => {
    setBusy(true);
    try {
      setResults(await onRetailor());
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-testid="retailor-banner" className="space-y-2 rounded-2xl border border-accent/40 bg-accent/5 p-3 text-xs">
      <div className="flex flex-wrap items-center gap-3">
        <RefreshCw aria-hidden className="size-4 shrink-0 text-accent" />
        <span className="min-w-0 flex-1">
          Re-tailor CVs for: <b>{jobs.map((j) => j.company).join(", ")}</b> — their CVs can use your new facts.
        </span>
        {results === null ? (
          <span className="flex gap-2">
            <Button size="sm" pill variant="ghost" onClick={onDismiss} disabled={busy}>
              Not now
            </Button>
            <Button size="sm" pill variant="primary" onClick={() => void run()} loading={busy}>
              Re-tailor CVs
            </Button>
          </span>
        ) : (
          <Button size="sm" pill variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
        )}
      </div>
      {results ? (
        <ul data-testid="retailor-results" className="space-y-0.5 pl-7">
          {results.map((r) => (
            <li key={r.jobId} className={r.problem ? "text-warn" : "text-muted"}>
              {r.problem ? `${r.company}: ${r.problem}` : `${r.company}: CV is tailoring it again; the review card updates when QA passes.`}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
