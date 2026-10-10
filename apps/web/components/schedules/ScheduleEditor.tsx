"use client";

import Link from "next/link";
import { useId, useState, type FormEvent } from "react";
import { Button, Checkbox, Dialog, DialogContent, Field, Input, Select, TimePicker } from "@/components/ui";
import type { ProfileOption } from "./data";
import { DAY_OPTIONS, REPEAT_OPTIONS, repeatLabel, validateScheduleForm, type ScheduleForm, type ScheduleFormErrors, type Weekday } from "./logic";
import { Segmented } from "./Segmented";

/** Select values are strings; the active profile (null) gets this one. */
const ACTIVE_PROFILE = "__active__";

export interface ScheduleEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "edit";
  initial: ScheduleForm;
  profiles: readonly ProfileOption[];
  /** Resolves when saved; the editor closes itself only through onOpenChange from the caller. */
  onSave: (form: ScheduleForm) => Promise<void>;
  /** Edit mode only: Delete inside the modal opens the same confirmation as the row's 🗑. */
  onDelete?: () => void;
}

/**
 * Spec §11 Schedules modal editor: name, repeat, time (Asia/Ho_Chi_Minh), Search Profile,
 * enabled. The form starts from `initial` on mount: give it a new `key` for each opening.
 */
export function ScheduleEditor({ open, onOpenChange, mode, initial, profiles, onSave, onDelete }: ScheduleEditorProps) {
  const [form, setForm] = useState<ScheduleForm>(initial);
  const [errors, setErrors] = useState<ScheduleFormErrors>({});
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const formId = useId();
  const ids = { name: useId(), repeat: useId(), day: useId(), time: useId(), cron: useId(), profile: useId() };

  const update = (patch: Partial<ScheduleForm>) => {
    const next = { ...form, ...patch };
    setForm(next);
    if (tried) setErrors(validateScheduleForm(next));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const found = validateScheduleForm(form);
    setTried(true);
    setErrors(found);
    if (found.name) return document.getElementById(ids.name)?.focus();
    if (found.cron) return document.getElementById(ids.cron)?.focus();
    setSaving(true);
    try {
      await onSave(form);
    } finally {
      setSaving(false);
    }
  };

  const profileOptions = profiles.map((p) => ({ value: p.id ?? ACTIVE_PROFILE, label: p.label }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={mode === "create" ? "New schedule" : "Edit schedule"}
        data-testid="schedule-editor"
        footer={
          <>
            {mode === "edit" && onDelete ? (
              <Button pill variant="secondary" className="mr-auto border-danger/50 text-danger hover:border-danger" onClick={onDelete}>
                Delete
              </Button>
            ) : null}
            <Button pill onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button pill variant="primary" type="submit" form={formId} loading={saving}>
              Save
            </Button>
          </>
        }
      >
        <form id={formId} onSubmit={submit} noValidate className="space-y-3">
          <Field label="Name" htmlFor={ids.name} error={errors.name}>
            <Input
              id={ids.name}
              value={form.name}
              onChange={(e) => update({ name: e.target.value })}
              placeholder="e.g. Weekday morning scan"
              invalid={!!errors.name}
              autoFocus
            />
          </Field>

          <div className="space-y-1">
            <p id={ids.repeat} className="text-xs text-muted">
              Repeat
            </p>
            <Segmented aria-labelledby={ids.repeat} options={REPEAT_OPTIONS} value={form.freq} onValueChange={(freq) => update({ freq })} data-testid="schedule-repeat" />
          </div>

          {form.freq === "custom" ? (
            <Field label="Cron expression" htmlFor={ids.cron} error={errors.cron}>
              <Input
                id={ids.cron}
                value={form.cron}
                onChange={(e) => update({ cron: e.target.value })}
                placeholder="0 9 * * 1-5"
                className="font-mono"
                invalid={!!errors.cron}
                spellCheck={false}
              />
            </Field>
          ) : (
            <div className="flex gap-3">
              {form.freq === "weekly" ? (
                <Field label="Day" labelId={ids.day} className="flex-1">
                  <Select aria-labelledby={ids.day} options={DAY_OPTIONS} value={form.day} onValueChange={(day) => update({ day: day as Weekday })} data-testid="schedule-day" />
                </Field>
              ) : null}
              <Field label="Time (Asia/Ho_Chi_Minh)" labelId={ids.time} className="flex-1">
                <TimePicker aria-labelledby={ids.time} value={form.time} onValueChange={(time) => update({ time })} data-testid="schedule-time" />
              </Field>
            </div>
          )}

          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span id={ids.profile} className="text-muted">
                Search criteria
              </span>
              <Link href="/criteria" className="text-accent hover:underline">
                Edit criteria
              </Link>
            </div>
            <Select
              aria-labelledby={ids.profile}
              options={profileOptions}
              value={form.searchProfileId ?? ACTIVE_PROFILE}
              onValueChange={(v) => update({ searchProfileId: v === ACTIVE_PROFILE ? null : v })}
              data-testid="schedule-profile"
            />
          </div>

          <Checkbox checked={form.enabled} onCheckedChange={(enabled) => update({ enabled })} label="Enabled" />

          <p data-testid="schedule-runs" className="text-xs text-muted">
            Runs: {repeatLabel(form)}
          </p>
        </form>
      </DialogContent>
    </Dialog>
  );
}
