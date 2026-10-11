// The mock orchestrator: an in-memory WebApi + EventFeed seeded from the shared fixtures. It
// answers like the orchestrator (shared shapes, the engine's validation rules and error codes)
// and plays the bots' side with timers (sim.ts), so every screen works without the real one:
// e2e tests, and `pnpm dev` when the orchestrator is not running.
import {
  ALLOWED_UPLOAD_TYPES,
  NEGOTIABLE_TEXT,
  RequestChangesRequestSchema,
  SkipDecisionSchema,
  checkUploadFile,
  isApplyBlockedByInjection,
  normalizeAnswerKey,
  type AnswerQuestionResponse,
  type AppEvent,
  type BotActivity,
  type ChoiceRequest,
  type Message,
  type MessageAuthor,
  type MessageCard,
  type ReviewCard,
  type Room,
  type RunControlResponse,
  type StepDetail,
  type StepStatus,
  type Task,
  type Upload,
} from "@bs-job-agents/shared";
import type {
  AnswerInput,
  ApproveInput,
  ApproveResult,
  EventFeed,
  EventListener,
  FeedStatus,
  HealthState,
  MessagesPage,
  RunsQuery,
  SendMessageInput,
  TranscriptLine,
  WebApi,
} from "../contract";
import { ApiRequestError } from "../errors";
import { toBotSummary, toRoomSummary, toShellData } from "../map";
import type { BotSummary, RoomSummary, ShellData } from "../types";
import { LEAD_ROOM_ID, createSeedState } from "./seed";
import * as sim from "./sim";
import type { MockState, RunState, StepRow } from "./state";

/** One shared AppEvent without the id and time the feed stamps on it. */
export type AppEventInput = AppEvent extends infer E ? (E extends AppEvent ? Omit<E, "id" | "at"> : never) : never;

export interface MockOptions {
  /** Waits `ms` (already divided by speed). Real timers by default; tests pass an instant one. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** 2 = twice as fast. */
  speed?: number;
  state?: MockState;
}

export type SimulationKind =
  | "scheduled-scan"
  | "claude-limit"
  | "codex-limit"
  | "limits-reset"
  | "chrome-toggle"
  | "login-expired"
  | "captcha"
  | "figma"
  | "domain-confirm";

const TERMINAL: readonly StepStatus[] = ["done", "failed", "skipped", "cancelled"];
const IDLE: readonly StepStatus[] = ["pending", "locked"];

const fail = (status: number, code: ApiRequestError["code"], message: string, details?: unknown) =>
  new ApiRequestError({ status, code, message, details });

export class MockBackend implements WebApi, EventFeed {
  readonly mode = "mock" as const;
  readonly events: EventFeed = this;
  state: MockState;
  private readonly listeners = new Set<EventListener>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly nowFn: () => number;
  private readonly speed: number;
  private eventSeq = 1000;
  private readonly activeTasks = new Map<string, number>();

  constructor(opts: MockOptions = {}) {
    this.state = opts.state ?? createSeedState();
    this.sleepFn = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.nowFn = opts.now ?? (() => Date.now());
    this.speed = opts.speed && opts.speed > 0 ? opts.speed : 1;
  }

  // ------------------------------------------------------------ EventFeed

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  getStatus(): FeedStatus {
    return "open";
  }
  onStatus(): () => void {
    return () => {};
  }

  // ------------------------------------------------------------ helpers for sim.ts

  nowIso(): string {
    return new Date(this.nowFn()).toISOString();
  }
  nowMs(): number {
    return this.nowFn();
  }
  nextId(): string {
    return String(++this.state.seq);
  }
  wait(ms: number): Promise<void> {
    return this.sleepFn(ms / this.speed);
  }

  emit(input: AppEventInput): AppEvent {
    const event = { ...input, id: String(++this.eventSeq), at: this.nowIso() } as AppEvent;
    for (const fn of [...this.listeners]) {
      try {
        fn(structuredClone(event));
      } catch (error) {
        console.error("mock event listener failed", error);
      }
    }
    return event;
  }

  /** Runs a simulation in the background; idle() waits for all of them (tests). */
  background(work: Promise<unknown>): void {
    const p = work.catch((err: unknown) => {
      if (!(err instanceof sim.RunCancelled)) console.error("mock simulation failed", err);
    });
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  async idle(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  room(roomId: string): Room {
    const room = this.state.rooms.find((r) => r.id === roomId);
    if (!room) throw fail(404, "not_found", `room ${roomId} not found`);
    return room;
  }

  /** Appends a message (optionally streamed with message.delta first) and emits message.created. */
  async post(
    roomId: string,
    author: MessageAuthor,
    text: string,
    o: { cards?: MessageCard[]; runIds?: string[]; uploadIds?: string[]; mentions?: string[]; stream?: boolean } = {},
  ): Promise<Message> {
    const room = this.room(roomId);
    const id = this.nextId();
    if (o.stream) {
      const words = text.split(/(?<= )/);
      const chunk = Math.max(1, Math.ceil(words.length / 4));
      for (let i = 0; i < words.length; i += chunk) {
        this.emit({ type: "message.delta", roomId, messageId: id, delta: words.slice(i, i + chunk).join("") });
        await this.wait(70);
      }
    }
    const message: Message = {
      id,
      roomId,
      author,
      text,
      mode: room.kind === "lead" ? "work" : room.kind === "direct" ? "consult" : "discussion",
      mentions: o.mentions ?? [],
      runIds: o.runIds ?? [],
      uploadIds: o.uploadIds ?? [],
      cards: o.cards ?? [],
      createdAt: this.nowIso(),
    };
    (this.state.messages[roomId] ??= []).push(message);
    this.emit({ type: "message.created", roomId, message });
    return message;
  }

  runState(runId: string): RunState {
    const r = this.state.runs[runId];
    if (!r) throw fail(404, "not_found", `run ${runId} not found`);
    return r;
  }

  findStep(runId: string, stepKey: string, branchKey: string | null): StepRow | undefined {
    return this.runState(runId).steps.find((s) => s.stepKey === stepKey && s.branchKey === branchKey);
  }

  /** Like the engine's setStep: persist, then step.started / step.updated / step.finished. */
  setStep(
    runId: string,
    stepKey: string,
    branchKey: string | null,
    status: StepStatus,
    change: { preview?: string | null; output?: unknown; round?: number | null; error?: string | null; counts?: { total: number; queued: number; running: number; done: number; failed: number } | null } = {},
  ): StepRow {
    const r = this.runState(runId);
    let row = this.findStep(runId, stepKey, branchKey);
    if (!row) {
      row = { id: this.nextId(), runId, stepKey, branchKey, status: "pending", round: null, output: null, error: null, startedAt: null, finishedAt: null, preview: null };
      r.steps.push(row);
    }
    const before = row.status;
    row.status = status;
    if (change.output !== undefined) row.output = change.output;
    if (change.round !== undefined) row.round = change.round;
    if (change.error !== undefined) row.error = change.error;
    if (change.preview !== undefined) row.preview = change.preview;
    if (IDLE.includes(before) && !IDLE.includes(status)) {
      row.startedAt = this.nowIso();
      row.finishedAt = null;
    }
    if (TERMINAL.includes(status)) row.finishedAt = this.nowIso();
    const ref = { runId, stepId: row.id, stepKey, branchKey };
    if (IDLE.includes(before) && !IDLE.includes(status)) this.emit({ type: "step.started", ...ref, round: row.round });
    if (TERMINAL.includes(status)) {
      this.emit({ type: "step.finished", ...ref, status: status as "done" | "failed" | "skipped" | "cancelled", preview: change.preview ?? null, error: row.error });
    } else {
      this.emit({ type: "step.updated", ...ref, status, round: row.round, preview: change.preview ?? null, counts: change.counts ?? null });
    }
    return row;
  }

  setBotActivity(name: string, activity: BotActivity): void {
    const bot = this.state.bots.find((b) => b.name === name);
    if (!bot || bot.activity === activity) return;
    bot.activity = activity;
    this.emit({
      type: "bot.updated",
      botName: bot.name,
      engine: bot.engine,
      trustLevel: bot.trustLevel,
      enabled: bot.enabled,
      activity,
      promotionSuggested: bot.promotionSuggested,
    });
  }

  /** Creates a running task (task.started; the bot shows "working"). */
  startTask(runId: string | null, stepId: string | null, botName: string, kind: string, input: unknown = {}): Task {
    const bot = this.state.bots.find((b) => b.name === botName);
    const task: Task = {
      id: this.nextId(),
      runId,
      stepId,
      botName,
      kind,
      input,
      output: null,
      status: "running",
      pauseReason: null,
      attempt: 1,
      engine: bot?.engine ?? "claude",
      promptVersion: bot?.promptVersion ?? 1,
      transcriptPath: null,
      error: null,
      startedAt: this.nowIso(),
      finishedAt: null,
    };
    task.transcriptPath = `data/transcripts/${task.id}.jsonl`;
    if (runId) this.runState(runId).tasks.push(task);
    this.state.transcripts[task.id] = [];
    this.emit({ type: "task.started", taskId: task.id, runId, stepId, botName, kind, engine: task.engine, attempt: 1 });
    this.activeTasks.set(botName, (this.activeTasks.get(botName) ?? 0) + 1);
    this.setBotActivity(botName, "working");
    return task;
  }

  progress(task: Task, kind: TranscriptLine["kind"], text: string, tool: string | null = null): void {
    const line: TranscriptLine = { at: this.nowIso(), kind, text, tool };
    (this.state.transcripts[task.id] ??= []).push(line);
    this.emit({ type: "task.progress", taskId: task.id, runId: task.runId, stepId: task.stepId, botName: task.botName, kind, text, tool });
  }

  finishTask(task: Task, status: "done" | "failed" | "interrupted", output: unknown = null, error: string | null = null): void {
    task.status = status;
    task.output = output;
    task.error = error;
    task.finishedAt = this.nowIso();
    this.emit({ type: "task.finished", taskId: task.id, runId: task.runId, stepId: task.stepId, botName: task.botName, status, attempt: task.attempt, error });
    const left = Math.max(0, (this.activeTasks.get(task.botName) ?? 1) - 1);
    this.activeTasks.set(task.botName, left);
    if (left === 0) this.setBotActivity(task.botName, "idle");
  }

  card(jobId: string): ReviewCard {
    const card = this.state.queue.find((c) => c.job.id === jobId);
    if (!card) throw fail(404, "not_found", `review card for job ${jobId} not found`);
    return card;
  }

  // ------------------------------------------------------------ WebApi: shell

  async getHealth(): Promise<HealthState> {
    return { ok: true, reason: null, detail: null };
  }

  async getShellData(): Promise<ShellData> {
    const s = this.state;
    return toShellData({
      bots: s.bots,
      rooms: s.rooms,
      engines: s.engines,
      reviewCount: s.queue.length,
      runs: Object.values(s.runs).map((r) => r.run),
      chromeConnected: s.chromeConnected,
    });
  }

  async getBot(name: string): Promise<BotSummary | null> {
    const bot = this.state.bots.find((b) => b.name === name);
    return bot ? toBotSummary(bot) : null;
  }

  async getRoom(id: string): Promise<RoomSummary | null> {
    const room = this.state.rooms.find((r) => r.id === id);
    return room ? toRoomSummary(room) : null;
  }

  async listBots() {
    return structuredClone(this.state.bots);
  }

  async listEngines() {
    return structuredClone(this.state.engines);
  }

  // ------------------------------------------------------------ WebApi: chat

  async listRooms() {
    return structuredClone(this.state.rooms);
  }

  async listMessages(roomId: string, o: { before?: string; limit?: number } = {}): Promise<MessagesPage> {
    this.room(roomId);
    const all = [...(this.state.messages[roomId] ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || Number(a.id) - Number(b.id));
    const end = o.before ? all.findIndex((m) => m.id === o.before) : all.length;
    const upTo = end === -1 ? all.length : end;
    const limit = o.limit ?? 50;
    const start = Math.max(0, upTo - limit);
    return { messages: structuredClone(all.slice(start, upTo)), hasMore: start > 0 };
  }

  async sendMessage(input: SendMessageInput): Promise<Message> {
    const room = this.room(input.roomId);
    const text = input.text.trim();
    const uploadIds = input.uploadIds ?? [];
    if (!text && uploadIds.length === 0) throw fail(400, "validation_failed", "type a message or attach a file");
    for (const id of uploadIds) {
      if (!this.state.uploads[id]) throw fail(400, "validation_failed", `upload ${id} not found`);
    }
    const mentions = room.kind === "group" ? sim.mentionsIn(text, this.state.bots.map((b) => b.name)) : [];
    const message = await this.post(room.id, { type: "ba" }, text, { uploadIds, mentions });
    for (const id of uploadIds) this.state.uploads[id]!.messageId = message.id;
    this.background(sim.replyTo(this, room, message));
    return structuredClone(message);
  }

  async uploadFiles(files: File[]) {
    const uploads: Upload[] = [];
    const rejected: { filename: string; reason: string }[] = [];
    for (const file of files) {
      const mime = file.type || mimeFromName(file.name);
      const problem = checkUploadFile({ filename: file.name, mime, size: file.size });
      if (problem || !(mime in ALLOWED_UPLOAD_TYPES)) {
        rejected.push({ filename: file.name, reason: problem ?? `${file.name}: only PDF, DOC/DOCX, TXT, PNG or JPG files can be attached` });
        continue;
      }
      const id = this.nextId();
      const upload: Upload = {
        id,
        filename: file.name,
        mime: mime as Upload["mime"],
        size: file.size,
        path: `data/uploads/${id}/${file.name}`,
        sha256: (id.padStart(8, "0") + "0".repeat(64)).slice(0, 64),
        uploadedAt: this.nowIso(),
        messageId: null,
      };
      this.state.uploads[id] = upload;
      this.state.fileUrls[id] = typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : `/dev/${file.name}`;
      uploads.push(upload);
    }
    return { uploads: structuredClone(uploads), rejected };
  }

  async answerQuestion(taskId: string, input: AnswerInput): Promise<AnswerQuestionResponse> {
    const pause = this.state.pauses[taskId];
    if (!pause || pause.reason.code !== "needs_answer") throw fail(409, "conflict", `task ${taskId} is not waiting for an answer`);
    const q = pause.questions[0];
    if (!q || q.field !== input.field) throw fail(400, "validation_failed", `task ${taskId} has no open question "${input.field}"`);
    const vi = this.state.queue.concat(this.acted).find((c) => c.job.id === pause.jobId)?.job.language === "vi";
    let value: string | null;
    switch (input.mode) {
      case "skip":
        if (q.required) throw fail(400, "validation_failed", `${q.label} is required; it cannot be left blank`);
        value = null;
        break;
      case "negotiable":
        if (q.kind !== "salary") throw fail(400, "validation_failed", `${q.label} is not a salary question`);
        value = NEGOTIABLE_TEXT[vi ? "vi" : "en"];
        break;
      default: {
        value = input.value?.trim() ?? "";
        if (!value) throw fail(400, "validation_failed", "type an answer");
        if (q.options?.length) {
          const opt = q.options.find((o) => o.trim().toLowerCase() === value!.toLowerCase());
          if (!opt) throw fail(400, "validation_failed", `${q.label}: choose one of ${q.options.join(", ")}`);
          value = opt;
        }
      }
    }
    if (input.remember && value !== null && normalizeAnswerKey(q.label)) {
      const key = normalizeAnswerKey(q.label);
      this.state.savedAnswers = [...this.state.savedAnswers.filter((a) => a.key !== key), { key, label: q.label, answer: value }];
    }
    // The card is answered from now on (a reload shows it inert).
    for (const m of this.state.messages[LEAD_ROOM_ID] ?? []) {
      for (const c of m.cards) if (c.type === "question" && c.taskId === taskId && c.question.field === q.field) c.answered = true;
    }
    pause.questions.shift();
    const next = pause.questions[0] ?? null;
    this.background(sim.afterAnswer(this, pause));
    return { resumed: next === null, next: next ? structuredClone(next) : null };
  }

  async resumeTask(taskId: string, input: { confirmDomain: string | null } = { confirmDomain: null }): Promise<void> {
    const pause = this.state.pauses[taskId];
    if (!pause) throw fail(409, "conflict", `task ${taskId} is not paused`);
    switch (pause.reason.code) {
      case "needs_login":
      case "captcha":
        break;
      case "domain_confirm": {
        const site = (input.confirmDomain ?? "").trim().toLowerCase();
        if (!site || site !== pause.reason.site) throw fail(400, "validation_failed", `confirm the domain ${pause.reason.site ?? "(unknown)"} to continue`);
        break;
      }
      case "needs_answer":
        throw fail(409, "conflict", "answer Apply's questions to continue (UC-12)");
      default:
        throw fail(409, "conflict", `task ${taskId} resumes by itself (${pause.reason.code})`);
    }
    delete this.state.pauses[taskId];
    this.background(sim.afterResume(this, pause));
  }

  async chooseOption(input: ChoiceRequest): Promise<void> {
    const message = Object.values(this.state.messages)
      .flat()
      .find((m) => m.id === input.messageId);
    const card = message?.cards.find((c): c is Extract<MessageCard, { type: "choice" }> => c.type === "choice" && c.key === input.key);
    if (!message || !card) throw fail(404, "not_found", `choice ${input.key} on message ${input.messageId} not found`);
    const option = card.options.find((o) => o.id === input.optionId);
    if (!option) throw fail(400, "validation_failed", `unknown option ${input.optionId}`);
    if (card.chosen) throw fail(409, "conflict", "already chosen");
    card.chosen = option.id;
    this.background(sim.afterChoice(this, message.roomId, input.key, option.id));
  }

  // ------------------------------------------------------------ WebApi: runs

  async listRuns(query: RunsQuery = {}) {
    const runs = Object.values(this.state.runs)
      .map((r) => r.run)
      .filter((r) => !query.status || r.status === query.status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return structuredClone(runs.slice(0, query.limit ?? 50));
  }

  async getRun(runId: string) {
    const r = this.runState(runId);
    return structuredClone({ run: r.run, steps: r.steps, tasks: r.tasks });
  }

  async getStep(stepId: string): Promise<StepDetail> {
    const r = Object.values(this.state.runs).find((x) => x.steps.some((s) => s.id === stepId));
    const step = r?.steps.find((s) => s.id === stepId);
    if (!r || !step) throw fail(404, "not_found", `step ${stepId} not found`);
    const tasks = r.tasks.filter((t) => t.stepId === stepId);
    const last = tasks.at(-1)?.output as { selfCheck?: StepDetail["selfCheck"] } | null | undefined;
    const { preview: _preview, ...row } = step;
    return structuredClone({
      step: row,
      tasks,
      selfCheck: last?.selfCheck ?? [],
      durationMs: step.startedAt && step.finishedAt ? Date.parse(step.finishedAt) - Date.parse(step.startedAt) : null,
    });
  }

  async controlRun(runId: string, action: "pause" | "resume" | "cancel"): Promise<RunControlResponse> {
    const r = this.runState(runId);
    const status = r.run.status;
    if (status === "done" || status === "failed" || status === "cancelled") throw fail(409, "conflict", `run ${runId} has finished`);
    let abortedTaskIds: string[] = [];
    if (action === "pause") {
      if (status !== "paused") {
        r.run.status = "paused";
        this.emit({ type: "run.updated", runId, status: "paused" });
      }
    } else if (action === "resume") {
      if (status === "paused") {
        r.run.status = sim.runIsWaitingOnlyForBa(r) ? "waiting" : "running";
        this.emit({ type: "run.updated", runId, status: r.run.status });
      }
    } else {
      abortedTaskIds = sim.cancelRun(this, r);
    }
    return structuredClone({ run: r.run, abortedTaskIds });
  }

  async rerunStep(stepId: string): Promise<void> {
    const r = Object.values(this.state.runs).find((x) => x.steps.some((s) => s.id === stepId));
    const step = r?.steps.find((s) => s.id === stepId);
    if (!r || !step) throw fail(404, "not_found", `step ${stepId} not found`);
    if (step.stepKey === "apply" || step.stepKey === "record") {
      throw fail(403, "forbidden", step.preview === "submitted" ? "A submitted apply step can never be re-run" : "Apply and the record are never re-run; approve the card again instead");
    }
    if (step.stepKey === "review") throw fail(409, "conflict", "The review step is your decision; use the review card");
    if (!["done", "failed", "skipped"].includes(step.status)) throw fail(409, "conflict", "Only a finished or failed step can be re-run");
    if (r.run.status === "cancelled") throw fail(409, "conflict", `run ${r.run.id} was cancelled`);
    this.background(sim.rerun(this, r, step));
  }

  async getTranscript(taskId: string): Promise<TranscriptLine[]> {
    return structuredClone(this.state.transcripts[taskId] ?? []);
  }

  // ------------------------------------------------------------ WebApi: review

  /** Cards Ba decided on while Apply or CV works (kept so answers can find their job). */
  acted: ReviewCard[] = [];

  async getReviewQueue() {
    return structuredClone(this.state.queue);
  }

  async approve(jobId: string, input: ApproveInput): Promise<ApproveResult> {
    const card = this.card(jobId);
    if (isApplyBlockedByInjection(card.job)) {
      throw fail(403, "forbidden", "This job is flagged for a possible prompt injection; confirm it before approving", { reason: "injection_flagged" });
    }
    const option = card.cvOptions.find((o) => o.cvVersion.id === input.cvVersionId);
    if (!option) throw fail(400, "validation_failed", `CV version ${input.cvVersionId} is not on this card`);
    return sim.approve(this, card, option, input);
  }

  async requestChanges(jobId: string, input: { comment: string }): Promise<void> {
    const parsed = RequestChangesRequestSchema.safeParse(input);
    if (!parsed.success) throw fail(400, "validation_failed", "Tell CV what to change");
    sim.requestChanges(this, this.card(jobId), parsed.data.comment);
  }

  async skip(jobId: string, input: { reason: string; note: string | null }): Promise<void> {
    const parsed = SkipDecisionSchema.safeParse(input);
    if (!parsed.success) throw fail(400, "validation_failed", parsed.error.issues[0]?.message ?? "pick a reason");
    sim.skip(this, this.card(jobId), parsed.data);
  }

  async confirmInjection(jobId: string): Promise<void> {
    const card = this.card(jobId);
    if (!card.job.injectionFlagged) throw fail(409, "conflict", "This job is not flagged");
    card.job.injectionClearedAt = this.nowIso();
    card.flags.injectionFlagged = false;
  }

  fileUrl(id: string): string {
    return this.state.fileUrls[id] ?? "/dev/sample-cv.pdf";
  }

  // ------------------------------------------------------------ mock only

  /** The "Simulate" menu (mock mode): events that would come from the engine or the bridges. */
  simulate(kind: SimulationKind): void {
    this.background(sim.simulate(this, kind));
  }
}

function mimeFromName(name: string): string {
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  for (const [mime, exts] of Object.entries(ALLOWED_UPLOAD_TYPES)) if ((exts as readonly string[]).includes(ext)) return mime;
  return "application/octet-stream";
}
