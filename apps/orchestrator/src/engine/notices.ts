// PM2 S1 (decision 4): Lead's messages for engine events. Each is posted in the transaction of the
// state change it reports (a crash cannot lose it), one per event class, never one per attempt:
// - the UC-17 card for a task that waits for Ba (needs_login, captcha, domain_confirm);
// - one note per bridge wait (needs_browser, needs_figma);
// - a task that failed for good (§5.5 step 6), with UC-03 b's "<source> scan failed" / "adapter broken";
// - an application that needs a check (including after a crash) and a finished dry run;
// - an engine's usage-limit pause and its resume (UC-16);
// - the run summary when its cards are ready, or when it ends without cards (UC-02, UC-04 a).
// Chat-originated messages (Lead's replies, consult and room replies, UC-25 handoffs) are W3a's,
// through the ConversationSink.
import { CONVERSATION_TASK_KINDS, SEARCH_SOURCES, formatPauseReason, taskKey, type Engine, type MessageCard, type PauseReason } from "@bs-job-agents/shared";
import { appendMessage, getApplication, getCompany, getJob, getOrCreateLeadRoom, getStep, listEvents, listTasks, mappers, type Conn, type Task } from "../db/index.js";
import type { EngineCore } from "./core.js";

/** Audit row that marks a once-only notice (e.g. a run's cards-ready summary) as posted. */
export const NOTICE_EVENT = "lead.notice";

export const ENGINE_LABEL: Record<Engine, string> = { claude: "Claude", codex: "ChatGPT" };
// W5: every search source's label comes from shared SEARCH_SOURCES.
const SOURCE_LABEL: Record<string, string> = Object.fromEntries(Object.entries(SEARCH_SOURCES).map(([k, v]) => [k, v.label]));
const BOT_LABEL: Record<string, string> = { lead: "Lead", research: "Research", cv: "CV", qa: "QA", apply: "Apply" };

export const sourceLabel = (source: string): string => SOURCE_LABEL[source] ?? source;
const botLabel = (bot: string): string => BOT_LABEL[bot] ?? bot;

export interface NoticeOptions {
  text: string;
  runId?: number | null;
  cards?: MessageCard[];
  /** Post at most once per run (or overall without a run) under this key. */
  once?: string;
}

/** A message from Lead in the Lead chat, with its message.created event (inside `conn`'s transaction). */
export function postNotice(core: EngineCore, conn: Conn, opts: NoticeOptions): boolean {
  const runId = opts.runId ?? null;
  if (opts.once) {
    const posted = listEvents(conn, { types: [NOTICE_EVENT], ...(runId !== null ? { runId } : {}) }).some(
      (e) => (e.payload as { key?: unknown } | null)?.key === opts.once,
    );
    if (posted) return false;
    core.bus.audit(conn, NOTICE_EVENT, { key: opts.once }, { runId });
  }
  const room = getOrCreateLeadRoom(conn, { now: core.now() });
  const cards: MessageCard[] = [...(opts.cards ?? []), ...(runId !== null ? [{ type: "run" as const, runId: String(runId) }] : [])];
  const message = appendMessage(
    conn,
    { roomId: room.id, author: "lead", text: opts.text, runRefs: runId !== null ? [runId] : [], meta: cards.length > 0 ? { cards } : null },
    { now: core.now() },
  );
  core.bus.emit(conn, { type: "message.created", roomId: String(room.id), message: mappers.toMessage(message, room.kind, []) });
  return true;
}

/** "NovaPay – Senior Frontend Engineer", or null. */
export function jobLabel(conn: Conn, jobId: number | null | undefined): string | null {
  if (jobId === null || jobId === undefined) return null;
  const job = getJob(conn, jobId);
  if (!job) return null;
  const company = getCompany(conn, job.companyId)?.name;
  return company ? `${company} – ${job.title}` : job.title;
}

/** The job a task works on: its input's jobId, or the job of its per-job branch. */
function taskJobId(conn: Conn, task: Task): number | null {
  const raw = (task.input as { jobId?: unknown } | null)?.jobId;
  const fromInput = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : null;
  if (fromInput !== null) return fromInput;
  const branch = task.stepId === null ? undefined : getStep(conn, task.stepId)?.branchKey;
  const m = branch ? /^(\d+)(?::|$)/.exec(branch) : null;
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------- UC-17 pause cards

/** A task paused for Ba in his Chrome: the card with Done (the domain card asks with the host, S24 copy). */
export function noticePause(core: EngineCore, conn: Conn, task: Task, reason: PauseReason): void {
  if (reason.code !== "needs_login" && reason.code !== "captcha" && reason.code !== "domain_confirm") return;
  const site = reason.site ?? "the site";
  let text: string;
  if (task.botName === "apply") {
    const job = jobLabel(conn, taskJobId(conn, task)) ?? "this application";
    text =
      reason.code === "domain_confirm"
        ? `Apply tried to open ${site}, which is not the employer's job site. Allow it for this application?`
        : reason.code === "needs_login"
          ? `Apply needs you to log in to ${site} in your Chrome for ${job}. Log in, then click Done.`
          : `Apply hit a CAPTCHA on ${site} for ${job}. Solve it in your Chrome, then click Done.`;
  } else {
    const source = (task.input as { source?: unknown } | null)?.source;
    const what = typeof source === "string" ? `the ${sourceLabel(source)} scan` : "its task";
    const others = typeof source === "string" ? " The other sources go on." : "";
    const bot = botLabel(task.botName);
    text =
      reason.code === "captcha"
        ? `${bot} hit a CAPTCHA on ${site} during ${what}. Solve it in your Chrome, then click Done.${others}`
        : `${bot} needs you to log in to ${site} in your Chrome to continue ${what}.${others} Log in, then click Done.`;
  }
  postNotice(core, conn, { text, runId: task.runId, cards: [{ type: "pause", taskId: String(task.id), reason: formatPauseReason(reason) }] });
}

// ---------------------------------------------------------------- bridge waits

/** The first task to wait for Chrome (per engine) or Figma: one note per wait (§4.4, §6.2, §10.3). */
export function noticeBridgeWait(core: EngineCore, conn: Conn, task: Task, reason: "needs_browser" | "needs_figma", detail: string | null): void {
  const others = listTasks(conn, { status: "paused" }).filter(
    (t) => t.id !== task.id && t.pauseReason === reason && (reason !== "needs_browser" || t.engine === task.engine),
  );
  if (others.length > 0) return;
  const text =
    reason === "needs_browser"
      ? `🌐 Chrome is closed or its ${ENGINE_LABEL[task.engine]} extension is not connected, so browser steps are waiting. They start as soon as Chrome reconnects.`
      : `Figma desktop with the CV file and the Desktop Bridge plugin is not running, so CV steps are waiting.${detail ? ` ${detail}` : ""} They start by themselves once it connects.`;
  postNotice(core, conn, { text });
}

// ---------------------------------------------------------------- failed for good

const LANG = (input: unknown): string => String((input as { language?: unknown } | null)?.language ?? "").toUpperCase() || "the";

/**
 * §5.5 step 6 / §10.1 "Lead reports it": a task that failed for good (never for an attempt that is
 * retried). Conversation tasks are W3a's (ConversationSink.failed); Apply reports through its
 * application (needs_check) or as "could not start".
 */
export function noticeTaskFailed(core: EngineCore, conn: Conn, task: Task, error: string): void {
  if ((CONVERSATION_TASK_KINDS as readonly string[]).includes(task.kind) || task.botName === "lead" || task.botName === "apply") return;
  const input = (task.input ?? {}) as Record<string, unknown>;
  const job = jobLabel(conn, taskJobId(conn, task)) ?? "a job";
  let text: string;
  switch (taskKey(task.botName, task.kind)) {
    case "research.scan": {
      const label = sourceLabel(String(input.source ?? "source"));
      const others = task.runId !== null && listTasks(conn, { runId: task.runId }).some((t) => t.id !== task.id && t.botName === "research" && t.kind === "scan");
      // UC-03 b: a failed self-check, or PM3 S8's scan checker reporting a broken adapter.
      const broken = /^(self-check failed|adapter broken): /.test(error);
      text = `${label} ${broken ? `adapter broken: ${error.replace(/^(self-check failed|adapter broken): /, "")}` : `scan failed: ${error}`}.${others ? " The other sources go on." : ""}`;
      break;
    }
    case "research.single":
      text = `Research could not read the job at ${String(input.url ?? "the link")}: ${error}.`;
      break;
    case "research.file":
      text = `Research could not read the uploaded JD: ${error}.`;
      break;
    case "research.fit":
      text = `Research could not score ${job}: ${error}. That job is left out.`;
      break;
    case "research.company": {
      const id = taskJobId(conn, task);
      const j = id === null ? undefined : getJob(conn, id);
      const company = typeof input.name === "string" ? input.name : "the company";
      text = `Research could not profile ${company}${j ? ` for ${j.title}` : ""}: ${error}. That job's branch stopped.`;
      break;
    }
    case "cv.tailor":
      text = `CV could not tailor the ${LANG(input)} CV for ${job}: ${error}.`;
      break;
    case "qa.review":
      text = `QA could not review the ${LANG(task.input)} CV for ${job}: ${error}.`;
      break;
    default:
      text = `${botLabel(task.botName)} could not finish its ${task.kind} task: ${error}.`;
  }
  postNotice(core, conn, { text, runId: task.runId });
}

/** Apply was stopped before it spawned (a denied or expired token, an engine error): the card waits. */
export function noticeApplyNotStarted(core: EngineCore, conn: Conn, task: Task, detail: string): void {
  const job = jobLabel(conn, taskJobId(conn, task)) ?? "this application";
  postNotice(core, conn, { text: `Apply could not start for ${job}: ${detail}. Approve the card again to try once more, or skip it.`, runId: task.runId });
}

// ---------------------------------------------------------------- needs_check

/** An application that needs Ba's check (UC-11 c, UC-18), or a finished dry run (§12). */
export function noticeNeedsCheck(
  core: EngineCore,
  conn: Conn,
  applicationId: number,
  reason: string,
  opts: { runId?: number | null; dryRun?: "finished" | "reported_submitted" } = {},
): void {
  const app = getApplication(conn, applicationId);
  if (!app) return;
  const job = jobLabel(conn, app.jobId) ?? `application ${app.id}`;
  const text = !app.dryRun
    ? `${job} needs a check: ${reason}. Open Applications, check the form in your Chrome, then mark it submitted or failed.`
    : opts.dryRun === "finished"
      ? `Dry run finished for ${job}: the form was filled and nothing was submitted. Check the screenshots in Applications.`
      : opts.dryRun === "reported_submitted"
        ? `Dry run for ${job} reported that it submitted, which a dry run must never do: it may really have been sent. Check with the employer and in Applications.`
        : `Dry run for ${job} needs a check: ${reason}. Check the form in your Chrome; nothing should have been submitted.`;
  postNotice(core, conn, { text, runId: opts.runId ?? null });
}

// ---------------------------------------------------------------- usage limits (UC-16)

export function formatClock(core: EngineCore, iso: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: core.config.displayTimeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

export function noticeEnginePaused(core: EngineCore, conn: Conn, engine: Engine, until: string): void {
  const label = ENGINE_LABEL[engine];
  postNotice(core, conn, { text: `⏸ ${label} usage limit reached. Tasks on ${label} wait until ${formatClock(core, until)} and then continue by themselves.` });
}

export function noticeEngineResumed(core: EngineCore, conn: Conn, engine: Engine, opts: { manual?: boolean } = {}): void {
  const text = opts.manual
    ? `▶️ ${ENGINE_LABEL[engine]} resumed by you (Resume now). Waiting tasks are back in the queue; if the limit is still reached, it pauses again.`
    : `✅ ${ENGINE_LABEL[engine]} usage limit has reset: resumed automatically. No action needed.`;
  postNotice(core, conn, { text });
}
