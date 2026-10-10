"use client";

import type { SavedAnswer, SearchProfile } from "@bs-job-agents/shared";
import Link from "next/link";
import { useId, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { formatDateTime } from "@/components/schedules/datetime";
import { Button, Field, NumberInput, Select, Slider, useToast } from "@/components/ui";
import { ChipInput, ToggleChips } from "./ChipInput";
import { SavedAnswers } from "./SavedAnswers";
import { criteriaData, type CriteriaData, type CriteriaVersions } from "./data";
import {
  CHIP_FIELDS,
  CURRENCY_OPTIONS,
  SALARY_POLICY_OPTIONS,
  SENIORITY_OPTIONS,
  SOURCE_OPTIONS,
  WORK_MODE_OPTIONS,
  formToRequest,
  isDirty,
  profileHeader,
  profileToForm,
  toggleValue,
  validateCriteria,
  type CriteriaErrors,
  type CriteriaForm,
} from "./logic";

export interface CriteriaScreenProps {
  initial: SearchProfile;
  initialVersions: CriteriaVersions["versions"];
  /** UC-12 remembered answers, shown next to the form defaults. */
  initialAnswers?: SavedAnswer[];
  /** Defaults to the app's data source; tests pass their own. */
  data?: CriteriaData;
}

function Card({ children, className, invalid }: { children: ReactNode; className?: string; invalid?: boolean }) {
  return <div className={cn("space-y-2 rounded-2xl border bg-surface/60 p-4", invalid ? "border-danger/60" : "border-border", className)}>{children}</div>;
}

function CardLabel({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} className="text-xs font-medium">
      {children}
    </p>
  );
}

function FieldError({ children }: { children?: string }) {
  return children ? (
    <p role="alert" className="text-xs text-danger">
      {children}
    </p>
  ) : null;
}

const SALARY_RULE_NOTES: Record<CriteriaForm["salaryPolicy"], ReactNode> = {
  blank_if_optional: (
    <>
      If a form makes salary <b>required</b>, Apply writes “Negotiable / Thỏa thuận” when the field accepts text; otherwise it asks you.
    </>
  ),
  negotiable: <>Apply writes “Negotiable” on English forms and “Thỏa thuận” on Vietnamese forms.</>,
  fixed: <>Apply writes this amount in the expected-salary field.</>,
  ask: <>Apply asks you in chat each time, with Skip and Negotiable / Thỏa thuận offered.</>,
};

/** UC-21b: edit the active Search Profile (§7.5); saving creates a new version. */
export function CriteriaScreen({ initial, initialVersions, initialAnswers = [], data = criteriaData }: CriteriaScreenProps) {
  const [profile, setProfile] = useState(initial);
  const [form, setForm] = useState<CriteriaForm>(() => profileToForm(initial));
  const [versions, setVersions] = useState(initialVersions);
  const [errors, setErrors] = useState<CriteriaErrors>({});
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const { toast } = useToast();
  const ids = { sources: useId(), modes: useId(), seniority: useId(), salary: useId(), amount: useId(), policy: useId(), minSalary: useId() };

  const dirty = isDirty(form, profile);

  const update = (patch: Partial<CriteriaForm>) => {
    const next = { ...form, ...patch };
    setForm(next);
    if (tried) setErrors(validateCriteria(next));
  };

  const save = async () => {
    const found = validateCriteria(form);
    setTried(true);
    setErrors(found);
    if (found.roles || found.locations || found.sources) {
      toast({ title: "Need at least one role, location and source", tone: "err" });
      return;
    }
    const first = Object.values(found)[0];
    if (first) {
      toast({ title: first, tone: "err" });
      return;
    }
    setSaving(true);
    try {
      const saved = await data.save(formToRequest(form));
      setProfile(saved);
      setForm(profileToForm(saved));
      setJustSaved(true);
      toast({ title: `Search criteria saved as v${saved.version}` });
      setVersions((await data.versions()).versions);
    } catch (e) {
      toast({ title: `Couldn't save the criteria: ${e instanceof Error ? e.message : String(e)}`, tone: "err" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p data-testid="criteria-header" className="text-xs text-muted">
          {profileHeader(profile, justSaved && !dirty)} · used by{" "}
          <Link href="/schedules" className="text-accent hover:underline">
            scheduled scans
          </Link>{" "}
          and chat requests
        </p>
        <div className="flex items-center gap-2">
          {dirty ? <span className="text-xs text-warn">unsaved changes</span> : null}
          <Button variant="primary" pill onClick={() => void save()} loading={saving} data-testid="criteria-save">
            Save
          </Button>
        </div>
      </div>

      {CHIP_FIELDS.map(({ key, label }) => (
        <Card key={key} invalid={!!errors[key]}>
          <CardLabel>{label}</CardLabel>
          <ChipInput label={label} values={form[key]} onChange={(values) => update({ [key]: values })} invalid={!!errors[key]} data-testid={`criteria-${key}`} />
          <FieldError>{errors[key]}</FieldError>
        </Card>
      ))}

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardLabel id={ids.minSalary}>Minimum salary</CardLabel>
          <div className="flex gap-2">
            <NumberInput
              aria-labelledby={ids.minSalary}
              value={form.minSalary}
              onValueChange={(minSalary) => update({ minSalary })}
              placeholder="no minimum"
              className="min-w-0 flex-1"
              data-testid="criteria-min-salary"
            />
            <div className="w-28 shrink-0">
              <Select
                aria-label="Currency"
                options={CURRENCY_OPTIONS}
                value={form.currency}
                onValueChange={(currency) => update({ currency: currency as CriteriaForm["currency"] })}
                data-testid="criteria-currency"
              />
            </div>
          </div>
        </Card>
        <Card invalid={!!errors.sources}>
          <CardLabel id={ids.sources}>Sources</CardLabel>
          <ToggleChips
            label="Sources"
            options={SOURCE_OPTIONS}
            values={form.sources}
            onToggle={(v) => update({ sources: toggleValue(form.sources, v, SOURCE_OPTIONS.map((o) => o.value)) })}
            invalid={!!errors.sources}
            data-testid="criteria-sources"
          />
          <FieldError>{errors.sources}</FieldError>
        </Card>
        <Card>
          <CardLabel>Work mode</CardLabel>
          <ToggleChips
            label="Work mode"
            options={WORK_MODE_OPTIONS}
            values={form.workModes}
            onToggle={(v) => update({ workModes: toggleValue(form.workModes, v, WORK_MODE_OPTIONS.map((o) => o.value)) })}
          />
        </Card>
        <Card>
          <CardLabel>Seniority</CardLabel>
          <ToggleChips
            label="Seniority"
            options={SENIORITY_OPTIONS}
            values={form.seniority}
            onToggle={(v) => update({ seniority: toggleValue(form.seniority, v, SENIORITY_OPTIONS.map((o) => o.value)) })}
          />
        </Card>
        <Card>
          <Slider label="Max jobs per scan" min={1} max={10} value={form.maxJobs} onValueChange={(maxJobs) => update({ maxJobs })} data-testid="criteria-max-jobs" />
        </Card>
        <Card>
          <Slider
            label="Fit threshold"
            min={40}
            max={90}
            step={5}
            value={form.fitThreshold}
            onValueChange={(fitThreshold) => update({ fitThreshold })}
            data-testid="criteria-fit"
          />
        </Card>
      </div>

      <Card className="space-y-3" invalid={!!errors.salaryAmount}>
        <div>
          <CardLabel>Application form defaults</CardLabel>
          <p className="mt-0.5 text-[11px] text-muted">
            How Apply fills fields you haven&apos;t answered before. Optional fields never block a submission — they&apos;re left blank and recorded.
          </p>
        </div>
        <div className="grid items-start gap-3 sm:grid-cols-2">
          <Field label="Expected salary" labelId={ids.policy}>
            <Select
              aria-labelledby={ids.policy}
              options={SALARY_POLICY_OPTIONS}
              value={form.salaryPolicy}
              onValueChange={(v) => update({ salaryPolicy: v as CriteriaForm["salaryPolicy"] })}
              data-testid="criteria-salary-policy"
            />
          </Field>
          {form.salaryPolicy === "fixed" ? (
            <Field label={`Amount (${form.currency})`} htmlFor={ids.amount} error={errors.salaryAmount}>
              <NumberInput
                id={ids.amount}
                value={form.salaryAmount}
                onValueChange={(salaryAmount) => update({ salaryAmount })}
                placeholder="e.g. 30,000,000"
                invalid={!!errors.salaryAmount}
                data-testid="criteria-salary-amount"
              />
            </Field>
          ) : null}
        </div>
        <p data-testid="criteria-salary-note" className="text-[11px] text-muted">
          {SALARY_RULE_NOTES[form.salaryPolicy]}
        </p>
      </Card>

      <SavedAnswers initial={initialAnswers} data={data} />

      <p className="text-xs text-muted">CV languages: English for English JDs; Vietnamese + English for Vietnamese JDs.</p>

      <Card>
        <CardLabel>Version history</CardLabel>
        <ol data-testid="criteria-versions" className="space-y-1 text-xs">
          {versions.map((v) => (
            <li key={v.version} className="flex justify-between rounded-lg bg-surface-2/50 px-3 py-1.5">
              <span className="flex items-center gap-2">
                <span>v{v.version}</span>
                {v.active ? <span className="text-accent">active</span> : null}
              </span>
              <span className="text-muted">{formatDateTime(v.updatedAt)}</span>
            </li>
          ))}
        </ol>
        <p className="text-[11px] text-muted">A scan keeps the version it started with; saving makes a new version for the next scan.</p>
      </Card>
    </div>
  );
}
