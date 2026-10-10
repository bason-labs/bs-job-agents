"use client";

import type { ScheduleView } from "@bs-job-agents/shared";
import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, ConfirmDialog, Switch, useToast } from "@/components/ui";
import { cn } from "@/lib/cn";
import { schedulesData, type ProfileOption, type SchedulesData } from "./data";
import { formToCreateRequest, formToUpdateRequest, newScheduleForm, scheduleSummary, scheduleToForm, type ScheduleForm } from "./logic";
import { ScheduleEditor } from "./ScheduleEditor";
import { errorText } from "./apiError";

export interface SchedulesScreenProps {
  initial: ScheduleView[];
  profiles: ProfileOption[];
  /** Defaults to the app's data source; tests pass their own. */
  data?: SchedulesData;
}

type EditorTarget = { mode: "create"; form: ScheduleForm } | { mode: "edit"; id: string; form: ScheduleForm };
type EditorState = EditorTarget & { key: number };

/** UC-21: create, edit, enable/disable, run now and delete (with Undo) schedules. */
export function SchedulesScreen({ initial, profiles, data = schedulesData }: SchedulesScreenProps) {
  const [rows, setRows] = useState(initial);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [confirm, setConfirm] = useState<ScheduleView | null>(null);
  const [deleting, setDeleting] = useState(false);
  const { toast } = useToast();
  const router = useRouter();

  const profileLabel = (row: ScheduleView) => profiles.find((p) => p.id === row.searchProfileId)?.label ?? row.searchProfileId ?? "Default";

  const openEditor = (next: EditorTarget) => {
    setEditor((prev) => ({ ...next, key: (prev?.key ?? 0) + 1 }));
    setEditorOpen(true);
  };
  const openCreate = () => openEditor({ mode: "create", form: newScheduleForm() });
  const openEdit = (row: ScheduleView) => openEditor({ mode: "edit", id: row.id, form: scheduleToForm(row) });

  const save = async (form: ScheduleForm) => {
    try {
      if (editor?.mode === "edit") {
        const saved = await data.update(editor.id, formToUpdateRequest(form));
        setRows((rs) => rs.map((r) => (r.id === saved.id ? saved : r)));
        toast({ title: "Schedule updated" });
      } else {
        const saved = await data.create(formToCreateRequest(form));
        setRows((rs) => [...rs, saved]);
        toast({ title: "Schedule created" });
      }
      setEditorOpen(false);
    } catch (e) {
      toast({ title: `Couldn't save the schedule: ${errorText(e)}`, tone: "err" });
    }
  };

  const setEnabled = async (row: ScheduleView, enabled: boolean) => {
    setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, enabled } : r)));
    try {
      const saved = await data.update(row.id, { enabled });
      setRows((rs) => rs.map((r) => (r.id === saved.id ? saved : r)));
    } catch (e) {
      setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, enabled: row.enabled } : r)));
      toast({ title: `Couldn't ${enabled ? "enable" : "disable"} “${row.name}”: ${errorText(e)}`, tone: "err" });
    }
  };

  const runNow = async (row: ScheduleView) => {
    try {
      const res = await data.runNow(row.id);
      if (res.started) router.push(`/flows/${res.runId}`);
      else toast({ title: `“${row.name}” is still running — a schedule never overlaps its previous run.`, tone: "info" });
    } catch (e) {
      toast({ title: `Couldn't start “${row.name}”: ${errorText(e)}`, tone: "err" });
    }
  };

  const restore = async (row: ScheduleView, index: number) => {
    try {
      const restored = await data.restore(row.id);
      setRows((rs) => {
        const next = rs.filter((r) => r.id !== restored.id);
        next.splice(Math.min(index, next.length), 0, restored);
        return next;
      });
      toast({ title: `Restored “${row.name}”` });
    } catch (e) {
      toast({ title: `Couldn't restore “${row.name}”: ${errorText(e)}`, tone: "err" });
    }
  };

  const remove = async (row: ScheduleView) => {
    const index = rows.findIndex((r) => r.id === row.id);
    setDeleting(true);
    try {
      await data.remove(row.id);
    } catch (e) {
      toast({ title: `Couldn't delete “${row.name}”: ${errorText(e)}`, tone: "err" });
      return;
    } finally {
      setDeleting(false);
      setConfirm(null);
    }
    setRows((rs) => rs.filter((r) => r.id !== row.id));
    toast({ title: `Deleted “${row.name}”`, action: { label: "Undo", onClick: () => void restore(row, index) } });
  };

  const askDelete = (row: ScheduleView) => {
    setEditorOpen(false);
    setConfirm(row);
  };

  const editing = editor?.mode === "edit" ? rows.find((r) => r.id === editor.id) : undefined;

  return (
    <div className="space-y-3">
      {rows.length === 0 ? (
        <div data-testid="schedules-empty" className="rounded-2xl border border-dashed border-border p-8 text-center text-muted">
          No schedules — scans only run when you ask Lead.{" "}
          <button type="button" onClick={openCreate} className="text-accent underline">
            Create one
          </button>
        </div>
      ) : null}

      <ul aria-label="Schedules" className="space-y-3">
        {rows.map((row) => (
          <li
            key={row.id}
            data-testid="schedule-row"
            data-clickable
            title="Edit schedule"
            onClick={() => openEdit(row)}
            className={cn(
              "flex flex-col gap-3 rounded-2xl border border-border bg-surface/60 p-4 transition hover:border-accent sm:flex-row sm:items-center sm:justify-between",
              !row.enabled && "opacity-80",
            )}
          >
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                openEdit(row);
              }}
              className="min-w-0 text-left"
              aria-label={`Edit ${row.name}`}
            >
              <span className="block font-medium">{row.name}</span>
              <span data-testid="schedule-summary" className="block text-xs text-muted">
                {scheduleSummary(row, profileLabel(row))}
              </span>
            </button>
            <div className="flex shrink-0 items-center gap-3" onClick={(e) => e.stopPropagation()}>
              <Button size="sm" pill onClick={() => void runNow(row)}>
                Run now
              </Button>
              <button
                type="button"
                aria-label={`Delete ${row.name}`}
                title="Delete schedule"
                onClick={() => askDelete(row)}
                className="grid size-8 place-items-center rounded-full border border-border text-muted transition hover:border-danger/60 hover:text-danger"
              >
                <Trash2 aria-hidden className="size-4" />
              </button>
              <Switch checked={row.enabled} onCheckedChange={(on) => void setEnabled(row, on)} aria-label={`${row.name} enabled`} />
            </div>
          </li>
        ))}
      </ul>

      <button
        type="button"
        onClick={openCreate}
        className="rounded-full border border-dashed border-border px-4 py-2 text-muted transition hover:border-accent hover:text-fg"
      >
        + New schedule
      </button>
      <p className="text-xs text-muted">
        Click a schedule to edit it. Missed while your Mac was asleep → one catch-up run if within 12 h. A schedule never overlaps its previous run.
      </p>

      {editor ? (
        <ScheduleEditor
          key={editor.key}
          open={editorOpen}
          onOpenChange={setEditorOpen}
          mode={editor.mode}
          initial={editor.form}
          profiles={profiles}
          onSave={save}
          onDelete={editing ? () => askDelete(editing) : undefined}
        />
      ) : null}

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={confirm ? `Delete “${confirm.name}”?` : ""}
        description="Future scans from this schedule stop. Past runs, review cards and applications are kept. You can undo for a few seconds."
        confirmLabel="Delete schedule"
        loading={deleting}
        onConfirm={() => confirm && void remove(confirm)}
      />
    </div>
  );
}
