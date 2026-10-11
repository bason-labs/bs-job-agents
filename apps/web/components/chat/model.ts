// Pure logic behind the chat screen (§11 Chat; UC-01, UC-12, UC-17, UC-25), kept apart from the
// components so it is unit-tested: message merging, rich text, card liveness, pause-card copy
// (PM S24 wording) and the run card's delegation trace (Lead → @Bot: task · status).
import { parsePauseReason, type AppEvent, type Message, type PendingQuestion, type Step, type Task } from "@bs-job-agents/shared";
import { stepPreview, type RunView, type StepView } from "@/lib/api/runs";

// ---------------------------------------------------------------- messages

const byTime = (a: Message, b: Message) =>
  a.createdAt.localeCompare(b.createdAt) || (Number(a.id) - Number(b.id) || 0) || a.id.localeCompare(b.id);

/** Server pages + live messages: one entry per id (the newest copy wins), in time order. */
export function mergeMessages(list: readonly Message[], incoming: readonly Message[]): Message[] {
  const map = new Map(list.map((m) => [m.id, m]));
  for (const m of incoming) map.set(m.id, m);
  return [...map.values()].sort(byTime);
}

export interface RichSegment {
  bold: boolean;
  text: string;
}

/** `**bold**` → bold segments; everything else stays plain text (never HTML). */
export function parseRichText(text: string): RichSegment[] {
  const out: RichSegment[] = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ bold: false, text: text.slice(last, m.index) });
    out.push({ bold: true, text: m[1]! });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ bold: false, text: text.slice(last) });
  return out;
}

// ---------------------------------------------------------------- "is working" (PM3 S5)

/** The conversation task behind a chat screen: Lead's `lead.chat`, or a bot's `<bot>.consult`. */
export interface ConversationTaskRef {
  botName: string;
  kind: string;
}

/** Running conversation tasks of one chat, by task id, with the tool steps seen so far. */
export type WorkingTasks = Record<string, string[]>;

const ORCHESTRATOR_TOOL = "mcp__orchestrator__";
const field = (text: string | null, key: string): string | null => {
  const m = text ? new RegExp(`"${key}"\\s*:\\s*"([^"]{1,80})"`).exec(text) : null;
  return m ? m[1]! : null;
};
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** One line per tool call ("Starting job-scan…"); replies are whole JSON, so tool steps are the live signal. */
export function toolStepText(tool: string, text: string | null): string {
  if (!tool.startsWith(ORCHESTRATOR_TOOL)) return text ? `${tool}: ${text}` : `${tool}…`;
  const name = tool.slice(ORCHESTRATOR_TOOL.length);
  switch (name) {
    case "start_workflow":
      return `Starting ${field(text, "workflow") ?? "a workflow"}…`;
    case "get_status": {
      const run = field(text, "runId");
      return run ? `Checking run ${run}…` : "Checking the status…";
    }
    case "get_result": {
      const task = field(text, "taskId");
      return task ? `Reading the result of task ${task}…` : "Reading a result…";
    }
    case "create_task": {
      const bot = field(text, "bot");
      const kind = field(text, "kind");
      return bot ? `Asking ${capital(bot)}${kind ? ` (${kind})` : ""}…` : "Creating a task…";
    }
    case "message_user":
      return "Writing to you…";
    case "propose_workflow":
      return "Proposing a workflow…";
    default:
      return `${name.replace(/_/g, " ")}…`;
  }
}

/**
 * The chat's "is working" state from task events: a conversation task of this chat starts it, each
 * tool call adds a step, its end (done, failed, interrupted) clears it. No timer: a long Opus turn
 * keeps the indicator for as long as the task runs.
 */
export function workingReducer(state: WorkingTasks, e: AppEvent, ref: ConversationTaskRef): WorkingTasks {
  switch (e.type) {
    case "task.started":
      return e.botName === ref.botName && e.kind === ref.kind ? { ...state, [e.taskId]: [] } : state;
    case "task.progress": {
      const steps = state[e.taskId];
      if (!steps || e.kind !== "tool_use" || !e.tool) return state;
      return { ...state, [e.taskId]: [...steps, toolStepText(e.tool, e.text)].slice(-3) };
    }
    case "task.finished": {
      if (!(e.taskId in state)) return state;
      const { [e.taskId]: _ended, ...rest } = state;
      return rest;
    }
    default:
      return state;
  }
}

// ---------------------------------------------------------------- question and pause cards

export type TaskPhase = "paused" | "running" | "ended";

/** What a task event says about the task a question or pause card waits on. */
export function taskPhaseOf(e: AppEvent): [string, TaskPhase] | null {
  switch (e.type) {
    case "task.paused":
      return [e.taskId, "paused"];
    case "task.resumed":
    case "task.started":
      return [e.taskId, "running"];
    case "task.finished":
      return [e.taskId, "ended"];
    default:
      return null;
  }
}

/** Apply asks one question at a time: only a task's newest question card can be answered. */
export function isLatestQuestion(messages: readonly Message[], taskId: string, field: string): boolean {
  let latest: string | null = null;
  for (const m of messages) for (const c of m.cards) if (c.type === "question" && c.taskId === taskId) latest = c.question.field;
  return latest === field;
}

export function questionPlaceholder(kind: PendingQuestion["kind"]): string {
  switch (kind) {
    case "salary":
      return "e.g. 32,000,000";
    case "date":
      return "e.g. 2 weeks after offer";
    case "number":
      return "e.g. 3";
    default:
      return "Type your answer";
  }
}

export interface PauseCopy {
  title: string;
  body: string;
  /** The site to show prominently (login, CAPTCHA, a domain to confirm). */
  host: string | null;
  /** null = the task continues by itself (Figma bridge, Chrome, usage limit). */
  action: { label: string; confirmDomain: string | null } | null;
  note: string | null;
}

/** Copy for a pause card (`meta.cards` reason like `needs_login(linkedin.com)`). */
export function pauseCopy(reason: string, bot: string | null): PauseCopy {
  const r = parsePauseReason(reason);
  const who = bot ?? "The bot";
  const group = bot ? `${bot}'s tab group` : "the bot's tab group";
  switch (r?.code) {
    case "domain_confirm":
      return {
        title: "Allow another site?",
        body: `Apply tried to open ${r.site}, which is not the employer's job site. Allow it for this application?`,
        host: r.site,
        action: { label: `Allow ${r.site}`, confirmDomain: r.site },
        note: "Not sure? Leave it — Apply stays paused and nothing is sent.",
      };
    case "needs_login":
      return {
        title: `Log in to ${r.site}`,
        body: `${who} paused because ${r.site} needs you to log in. Log in in your Chrome (the bot's tab is in ${group}), then click Done.`,
        host: r.site,
        action: { label: "Done — I'm logged in", confirmDomain: null },
        note: "The app never stores your passwords; the login stays in your Chrome.",
      };
    case "captcha":
      return {
        title: `${r.site} is showing a CAPTCHA`,
        body: `Solve it in your Chrome (${group}), then click Done.`,
        host: r.site,
        action: { label: "Done — solved", confirmDomain: null },
        note: null,
      };
    case "needs_figma":
      return {
        title: "CV is waiting for Figma",
        body: "Open Figma desktop with your CV file, then run Plugins → Development → Figma Desktop Bridge. CV continues by itself once the bridge connects.",
        host: null,
        action: null,
        note: null,
      };
    case "needs_browser":
      return {
        title: "Chrome isn't connected",
        body: "Open Chrome with the Claude / ChatGPT extension. Browser steps start by themselves as soon as it reconnects.",
        host: null,
        action: null,
        note: null,
      };
    case "usage_limit":
      return { title: "Waiting for the usage limit", body: "This task waits for the subscription's usage limit to reset, then continues by itself.", host: null, action: null, note: null };
    case "needs_answer":
      return { title: "Waiting for your answer", body: "Answer the question card above to continue.", host: null, action: null, note: null };
    default:
      return { title: "Paused", body: reason, host: null, action: null, note: null };
  }
}

// ---------------------------------------------------------------- the run card's delegation trace

export type RowStatus = Step["status"] | "waiting_limit";

export interface DelegationRow {
  key: string;
  /** Bot name (research, cv, …). */
  bot: string;
  label: string;
  detail: string;
  status: RowStatus;
}

const ACTIVE = new Set(["running", "paused", "waiting", "waiting_limit"]);

function aggregateSteps(steps: readonly StepView[]): RowStatus {
  if (!steps.length) return "pending";
  const has = (s: string) => steps.some((x) => x.status === s);
  for (const s of ["running", "paused", "waiting", "failed"] as const) if (has(s)) return s;
  if (steps.every((x) => x.status === "done" || x.status === "skipped")) return "done";
  if (has("cancelled") && steps.every((x) => !["pending", "locked"].includes(x.status))) return "cancelled";
  return "pending";
}

function aggregateTasks(tasks: readonly Task[]): RowStatus | null {
  if (!tasks.length) return null;
  const has = (s: Task["status"]) => tasks.some((t) => t.status === s);
  if (has("running")) return "running";
  if (has("waiting_limit")) return "waiting_limit";
  if (has("paused")) return "paused";
  if (has("queued")) return "pending";
  if (tasks.every((t) => t.status === "done")) return "done";
  return "failed";
}

const SCAN_LABEL: Record<string, string> = { "apply-to-link": "Read the job page", "apply-to-file": "Read the JD file" };

/** One row per kind of delegated work, aggregated over the run's per-job branches. */
export function delegationRows(view: RunView): DelegationRow[] {
  const steps = view.steps;
  const of = (key: string) => steps.filter((s) => s.stepKey === key);
  const tasksOf = (stepIds: Set<string>, bot: string) => view.tasks.filter((t) => t.stepId !== null && stepIds.has(t.stepId) && t.botName === bot);
  const rows: DelegationRow[] = [];

  const scan = of("scan");
  rows.push({
    key: "scan",
    bot: "research",
    label: SCAN_LABEL[view.run.workflowName] ?? "Scan sources",
    detail: (scan[0] && stepPreview(scan[0])) ?? (view.run.workflowName === "job-scan" ? "TopCV · ITviec · LinkedIn" : "the job description"),
    status: aggregateTasks(tasksOf(new Set(scan.map((s) => s.id)), "research").filter((t) => t.status === "waiting_limit")) ?? aggregateSteps(scan),
  });

  const final = [...of("top"), ...of("selected")];
  const fitSteps = [...of("dedupe"), ...of("fit"), ...final];
  const fitDone = final.length > 0 && final.every((s) => s.status === "done");
  rows.push({
    key: "fit",
    bot: "research",
    label: view.run.workflowName === "job-scan" ? "Dedupe + fit score" : "Fit score",
    detail: (final[0] && stepPreview(final[0])) ?? (of("fit")[0] && stepPreview(of("fit")[0]!)) ?? "keep fit ≥ threshold",
    status: fitDone ? "done" : aggregateSteps(fitSteps),
  });

  const companies = of("company");
  const profiled = companies.filter((s) => s.status === "done" || s.status === "skipped");
  const cached = companies.filter((s) => s.status === "skipped" || (s.output as { cacheHit?: boolean } | null)?.cacheHit === true).length;
  rows.push({
    key: "company",
    bot: "research",
    label: "Company profile",
    detail: companies.length ? `${profiled.length}/${companies.length} profiles${cached ? ` · ${cached} cached` : ""}` : "per selected job",
    status: aggregateSteps(companies),
  });

  const tailors = of("tailor");
  const tailorIds = new Set(tailors.map((s) => s.id));
  const gate = (s: StepView) => (s.output ?? {}) as { rounds?: { total?: number | null; passed?: boolean | null }[]; outcome?: string };
  const ready = tailors.filter((s) => s.status === "done");
  rows.push({
    key: "cv",
    bot: "cv",
    label: "Tailor CV",
    detail: tailors.length === 1 ? (stepPreview(tailors[0]!) ?? "Figma Drafts page") : tailors.length ? `${ready.length}/${tailors.length} CVs ready` : "Figma Drafts page",
    status: aggregateTasks(tasksOf(tailorIds, "cv")) ?? aggregateSteps(tailors),
  });
  const totals = tailors.length === 1 ? (gate(tailors[0]!).rounds ?? []).map((r) => r.total).filter((t): t is number => typeof t === "number") : [];
  const passed = tailors.filter((s) => gate(s).outcome === "passed").length;
  rows.push({
    key: "qa",
    bot: "qa",
    label: "QA score vs JD",
    detail: totals.length ? totals.join(" → ") : tailors.length ? `${passed}/${tailors.length} passed` : "pass ≥ 80 · max 3 rounds",
    status: aggregateTasks(tasksOf(tailorIds, "qa")) ?? aggregateSteps(tailors),
  });

  const applies = of("apply").filter((s) => !["locked", "pending"].includes(s.status));
  if (applies.length) {
    const latest = applies.at(-1)!;
    rows.push({
      key: "apply",
      bot: "apply",
      label: "Fill & submit",
      detail: stepPreview(latest) ?? "",
      status: aggregateTasks(tasksOf(new Set(applies.map((s) => s.id)), "apply")) ?? aggregateSteps(applies),
    });
  }
  return rows;
}

export const isActiveRow = (status: RowStatus) => ACTIVE.has(status);

// ---------------------------------------------------------------- greetings and suggestions (prototype copy)

export const LEAD_GREETING = "Hi Ba 👋 I take every request and hand work to the team. Try: **“Find frontend jobs in HCM, React/Next.js, ≥ 25M”**.";

const CONSULT_GREETINGS: Record<string, string> = {
  research: "Hi Ba — Research here (consult mode). Ask me about job markets, companies or why a job scored the way it did. Work requests go to Lead.",
  cv: "Hi Ba — CV here (consult mode). Ask me how to position your experience, which template fits, or why I wrote a bullet. To change a CV, ask Lead or use “Request changes”.",
  qa: "Hi Ba — QA here (consult mode). Ask me why a CV passed or failed, or how I score.",
  apply: "Hi Ba — Apply here (consult mode). Ask me about forms, saved answers or past submissions. I only submit after you approve a review card.",
};

export function consultGreeting(bot: string, displayName: string): string {
  return CONSULT_GREETINGS[bot] ?? `Hi Ba — ${displayName} here (consult mode). Ask me anything within my role; work requests go to Lead.`;
}

export interface Suggestion {
  label: string;
  text: string;
  /** Read-only questions are sent at once; anything that starts work only fills the composer. */
  send: boolean;
}

export const LEAD_SUGGESTIONS: Suggestion[] = [
  { label: "Find frontend jobs in HCM", text: "Find frontend jobs in HCM, React/Next.js, salary ≥ 25M", send: false },
  { label: "Paste a job link", text: "Apply to this: ", send: false },
  { label: "Also include Đà Nẵng", text: "Also include Đà Nẵng", send: false },
  { label: "Status?", text: "What is the status?", send: true },
];

export const CONSULT_SUGGESTIONS: Suggestion[] = [
  { label: "Ask a question", text: "How do you decide what to emphasise?", send: true },
  { label: "Ask for work (→ handed to Lead)", text: "Find more AI jobs for me", send: false },
];
