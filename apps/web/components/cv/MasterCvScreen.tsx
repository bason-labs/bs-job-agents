"use client";

import type { Fact, FactDraftRetailor, FactDraftView, MasterCv } from "@bs-job-agents/shared";
import { FileWarning, NotebookPen, RefreshCw } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Button, EmptyState, Field, Input, useToast } from "@/components/ui";
import { errorDetails, errorReason, errorText } from "@/components/schedules/apiError";
import { formatDateTime } from "@/components/schedules/datetime";
import { ResourceGate } from "@/components/schedules/ResourceGate";
import { useResource } from "@/lib/api/react";
import { readMasterCvPage, useMasterCvData, type FactRequestItem, type MasterCvData, type MasterCvRead, type MasterCvVersion } from "./data";
import { FactCard } from "./FactCard";
import { AddedBar, FactRequestCard, FreeTextFacts, RetailorBanner, type DraftNote, type RetailorResult } from "./FactDrafts";
import { hasErrors, isMasterDirty, newFact, validateMasterCv, type MasterCvErrors } from "./logic";

/** The free-text box's key among the answer boxes (request ids are `<cvVersionId>-<index>`). */
const FREE = "free";

/** Facts CV added from Ba's words in one draft (Undo removes them together). */
interface AddedGroup {
  taskId: string;
  version: number;
  factIds: string[];
  requestId: string | null;
  jobId: string | null;
}

export interface MasterCvScreenProps {
  initial: MasterCvRead;
  initialVersions: MasterCvVersion[];
  initialRequests: FactRequestItem[];
  data: MasterCvData;
}

/** The page: the master CV, its history and CV's open fact requests, read through lib/api. */
export function MasterCvLive() {
  const data = useMasterCvData();
  const page = useResource("w3c:master-cv", () => readMasterCvPage(data));
  return (
    <ResourceGate resource={page} label="master CV">
      {(p) => (
        // A newer version read in the background (changed in another tab) starts the editor over.
        <MasterCvScreen key={p.read.state === "ok" ? p.read.cv.version : p.read.state} initial={p.read} initialVersions={p.versions} initialRequests={p.requests} data={data} />
      )}
    </ResourceGate>
  );
}

/** A fact with a stable React key, so editing its id never remounts the editor. */
type Item = { key: number; fact: Fact };

// Keys only need to be unique on this page (they are not part of the rendered DOM).
let keySeq = 0;
const nextKey = () => ++keySeq;
const toItems = (facts: Fact[]): Item[] => facts.map((fact) => ({ key: nextKey(), fact }));

const NO_ERRORS: MasterCvErrors = { facts: {}, contact: {} };

/** A new master CV: contact details and facts start empty; the first save makes version 1. */
const BLANK_CV: MasterCv = {
  version: 1,
  contact: { name: "", email: "", phone: null, location: null, links: [] },
  headlineOptions: [],
  facts: [],
};

/**
 * UC-20: Ba's master data. Handles the API's read states: no master CV yet (404 → create one),
 * an unreadable data/master-cv.yaml (409 master_cv_invalid → fix the file, reload), or the CV.
 */
export function MasterCvScreen({ initial, initialVersions, initialRequests, data }: MasterCvScreenProps) {
  const [read, setRead] = useState(initial);
  const [creating, setCreating] = useState(false);
  const [lists, setLists] = useState({ versions: initialVersions, requests: initialRequests });
  const [editorKey, setEditorKey] = useState(0);
  const [reloading, setReloading] = useState(false);
  const { toast } = useToast();

  const reload = async () => {
    setReloading(true);
    try {
      const [r, versions, requests] = await Promise.all([data.get(), data.versions(), data.factRequests()]);
      setRead(r);
      setLists({ versions, requests });
      setEditorKey((k) => k + 1);
    } catch (e) {
      toast({ title: `Couldn't reload the master CV: ${errorText(e)}`, tone: "err" });
    } finally {
      setReloading(false);
    }
  };

  if (read.state === "invalid") {
    return (
      <EmptyState
        icon={<FileWarning aria-hidden />}
        title="data/master-cv.yaml can't be read"
        description={
          <>
            <span data-testid="cv-invalid" className="block font-mono text-xs break-words">
              {read.detail}
            </span>
            <span className="mt-2 block">Fix the file (or restore it from Time Machine), then reload.</span>
          </>
        }
        action={
          <Button pill onClick={() => void reload()} loading={reloading} leftIcon={<RefreshCw aria-hidden className="size-4" />}>
            Reload
          </Button>
        }
      />
    );
  }

  if (read.state === "missing" && !creating) {
    return (
      <EmptyState
        icon={<NotebookPen aria-hidden />}
        title="No master CV yet"
        description="Every tailored CV is built from these facts, and QA hard-fails anything not traceable here. Add your contact details and a first fact; CV asks you for more when a job needs it."
        action={
          <Button variant="primary" pill onClick={() => setCreating(true)}>
            Create master CV
          </Button>
        }
      />
    );
  }

  return (
    <MasterCvEditor
      key={editorKey}
      initial={read.state === "ok" ? read.cv : BLANK_CV}
      isNew={read.state === "missing"}
      initialVersions={lists.versions}
      initialRequests={lists.requests}
      data={data}
      onReload={reload}
      reloading={reloading}
    />
  );
}

interface MasterCvEditorProps {
  initial: MasterCv;
  /** No master CV exists yet: the first save creates version 1. */
  isNew: boolean;
  initialVersions: MasterCvVersion[];
  initialRequests: FactRequestItem[];
  data: MasterCvData;
  onReload: () => Promise<void>;
  reloading: boolean;
}

function MasterCvEditor({ initial, isNew, initialVersions, initialRequests, data, onReload, reloading }: MasterCvEditorProps) {
  const [firstItems] = useState<Item[]>(() => (isNew ? toItems([newFact([])]) : toItems(initial.facts)));
  const [saved, setSaved] = useState(initial);
  const [exists, setExists] = useState(!isNew);
  const [contact, setContact] = useState(initial.contact);
  const [items, setItems] = useState<Item[]>(firstItems);
  const [editing, setEditing] = useState<number | null>(isNew ? (firstItems[0]?.key ?? null) : null);
  const [versions, setVersions] = useState(initialVersions);
  const [requests, setRequests] = useState(initialRequests);
  const [errors, setErrors] = useState<MasterCvErrors>(NO_ERRORS);
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  /** The version on disk when a save was refused as stale (409 master_cv_changed). */
  const [conflict, setConflict] = useState<number | null>(null);
  // Facts from Ba's own words (owner request 2026-10-11), keyed by request id or FREE.
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [drafting, setDrafting] = useState<Record<string, boolean>>({});
  const [notes, setNotes] = useState<Record<string, DraftNote | null>>({});
  /** Additions CV made from Ba's words on this page, shown highlighted with Undo and Edit. */
  const [added, setAdded] = useState<AddedGroup[]>([]);
  const [undoing, setUndoing] = useState<string | null>(null);
  /** Jobs whose questions Ba answered with facts: "Re-tailor CVs for: …". */
  const [retailor, setRetailor] = useState<FactDraftRetailor[]>([]);
  /** Aborted when the page goes: polling stops. */
  const alive = useRef(new AbortController());
  useEffect(() => {
    const controller = new AbortController();
    alive.current = controller;
    return () => controller.abort();
  }, []);
  const { toast } = useToast();
  const ids = { name: useId(), email: useId(), phone: useId(), location: useId() };

  const draft: MasterCv = { ...saved, contact, facts: items.map((i) => i.fact) };
  const dirty = !exists || isMasterDirty(draft, saved);

  const revalidate = (next: MasterCv) => tried && setErrors(validateMasterCv(next));

  const setFact = (key: number, fact: Fact) => {
    const next = items.map((i) => (i.key === key ? { ...i, fact } : i));
    setItems(next);
    revalidate({ ...draft, facts: next.map((i) => i.fact) });
  };

  const addFact = (fact: Fact) => {
    const item = { key: nextKey(), fact };
    setItems((xs) => [...xs, item]);
    setEditing(item.key);
  };

  const removeFact = (item: Item) => {
    const index = items.findIndex((i) => i.key === item.key);
    setItems((xs) => xs.filter((i) => i.key !== item.key));
    if (editing === item.key) setEditing(null);
    toast({
      title: `Removed ${item.fact.id} — not saved yet`,
      action: {
        label: "Undo",
        onClick: () =>
          setItems((xs) => {
            const next = [...xs];
            next.splice(Math.min(index, next.length), 0, item);
            return next;
          }),
      },
    });
  };

  const save = async () => {
    const found = validateMasterCv(draft);
    setTried(true);
    setErrors(found);
    if (hasErrors(found)) {
      const firstBad = Number(Object.keys(found.facts)[0]);
      if (!Number.isNaN(firstBad) && items[firstBad]) setEditing(items[firstBad]!.key);
      toast({ title: Object.keys(found.facts).length ? "Fix the highlighted facts before saving" : "Fix your contact details before saving", tone: "err" });
      return;
    }
    setSaving(true);
    try {
      const result = await data.save(draft);
      setSaved(result);
      setExists(true);
      setContact(result.contact);
      setItems(toItems(result.facts));
      setEditing(null);
      setErrors(NO_ERRORS);
      setTried(false);
      // Facts added from Ba's words are part of this saved version now: Undo no longer applies.
      setAdded([]);
      const [v, r] = await Promise.all([data.versions(), data.factRequests()]);
      setVersions(v);
      setRequests(r);
      toast({
        title: exists ? `Master CV saved as v${result.version} — review cards built on v${saved.version} will offer to regenerate.` : `Master CV created (v${result.version})`,
      });
    } catch (e) {
      if (errorReason(e) === "master_cv_changed") {
        const current = errorDetails(e)?.currentVersion;
        setConflict(typeof current === "number" ? current : saved.version + 1);
      } else {
        toast({ title: `Couldn't save the master CV: ${errorText(e)}`, tone: "err" });
      }
    } finally {
      setSaving(false);
    }
  };

  // ---------------------------------------------------------------- facts from Ba's words

  /** Start a draft: `key` is the request id, or FREE for the free-text box. */
  const draftFrom = async (key: string, text: string, request: FactRequestItem | null) => {
    setNotes((n) => ({ ...n, [key]: null }));
    setDrafting((d) => ({ ...d, [key]: true }));
    try {
      const { taskId } = await data.draftFacts({ text: text.trim(), factRequestId: request?.id ?? null, version: saved.version });
      const view = await data.awaitFactDraft(taskId, { signal: alive.current.signal });
      if (alive.current.signal.aborted) return;
      if (view.status === "added") await onAdded(key, view, request);
      else if (view.status === "no_facts") {
        setNotes((n) => ({
          ...n,
          [key]: { tone: "note", text: view.notes ?? "CV found nothing to add from your words.", rejected: view.rejected.map((r) => ({ text: r.text, reasons: r.reasons })) },
        }));
      } else setNotes((n) => ({ ...n, [key]: { tone: "error", text: `CV couldn't write the fact: ${view.error ?? "the task failed"}. Try again.` } }));
    } catch (e) {
      if (errorReason(e) === "master_cv_changed") {
        const current = errorDetails(e)?.currentVersion;
        setConflict(typeof current === "number" ? current : saved.version + 1);
      } else setNotes((n) => ({ ...n, [key]: { tone: "error", text: `Couldn't send your answer: ${errorText(e)}` } }));
    } finally {
      if (!alive.current.signal.aborted) setDrafting((d) => ({ ...d, [key]: false }));
    }
  };

  /** CV's facts are in the master CV: show them highlighted (Undo / Edit), keep Ba's unsaved edits. */
  const onAdded = async (key: string, view: FactDraftView, request: FactRequestItem | null) => {
    const read = await data.get();
    const server = read.state === "ok" ? read.cv : { ...saved, version: view.version ?? saved.version + 1, facts: [...saved.facts, ...view.facts] };
    const have = new Set(items.map((i) => i.fact.id));
    const fresh = view.facts.filter((f) => !have.has(f.id));
    setItems((xs) => [...xs, ...toItems(fresh)]);
    setSaved(server);
    setTexts((t) => ({ ...t, [key]: "" }));
    setAdded((a) => [...a, { taskId: view.taskId, version: view.version!, factIds: view.facts.map((f) => f.id), requestId: request?.id ?? null, jobId: view.retailor?.jobId ?? null }]);
    if (view.retailor) {
      const job = view.retailor;
      setRetailor((r) => [...r.filter((x) => x.jobId !== job.jobId), job]);
    }
    if (request) setRequests((rs) => rs.filter((x) => x.id !== request.id));
    const [v, r] = await Promise.all([data.versions(), data.factRequests()]);
    setVersions(v);
    setRequests(r);
    toast({ title: `${view.facts.length === 1 ? `Added ${view.facts[0]!.id}` : `Added ${view.facts.length} facts`} from your words (v${server.version}). Undo or edit it below.` });
  };

  const undoAdded = async (group: AddedGroup) => {
    setUndoing(group.taskId);
    try {
      const restored = await data.undoFacts(group.version);
      const ids = new Set(group.factIds);
      setItems((xs) => xs.filter((i) => !ids.has(i.fact.id)));
      if (editing !== null && items.some((i) => i.key === editing && ids.has(i.fact.id))) setEditing(null);
      setSaved(restored);
      setAdded((a) => a.filter((g) => g.taskId !== group.taskId));
      if (group.jobId && !added.some((g) => g.taskId !== group.taskId && g.jobId === group.jobId)) setRetailor((r) => r.filter((x) => x.jobId !== group.jobId));
      const [v, r] = await Promise.all([data.versions(), data.factRequests()]);
      setVersions(v);
      setRequests(r);
      toast({ title: `Undone — master CV restored as v${restored.version}.` });
    } catch (e) {
      toast({ title: `Couldn't undo: ${errorText(e)}`, tone: "err" });
    } finally {
      setUndoing(null);
    }
  };

  const retailorNow = async (): Promise<RetailorResult[]> => {
    const out: RetailorResult[] = [];
    for (const job of retailor) {
      if (job.stepIds.length === 0) {
        out.push({ jobId: job.jobId, company: job.company, problem: job.note ?? "there is no CV step to re-run; ask Lead to tailor it again." });
        continue;
      }
      const results = await data.rerunSteps(job.stepIds);
      const problem = Object.values(results).find((p) => p !== null) ?? null;
      out.push({ jobId: job.jobId, company: job.company, problem: problem ? `couldn't re-tailor (${problem})` : null });
    }
    return out;
  };

  const declineRequest = async (r: FactRequestItem) => {
    try {
      await data.dismissFactRequest(r.id);
      setRequests((rs) => rs.filter((x) => x.id !== r.id));
      toast({ title: `OK — CV goes on without ${r.topic}; it never invents facts.` });
    } catch (e) {
      toast({ title: `Couldn't answer CV: ${errorText(e)}`, tone: "err" });
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p data-testid="cv-header" className="max-w-xl text-xs text-muted">
          Only you edit these facts. Every CV bullet must cite fact ids; QA hard-fails anything not traceable here.{" "}
          {exists ? (
            <>
              Master version <b>v{saved.version}</b>.
            </>
          ) : (
            <b>New master CV — not saved yet.</b>
          )}
        </p>
        <div className="flex items-center gap-2">
          {dirty ? <span className="text-xs text-warn">unsaved changes</span> : null}
          <Button variant="primary" pill onClick={() => void save()} loading={saving} disabled={conflict !== null} data-testid="cv-save">
            Save
          </Button>
        </div>
      </div>

      {conflict !== null ? (
        <div role="alert" data-testid="cv-conflict" className="flex flex-wrap items-center gap-3 rounded-2xl border border-warn/40 bg-warn/10 p-3 text-xs text-warn">
          <span className="min-w-0 flex-1">
            The master CV changed since you opened it (now v{conflict}), in another tab or by hand. Reload to see the latest version — your unsaved edits on this page
            will be lost.
          </span>
          <Button size="sm" pill onClick={() => void onReload()} loading={reloading} leftIcon={<RefreshCw aria-hidden className="size-3.5" />}>
            Reload
          </Button>
        </div>
      ) : null}

      {retailor.length > 0 ? (
        <RetailorBanner key={retailor.map((j) => j.jobId).join(",")} jobs={retailor} onRetailor={retailorNow} onDismiss={() => setRetailor([])} />
      ) : null}

      {exists ? (
        <FreeTextFacts
          value={texts[FREE] ?? ""}
          onChange={(text) => setTexts((t) => ({ ...t, [FREE]: text }))}
          onSubmit={() => void draftFrom(FREE, texts[FREE] ?? "", null)}
          drafting={drafting[FREE] === true}
          disabled={conflict !== null}
          note={notes[FREE] ?? null}
        />
      ) : null}

      {requests.map((r) => (
        <FactRequestCard
          key={r.id}
          request={r}
          value={texts[r.id] ?? ""}
          onChange={(text) => setTexts((t) => ({ ...t, [r.id]: text }))}
          onSubmit={() => void draftFrom(r.id, texts[r.id] ?? "", r)}
          onDecline={() => void declineRequest(r)}
          drafting={drafting[r.id] === true}
          disabled={!exists || conflict !== null}
          note={notes[r.id] ?? null}
        />
      ))}

      <section aria-label="Contact" className="space-y-2 rounded-2xl border border-border bg-surface/60 p-4">
        <p className="text-xs font-medium">Contact</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" htmlFor={ids.name} error={errors.contact.name}>
            <Input id={ids.name} value={contact.name} invalid={!!errors.contact.name} onChange={(e) => setContact({ ...contact, name: e.target.value })} />
          </Field>
          <Field label="Email" htmlFor={ids.email} error={errors.contact.email}>
            <Input id={ids.email} type="email" value={contact.email} invalid={!!errors.contact.email} onChange={(e) => setContact({ ...contact, email: e.target.value })} />
          </Field>
          <Field label="Phone" htmlFor={ids.phone}>
            <Input id={ids.phone} value={contact.phone ?? ""} onChange={(e) => setContact({ ...contact, phone: e.target.value || null })} />
          </Field>
          <Field label="Location" htmlFor={ids.location}>
            <Input id={ids.location} value={contact.location ?? ""} onChange={(e) => setContact({ ...contact, location: e.target.value || null })} />
          </Field>
        </div>
      </section>

      <section aria-label="Facts" className="space-y-3">
        {items.map((item, index) => {
          const group = added.find((g) => g.factIds.includes(item.fact.id));
          const card = (
            <FactCard
              key={item.key}
              fact={item.fact}
              editing={editing === item.key}
              error={errors.facts[index]}
              onChange={(fact) => setFact(item.key, fact)}
              onEdit={() => setEditing(item.key)}
              onDone={() => setEditing(null)}
              onDelete={() => removeFact(item)}
            />
          );
          if (!group) return card;
          return (
            <div key={item.key} data-testid="fact-added" data-fact-id={item.fact.id} className="space-y-1 rounded-[1.1rem] bg-accent/5 p-1 ring-1 ring-accent/50">
              <AddedBar factId={item.fact.id} undoing={undoing === group.taskId} onUndo={() => void undoAdded(group)} onEdit={() => setEditing(item.key)} />
              {card}
            </div>
          );
        })}
        <button
          type="button"
          onClick={() => addFact(newFact(items.map((i) => i.fact)))}
          className="rounded-full border border-dashed border-border px-4 py-2 text-muted transition hover:border-accent hover:text-fg"
        >
          + Add fact
        </button>
      </section>

      {versions.length ? (
        <section aria-label="Version history" className="space-y-2 rounded-2xl border border-border bg-surface/60 p-4">
          <p className="text-xs font-medium">Version history</p>
          <ol data-testid="cv-versions" className="space-y-1 text-xs">
            {versions.map((v) => (
              <li key={v.version} className="flex justify-between gap-3 rounded-lg bg-surface-2/50 px-3 py-1.5">
                <span className="flex items-center gap-2">
                  <span>v{v.version}</span>
                  {exists && v.version === saved.version ? <span className="text-accent">current</span> : null}
                </span>
                <span className="text-muted">
                  {v.factCount} facts · {formatDateTime(v.savedAt)}
                </span>
              </li>
            ))}
          </ol>
          <p className="text-[11px] text-muted">Open review cards built on an older version show “master data changed; regenerate?”.</p>
        </section>
      ) : null}
    </div>
  );
}
