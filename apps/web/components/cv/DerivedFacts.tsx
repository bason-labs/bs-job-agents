"use client";

// Facts the orchestrator derived from Ba's own facts (CV auto-extend §7, design components
// derived-fact-card, derived-undo-bar, rejected-drafts). The Master CV editor owns the state and
// the calls; these are the pieces it puts on the page.
import type { DerivedAddView, Fact, RejectedDerivedDraft } from "@bs-job-agents/shared";
import { AlertTriangle, ChevronDown, Undo2, Wand2 } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui";
import { cn } from "@/lib/cn";

/** "Rests on f-12", "Implied from f-3": the cited ids by relation, in their order. */
export function provenanceGroups(fact: Pick<Fact, "derived">): { label: "Rests on" | "Implied from"; ids: string[] }[] {
  const restsOn = fact.derived?.restsOn ?? [];
  const groups: { label: "Rests on" | "Implied from"; ids: string[] }[] = [];
  const supports = restsOn.filter((r) => r.relation === "supports").map((r) => r.factId);
  const implied = restsOn.filter((r) => r.relation === "implied_from").map((r) => r.factId);
  if (supports.length) groups.push({ label: "Rests on", ids: supports });
  if (implied.length) groups.push({ label: "Implied from", ids: implied });
  return groups;
}

export interface ProvenanceProps {
  fact: Fact;
  /** "Source fact changed": a cited fact was edited or deleted. */
  stale: boolean;
  /** Scroll to and focus a cited fact. */
  onSourceClick: (id: string) => void;
  onKeep: () => void;
  onDelete: () => void;
  /** Keep is on its way. */
  keeping: boolean;
}

/** Under a derived fact's text: "Added automatically", its sources, "Why", and the flagged state. */
export function Provenance({ fact, stale, onSourceClick, onKeep, onDelete, keeping }: ProvenanceProps) {
  const why = useId();
  const rationale = fact.derived?.rationale;
  return (
    <div data-testid="fact-provenance" className="space-y-1.5">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="inline-flex items-center gap-1 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent">
          <Wand2 aria-hidden className="size-3" />
          Added automatically
        </span>
        {provenanceGroups(fact).map((g) => (
          <span key={g.label} className="text-muted">
            {g.label}{" "}
            {g.ids.map((id, i) => (
              <span key={id}>
                {i > 0 ? ", " : null}
                <button type="button" onClick={() => onSourceClick(id)} className="font-mono text-fg underline decoration-dotted underline-offset-2 hover:text-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none">
                  {id}
                </button>
              </span>
            ))}
          </span>
        ))}
      </p>
      {rationale ? (
        <details className="text-xs text-muted">
          <summary aria-controls={why} className="cursor-pointer select-none hover:text-fg">
            Why
          </summary>
          <p id={why} className="mt-1">
            {rationale}
          </p>
        </details>
      ) : null}
      {stale ? (
        <div data-testid="fact-source-changed" role="status" className="space-y-1.5 text-xs">
          <p className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-full border border-warn/50 bg-warn/10 px-2 py-0.5 text-[10px] font-medium text-warn">
              <AlertTriangle aria-hidden className="size-3" />
              Source fact changed
            </span>
            <span className="text-muted">Not used in new tailor tasks until you keep or delete it.</span>
          </p>
          <span className="flex gap-2">
            <Button size="sm" pill variant="ghost" onClick={onKeep} loading={keeping} aria-busy={keeping || undefined} className="min-h-9">
              Keep
            </Button>
            <Button size="sm" pill variant="ghost" onClick={onDelete} disabled={keeping} className="min-h-9 text-danger hover:text-danger">
              Delete
            </Button>
          </span>
        </div>
      ) : null}
    </div>
  );
}

/** The cited ids, read-only, in a derived fact's editor (Edit keeps the label and the sources). */
export function ProvenanceReadOnly({ fact }: { fact: Fact }) {
  return (
    <p data-testid="fact-provenance-readonly" className="text-xs text-muted">
      <span className="mr-2 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent">Added automatically</span>
      {provenanceGroups(fact)
        .map((g) => `${g.label} ${g.ids.join(", ")}`)
        .join(" · ")}{" "}
      (sources can&apos;t be edited)
    </p>
  );
}

/** "Added 2 facts automatically (change 15)." with a badge per fact and Undo (REQ-18). */
export function DerivedUndoBar({ add, onUndo, undoing, error }: { add: DerivedAddView; onUndo: () => void; undoing: boolean; error: string | null }) {
  const n = add.facts.length;
  return (
    <div data-testid="derived-undo-bar" data-version={add.version} role="status" className="space-y-1 rounded-2xl border border-border bg-surface-2/60 p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0">
          Added {n} fact{n === 1 ? "" : "s"} automatically (change {add.version}).
        </span>
        <span className="flex flex-wrap gap-1">
          {add.facts.map((f) => (
            <span key={f.id} title={f.text} className="rounded-full border border-border bg-surface px-2 py-0.5 font-mono text-[10px]">
              {f.id}
            </span>
          ))}
        </span>
        <Button size="sm" pill variant="ghost" onClick={onUndo} loading={undoing} aria-busy={undoing || undefined} leftIcon={<Undo2 aria-hidden className="size-3.5" />} className="ml-auto min-h-9">
          {undoing ? "Undoing..." : "Undo"}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** "Not added: says 10, which f-12 does not say." */
export function rejectedReason(r: Pick<RejectedDerivedDraft, "reasons">): string {
  return `Not added: ${r.reasons.join("; ")}.`;
}

/** The collapsed "Not added (N)" region: drafts the screen rejected, with why; nothing can be accepted here. */
export function NotAdded({ items }: { items: readonly RejectedDerivedDraft[] }) {
  const [open, setOpen] = useState(false);
  const list = useId();
  if (items.length === 0) return null;
  return (
    <section data-testid="derived-not-added" aria-label="Not added" className="rounded-2xl border border-border bg-surface/60 text-xs">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={list}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-11 w-full items-center gap-2 rounded-2xl px-4 py-2 text-left hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
      >
        <ChevronDown aria-hidden className={cn("size-4 transition-transform", open ? "rotate-180" : "")} />
        <span className="font-medium">Not added ({items.length})</span>
        <span className="text-muted">facts the checks refused, because they say more than your facts do</span>
      </button>
      {open ? (
        <ul id={list} className="space-y-2 px-4 pb-3">
          {items.map((r, i) => (
            <li key={i} className="space-y-0.5">
              <p className="text-muted">
                “{r.text}”{r.restsOn.length ? <span> · Cites {r.restsOn.join(", ")}</span> : null}
              </p>
              <p>{rejectedReason(r)}</p>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
