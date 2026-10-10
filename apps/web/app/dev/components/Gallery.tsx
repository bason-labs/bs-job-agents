"use client";

import { CalendarClock, Copy, MoreHorizontal, Pencil, Play, Plus, Settings, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import {
  Badge,
  BotAvatar,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  Field,
  FileButton,
  FileDropzone,
  IconButton,
  Input,
  NumberInput,
  ProgressBar,
  Select,
  Skeleton,
  Slider,
  StatusDot,
  StatusPill,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  TimePicker,
  Tooltip,
  TrustBadge,
  UsageMeter,
  useToast,
  type ViewerFile,
} from "@/components/ui";
import type { BotLiveStatus } from "@/lib/api/types";
import { formatThousands } from "@/lib/format";
import { useHydrated } from "@/lib/useHydrated";
import { kindForFile } from "@/lib/files";
import { APPLICATION_STATUSES, RUN_STATUSES, TASK_STATUSES } from "@/lib/status";

const REPEAT_OPTIONS = [
  { value: "weekdays", label: "Weekdays" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "custom", label: "Custom" },
];

const APP_STATUS_OPTIONS = APPLICATION_STATUSES.map((s) => ({ value: s, label: s === "no_response" ? "No response" : s === "needs_check" ? "Needs check" : s[0]!.toUpperCase() + s.slice(1) }));

const SAMPLE_FILES: ViewerFile[] = [
  { name: "NovaPay_FE_EN_v2.pdf", kind: "pdf", url: "/dev/sample-cv.pdf", figmaUrl: "https://www.figma.com/", sizeBytes: 2014 },
  { name: "confirmation.png", kind: "image", url: "/dev/sample-screenshot.png", subtitle: "confirmation screenshot", sizeBytes: 2895 },
  { name: "jd_snapshot.txt", kind: "text", url: "/dev/sample-jd.txt", subtitle: "JD snapshot" },
  {
    name: "pre_submit.png",
    kind: "form",
    subtitle: "pre-submit screenshot",
    url: "/dev/sample-screenshot.png",
    fields: [
      { label: "CV", value: "BA_HUYNH_NovaPay_EN.pdf" },
      { label: "Contact details", value: "Ba Huynh · ba@example.com" },
      { label: "Preferred location", value: "Ho Chi Minh City" },
    ],
    consentText: "Employer personal-data-use agreement (TopCV)",
  },
  { name: "notes.docx", kind: "other" },
];

const BOT_STATUSES: BotLiveStatus[] = ["idle", "working", "waiting", "paused", "error", "offline"];

interface ScheduleRow {
  id: string;
  name: string;
  when: string;
  enabled: boolean;
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} data-testid={`section-${id}`} className="space-y-3">
      <h2 className="font-display text-sm font-semibold tracking-wider text-muted uppercase">{title}</h2>
      <Card className="space-y-4">{children}</Card>
    </section>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-3">{children}</div>;
}

export function Gallery() {
  const { toast } = useToast();
  const [repeat, setRepeat] = useState<string | null>("daily");
  const [time, setTime] = useState<string | null>("18:00");
  const [empty, setEmpty] = useState<string | null>(null);
  const [salary, setSalary] = useState<number | null>(30000000);
  const [fit, setFit] = useState(60);
  const [maxJobs, setMaxJobs] = useState(5);
  const [remember, setRemember] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(false);
  const [uploaded, setUploaded] = useState<ViewerFile[]>([]);
  const [rowStatus, setRowStatus] = useState<Record<string, string>>({ DEKON: "submitted", SMARTBIT: "interviewing", YAVIET: "needs_check" });
  const [schedules, setSchedules] = useState<ScheduleRow[]>([
    { id: "s1", name: "Weekday morning scan", when: "Weekdays 09:00", enabled: true },
    { id: "s2", name: "Weekend scan", when: "Every Sat 10:00", enabled: false },
  ]);
  const [pendingDelete, setPendingDelete] = useState<ScheduleRow | null>(null);
  const hydrated = useHydrated();

  const deleteSchedule = () => {
    if (!pendingDelete) return;
    const removed = pendingDelete;
    const index = schedules.findIndex((s) => s.id === removed.id);
    setSchedules((xs) => xs.filter((s) => s.id !== removed.id));
    setPendingDelete(null);
    toast({
      title: `Deleted “${removed.name}”`,
      action: {
        label: "Undo",
        onClick: () => {
          setSchedules((xs) => [...xs.slice(0, index), removed, ...xs.slice(index)]);
          toast({ title: `Restored “${removed.name}”` });
        },
      },
    });
  };

  return (
    <div data-hydrated={hydrated || undefined} className="mx-auto max-w-5xl space-y-8 px-4 py-8 text-sm sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold">Component gallery</h1>
          <p className="text-muted">
            Every design-system component in every state (dev only). <Link href="/chat" className="text-accent hover:underline">Open the app</Link>
          </p>
        </div>
        <ThemeToggle />
      </header>

      <Section id="buttons" title="Button · IconButton · Tooltip">
        <Row>
          <Button variant="primary">Primary</Button>
          <Button>Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button variant="warn">Warn</Button>
          <Button variant="primary" pill>
            Pill
          </Button>
          <Button variant="primary" leftIcon={<Plus aria-hidden className="size-4" />}>
            New schedule
          </Button>
        </Row>
        <Row>
          <Button size="sm">Small</Button>
          <Button size="md">Medium</Button>
          <Button size="lg">Large</Button>
          <Button variant="primary" loading={loading} onClick={() => (setLoading(true), setTimeout(() => setLoading(false), 1500))}>
            {loading ? "Saving…" : "Click to load"}
          </Button>
          <Button variant="primary" loading>
            Loading
          </Button>
          <Button disabled>Disabled</Button>
          <Button variant="primary" disabled>
            Disabled primary
          </Button>
        </Row>
        <Row>
          <IconButton label="Settings" icon={<Settings aria-hidden />} />
          <IconButton label="Copy" variant="secondary" icon={<Copy aria-hidden />} />
          <IconButton label="Add" variant="primary" icon={<Plus aria-hidden />} />
          <IconButton label="Small edit" size="sm" icon={<Pencil aria-hidden />} />
          <IconButton label="Disabled" disabled icon={<Trash2 aria-hidden />} />
          <Tooltip content="Runs the job-scan workflow now">
            <Button size="sm" leftIcon={<Play aria-hidden className="size-3.5" />}>
              Hover for tooltip
            </Button>
          </Tooltip>
          <Link href="#buttons" className="text-accent hover:underline">
            A text link
          </Link>
        </Row>
      </Section>

      <Section id="inputs" title="Input · Textarea · Field">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="g-name" hint="Shown in the schedules list.">
            <Input id="g-name" placeholder="e.g. Weekday morning scan" />
          </Field>
          <Field label="Name (invalid)" htmlFor="g-name-bad" error="Give the schedule a name">
            <Input id="g-name-bad" invalid defaultValue="" />
          </Field>
          <Field label="Disabled" htmlFor="g-dis">
            <Input id="g-dis" disabled defaultValue="Read only" />
          </Field>
          <Field label="Request changes" htmlFor="g-ta">
            <Textarea id="g-ta" rows={3} placeholder="e.g. Lead with Next.js; drop the education portal project" />
          </Field>
        </div>
      </Section>

      <Section id="number-input" title="NumberInput">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Salary floor" htmlFor="g-salary" hint={<span data-testid="salary-value">value: {salary === null ? "null" : salary}</span>}>
            <NumberInput id="g-salary" aria-label="Salary floor" value={salary} onValueChange={setSalary} suffix="VND" min={0} />
          </Field>
          <Field label="Disabled" htmlFor="g-num-dis">
            <NumberInput id="g-num-dis" value={25000000} onValueChange={() => {}} disabled />
          </Field>
        </div>
      </Section>

      <Section id="select" title="Select · TimePicker">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Repeat" labelId="g-repeat-label" hint={<span data-testid="select-repeat-value">value: {repeat}</span>}>
            <Select aria-labelledby="g-repeat-label" data-testid="select-repeat" options={REPEAT_OPTIONS} value={repeat} onValueChange={setRepeat} />
          </Field>
          <Field label="Time (Asia/Ho_Chi_Minh)" labelId="g-time-label" hint={<span data-testid="select-time-value">value: {time}</span>}>
            <TimePicker aria-labelledby="g-time-label" data-testid="select-time" value={time} onValueChange={setTime} />
          </Field>
          <Field label="Placeholder / disabled" labelId="g-empty-label">
            <div className="space-y-2">
              <Select aria-labelledby="g-empty-label" data-testid="select-empty" options={REPEAT_OPTIONS} value={empty} onValueChange={setEmpty} />
              <Select aria-label="Disabled select" options={REPEAT_OPTIONS} value="daily" onValueChange={() => {}} disabled />
              <Select aria-label="Invalid select" options={REPEAT_OPTIONS} value={null} onValueChange={() => {}} invalid />
            </div>
          </Field>
        </div>
      </Section>

      <Section id="slider" title="Slider">
        <div className="grid gap-6 sm:grid-cols-2">
          <Slider label="Fit threshold" data-testid="slider-fit" min={40} max={90} step={5} value={fit} onValueChange={setFit} />
          <Slider label="Max jobs per scan" data-testid="slider-max-jobs" min={1} max={10} value={maxJobs} onValueChange={setMaxJobs} />
          <Slider label="Disabled" min={0} max={100} value={30} onValueChange={() => {}} disabled />
        </div>
      </Section>

      <Section id="toggles" title="Checkbox · Switch">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-3">
            <Checkbox checked={remember} onCheckedChange={setRemember} label="Remember this answer" description="Saved for future forms" />
            <Checkbox checked onCheckedChange={() => {}} label="Checked" />
            <Checkbox checked="indeterminate" onCheckedChange={() => {}} label="Indeterminate" />
            <Checkbox checked={false} onCheckedChange={() => {}} label="Disabled" disabled />
            <p data-testid="checkbox-value" className="text-xs text-muted">
              remember: {String(remember)}
            </p>
          </div>
          <div className="space-y-3">
            <Switch checked={enabled} onCheckedChange={setEnabled} label="Enabled" />
            <Switch checked={false} onCheckedChange={() => {}} label="Small" size="sm" />
            <Switch checked onCheckedChange={() => {}} label="Disabled on" disabled />
            <p data-testid="switch-value" className="text-xs text-muted">
              enabled: {String(enabled)}
            </p>
          </div>
        </div>
      </Section>

      <Section id="tabs" title="Tabs">
        <Tabs defaultValue="lead">
          <TabsList aria-label="Bots">
            {["Lead", "Research", "CV", "QA", "Apply"].map((b) => (
              <TabsTrigger key={b} value={b.toLowerCase()}>
                {b}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="lead">Lead takes every request and hands work to the team.</TabsContent>
          <TabsContent value="research">Research (consult mode).</TabsContent>
          <TabsContent value="cv">CV (consult mode).</TabsContent>
          <TabsContent value="qa">QA (consult mode).</TabsContent>
          <TabsContent value="apply">Apply (consult mode).</TabsContent>
        </Tabs>
        <Tabs defaultValue="facts" variant="underline">
          <TabsList aria-label="Master CV">
            <TabsTrigger value="facts">Facts</TabsTrigger>
            <TabsTrigger value="history">Version history</TabsTrigger>
            <TabsTrigger value="locked" disabled>
              Disabled
            </TabsTrigger>
          </TabsList>
          <TabsContent value="facts">Facts editor.</TabsContent>
          <TabsContent value="history">Version history.</TabsContent>
        </Tabs>
      </Section>

      <Section id="status" title="Badge · StatusPill · StatusDot · TrustBadge · Avatar">
        <Row>
          <Badge>neutral</Badge>
          <Badge tone="brand">brand</Badge>
          <Badge tone="accent">accent</Badge>
          <Badge tone="ok">ok</Badge>
          <Badge tone="warn">warn</Badge>
          <Badge tone="danger">danger</Badge>
          <Badge count>3</Badge>
        </Row>
        <div className="space-y-2">
          <p className="text-xs text-muted">Application statuses</p>
          <Row>
            {APPLICATION_STATUSES.map((s) => (
              <StatusPill key={s} status={s} />
            ))}
          </Row>
          <p className="text-xs text-muted">Task statuses</p>
          <Row>
            {TASK_STATUSES.map((s) => (
              <StatusPill key={s} status={s} />
            ))}
          </Row>
          <p className="text-xs text-muted">Run statuses</p>
          <Row>
            {RUN_STATUSES.map((s) => (
              <StatusPill key={s} status={s} />
            ))}
          </Row>
        </div>
        <Row>
          {BOT_STATUSES.map((s) => (
            <span key={s} className="inline-flex items-center gap-1.5 text-xs text-muted">
              <StatusDot status={s} /> {s}
            </span>
          ))}
        </Row>
        <Row>
          <TrustBadge level={0} />
          <TrustBadge level={1} />
          <TrustBadge level={2} />
          <BotAvatar name="Lead" lead />
          <BotAvatar name="Research" status="working" />
          <BotAvatar name="CV" size="md" />
          <BotAvatar name="QA" size="lg" status="idle" />
          <BotAvatar name="Lead" lead size="lg" />
        </Row>
      </Section>

      <Section id="cards" title="Card · EmptyState · Skeleton · ProgressBar · UsageMeter">
        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <CardHeader>
              <div>
                <CardTitle>NovaPay — Senior Frontend Engineer</CardTitle>
                <CardDescription>ITviec · 2,000–2,800 USD · HCM hybrid</CardDescription>
              </div>
              <Badge tone="accent">fit 87</Badge>
            </CardHeader>
            <p className="text-muted">A plain card.</p>
          </Card>
          <Card
            interactive
            role="button"
            tabIndex={0}
            onClick={() => toast({ title: "Card clicked" })}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                toast({ title: "Card clicked" });
              }
            }}
            data-testid="interactive-card"
          >
            <CardTitle>Interactive card</CardTitle>
            <p className="text-muted">The whole card is clickable (hover border, pointer).</p>
          </Card>
        </div>
        <EmptyState
          icon={<CalendarClock aria-hidden />}
          title="No schedules yet"
          description="Scheduled scans run the job-scan workflow at set times."
          action={
            <Button variant="primary" size="sm" leftIcon={<Plus aria-hidden className="size-3.5" />}>
              New schedule
            </Button>
          }
        />
        <div className="space-y-2">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-4 w-72" />
          <Skeleton className="h-24 w-full" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <ProgressBar value={35} label="Brand progress" />
            <ProgressBar value={70} tone="warn" label="Warn progress" />
            <ProgressBar value={90} tone="danger" label="Danger progress" />
          </div>
          <div className="space-y-2 rounded-2xl border border-border bg-surface-2/50 p-3">
            <UsageMeter label="Claude" utilization={0.42} />
            <UsageMeter label="ChatGPT" utilization={0.18} resumesInSeconds={840} />
          </div>
        </div>
      </Section>

      <Section id="dialogs" title="Dialog · ConfirmDialog · Toast (Undo)">
        <Row>
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="primary">Open dialog</Button>
            </DialogTrigger>
            <DialogContent
              title="New schedule"
              description="Esc, ✕ or a click on the backdrop closes it."
              footer={
                <>
                  <Button pill>Cancel</Button>
                  <Button pill variant="primary">
                    Save
                  </Button>
                </>
              }
            >
              <Field label="Name" htmlFor="dlg-name">
                <Input id="dlg-name" placeholder="e.g. Weekday morning scan" />
              </Field>
              <Field label="Repeat" labelId="dlg-repeat">
                <Select aria-labelledby="dlg-repeat" options={REPEAT_OPTIONS} value={repeat} onValueChange={setRepeat} />
              </Field>
            </DialogContent>
          </Dialog>
          <Button onClick={() => toast({ title: "Schedule created" })}>Show toast</Button>
          <Button onClick={() => toast({ title: "Cron needs 5 fields, e.g. 0 9 * * 1-5", tone: "err" })}>Show error toast</Button>
        </Row>
        <ul data-testid="schedule-list" className="divide-y divide-border rounded-2xl border border-border">
          {schedules.map((s) => (
            <li key={s.id} data-testid="schedule-row" className="flex items-center justify-between gap-3 px-4 py-3">
              <div>
                <p className="font-medium">{s.name}</p>
                <p className="text-xs text-muted">{s.when}</p>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  aria-label={`Enable ${s.name}`}
                  size="sm"
                  checked={s.enabled}
                  onCheckedChange={(v) => setSchedules((xs) => xs.map((x) => (x.id === s.id ? { ...x, enabled: v } : x)))}
                />
                <IconButton label={`Delete ${s.name}`} icon={<Trash2 aria-hidden />} onClick={() => setPendingDelete(s)} />
              </div>
            </li>
          ))}
          {schedules.length === 0 ? <li className="px-4 py-3 text-muted">No schedules.</li> : null}
        </ul>
        <ConfirmDialog
          open={pendingDelete !== null}
          onOpenChange={(open) => !open && setPendingDelete(null)}
          title={`Delete “${pendingDelete?.name ?? ""}”?`}
          description="Future scans from this schedule stop. Past runs, review cards and applications are kept. You can undo for a few seconds."
          confirmLabel="Delete schedule"
          onConfirm={deleteSchedule}
        />
      </Section>

      <Section id="table" title="DropdownMenu + Select inside a clipping table">
        <p className="text-xs text-muted">The container below has overflow hidden and a fixed height; menus and selects still render fully (portal).</p>
        <div data-testid="clipping-container" className="h-44 overflow-hidden rounded-2xl border border-border">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted">
              <tr className="border-b border-border">
                <th className="px-4 py-2 font-medium">Company</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Badge</th>
                <th className="w-10 px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {Object.keys(rowStatus).map((company, i) => (
                <tr key={company} className="border-b border-border/60">
                  <td className="px-4 py-2">{company}</td>
                  <td className="px-4 py-2">
                    <div className="w-36">
                      <Select
                        size="sm"
                        aria-label={`Status for ${company}`}
                        data-testid={i === 2 ? "select-in-table" : undefined}
                        options={APP_STATUS_OPTIONS}
                        value={rowStatus[company]!}
                        onValueChange={(v) => setRowStatus((r) => ({ ...r, [company]: v }))}
                      />
                    </div>
                  </td>
                  <td className="px-4 py-2">
                    <StatusPill status={rowStatus[company]!} />
                  </td>
                  <td className="px-4 py-2">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <IconButton label={`Actions for ${company}`} size="sm" icon={<MoreHorizontal aria-hidden />} data-testid={i === 2 ? "row-menu-trigger" : undefined} />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent data-testid={i === 2 ? "row-menu" : undefined}>
                        <DropdownMenuLabel>{company}</DropdownMenuLabel>
                        <DropdownMenuItem icon={<Play aria-hidden />} onSelect={() => toast({ title: `Run now: ${company}` })}>
                          Run now
                        </DropdownMenuItem>
                        <DropdownMenuItem icon={<Pencil aria-hidden />}>Edit</DropdownMenuItem>
                        <DropdownMenuItem icon={<Copy aria-hidden />} disabled>
                          Duplicate (disabled)
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem danger icon={<Trash2 aria-hidden />}>
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section id="files" title="FileDropzone · FileViewer">
        <div data-testid="file-list" className="flex flex-wrap gap-2">
          {SAMPLE_FILES.map((f) => (
            <FileButton key={f.name} file={f} />
          ))}
        </div>
        <FileDropzone
          multiple
          onFiles={(files) =>
            setUploaded((xs) => [
              ...xs,
              ...files.map((f) => ({ name: f.name, kind: kindForFile(f.name, f.type), url: URL.createObjectURL(f), sizeBytes: f.size })),
            ])
          }
        />
        {uploaded.length ? (
          <div data-testid="uploaded-list" className="flex flex-wrap gap-2">
            {uploaded.map((f) => (
              <FileButton key={f.url} file={f} />
            ))}
          </div>
        ) : null}
        <FileDropzone disabled label="Disabled dropzone" onFiles={() => {}} />
      </Section>

      <p className="text-center text-xs text-muted">
        Salary {formatThousands(salary)} · fit ≥ {fit} · {maxJobs} jobs per scan
      </p>
    </div>
  );
}
