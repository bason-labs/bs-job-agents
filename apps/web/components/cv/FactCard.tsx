"use client";

import type { Fact, FactType } from "@bs-job-agents/shared";
import { Pencil, Trash2 } from "lucide-react";
import { useId } from "react";
import { Button, Field, IconButton, Input, Select, Textarea } from "@/components/ui";
import { cn } from "@/lib/cn";
import { ChipInput } from "@/components/criteria/ChipInput";
import { FACT_TYPE_OPTIONS, factMeta } from "./logic";

export interface FactCardProps {
  fact: Fact;
  editing: boolean;
  error?: string;
  onChange: (fact: Fact) => void;
  onEdit: () => void;
  onDone: () => void;
  onDelete: () => void;
}

/** One master fact: read view (prototype) or the structured editor (UC-20: EN/VI text, tags, org, dates). */
export function FactCard({ fact, editing, error, onChange, onEdit, onDone, onDelete }: FactCardProps) {
  const ids = { id: useId(), type: useId(), org: useId(), dates: useId(), en: useId(), vi: useId() };
  const set = (patch: Partial<Fact>) => onChange({ ...fact, ...patch });

  if (!editing) {
    return (
      <div data-testid="fact" data-fact-id={fact.id} className={cn("flex items-start gap-3 rounded-2xl border bg-surface/60 p-3", error ? "border-danger/60" : "border-border")}>
        <span className="shrink-0 rounded-full border border-border bg-surface-2 px-2 py-0.5 font-mono text-[10px]">{fact.id}</span>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-[10px] tracking-wider text-muted uppercase">{factMeta(fact)}</p>
          <p className="text-xs">{fact.text || <span className="text-muted italic">no text yet</span>}</p>
          {fact.textVi ? (
            <p className="text-xs text-muted">
              <span className="mr-1 rounded border border-border px-1 text-[9px]">VI</span>
              {fact.textVi}
            </p>
          ) : null}
          {fact.tags.length ? (
            <div className="flex flex-wrap gap-1">
              {fact.tags.map((t) => (
                <span key={t} className="rounded-full bg-surface-2 px-2 text-[10px] text-muted">
                  {t}
                </span>
              ))}
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 gap-0.5">
          <IconButton size="sm" label={`Edit ${fact.id}`} icon={<Pencil aria-hidden />} onClick={onEdit} />
          <IconButton size="sm" label={`Delete ${fact.id}`} icon={<Trash2 aria-hidden />} onClick={onDelete} className="hover:text-danger" />
        </div>
      </div>
    );
  }

  return (
    <div data-testid="fact-editor" data-fact-id={fact.id} className="space-y-3 rounded-2xl border border-accent/60 bg-surface/80 p-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Fact id" htmlFor={ids.id}>
          <Input id={ids.id} value={fact.id} onChange={(e) => set({ id: e.target.value })} className="font-mono" spellCheck={false} invalid={!!error && /id/.test(error)} />
        </Field>
        <Field label="Type" labelId={ids.type}>
          <Select aria-labelledby={ids.type} options={FACT_TYPE_OPTIONS} value={fact.type} onValueChange={(v) => set({ type: v as FactType })} />
        </Field>
        <Field label="Organisation" htmlFor={ids.org}>
          <Input id={ids.org} value={fact.org ?? ""} placeholder="e.g. Gradion" onChange={(e) => set({ org: e.target.value || null })} />
        </Field>
        <Field label="Dates" htmlFor={ids.dates}>
          <Input id={ids.dates} value={fact.dates ?? ""} placeholder="e.g. 2022 – present" onChange={(e) => set({ dates: e.target.value || null })} />
        </Field>
      </div>
      <Field label="Text (English)" htmlFor={ids.en} error={error}>
        <Textarea id={ids.en} rows={2} value={fact.text} onChange={(e) => set({ text: e.target.value })} invalid={!!error && !/id/.test(error)} autoFocus />
      </Field>
      <Field label="Text (Vietnamese, optional)" htmlFor={ids.vi}>
        <Textarea id={ids.vi} rows={2} value={fact.textVi ?? ""} placeholder="Vietnamese wording, if you have it" onChange={(e) => set({ textVi: e.target.value || null })} />
      </Field>
      <div className="space-y-1">
        <p className="text-xs text-muted">Tags</p>
        <ChipInput label={`${fact.id} tags`} values={fact.tags} onChange={(tags) => set({ tags })} />
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" pill variant="ghost" onClick={onDelete} className="text-danger hover:text-danger">
          Delete
        </Button>
        <Button size="sm" pill onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}
