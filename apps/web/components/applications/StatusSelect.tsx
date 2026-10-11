"use client";

import type { Application, ApplicationStatus } from "@bs-job-agents/shared";
import { Select, StatusPill } from "@/components/ui";
import { statusMeta } from "@/lib/status";
import { statusChoices } from "./logic";

export interface StatusSelectProps {
  app: Pick<Application, "status" | "dryRun">;
  company: string;
  onChange: (status: ApplicationStatus) => void;
  disabled?: boolean;
}

/**
 * In-table status select (UC-13; prototype uiSelect). Offers only the moves the shared
 * status machine allows by hand; statuses Ba can't change show as a read-only pill.
 */
export function StatusSelect({ app, company, onChange, disabled }: StatusSelectProps) {
  const choices = statusChoices(app);
  if (!choices) return <StatusPill status={app.status} />;
  return (
    <div className="w-32">
      <Select
        size="sm"
        aria-label={`Status of ${company}`}
        options={choices.map((s) => ({ value: s, label: statusMeta(s).label }))}
        value={app.status}
        onValueChange={(v) => onChange(v as ApplicationStatus)}
        disabled={disabled}
        data-testid="status-select"
      />
    </div>
  );
}
