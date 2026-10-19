// The mock orchestrator: an in-memory WebApi + EventFeed seeded from the shared fixtures. It
// answers like the orchestrator (shared shapes, the engine's validation rules and error codes)
// and plays the bots' side with timers (sim.ts), so every screen works without the real one:
// e2e tests, and `pnpm dev` when the orchestrator is not running.
import {
  ALLOWED_UPLOAD_TYPES,
  FIND_ONLY_NOTE,
  FIND_ONLY_REASON,
  findOnlySourceOf,
  NEGOTIABLE_TEXT,
  RequestChangesRequestSchema,
  SkipDecisionSchema,
  checkUploadFile,
  isApplyBlockedByInjection,
  normalizeAnswerKey,
  type AnswerQuestionResponse,
  type AppEvent,
  type BotActivity,
  type ChatMessage,
  type ChoiceRequest,
  type Engine,
  type Message,
  type MessageAttachment,
  type MessageAuthor,
  type MessageCard,
  type ReviewCard,
  type Room,
  type RunControlResponse,
  type StepDetail,
  type StepStatus,
  type Task,
  type TranscriptLine,
  type Upload,
} from "@bs-job-agents/shared";
import type { z } from "zod";
import type {
  AnswerInput,
  ApiRequestOptions,
  HttpMethod,
  ApproveInput,
  ApproveResult,
  EventFeed,
  EventListener,
  FeedStatus,
  HealthState,
  MessagesPage,
  RunRow,
  RunsQuery,
  SendMessageInput,
  ProgressLine,
  WebApi,
} from "../contract";
import { ApiRequestError } from "../errors";
import { toBotSummary, toRoomSummary, toShellData } from "../map";
import type { BotSummary, RoomSummary, ShellData } from "../types";
import { toSavedLines } from "../transcript";
import { mockDeriveFacts } from "./derived-facts";
import { chooseProposal } from "./lead-proposals";
import { handleMockRequest } from "./routes";
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
  | "domain-confirm"
  /** Lead proposes a workflow (rule 3); e2e drives it through withMock. */
  | "workflow-proposal"
  /** CV's task changed a protected Figma page (PM2 S8): Lead asks whether it was Ba (figma-change:<taskId> choice). */
  | "figma-change";

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

  /**
   * Appends a message and emits message.created. Replies arrive whole, as on the orchestrator (PM3
   * S5: no token streaming; the chat shows the conversation task's tool steps instead).
   */
  async post(
    roomId: string,
    author: MessageAuthor,
    text: string,
    o: { cards?: MessageCard[]; runIds?: string[]; uploadIds?: string[]; mentions?: string[] } = {},
  ): Promise<ChatMessage> {
    const room = this.room(roomId);
    const id = this.nextId();
    const uploadIds = o.uploadIds ?? [];
    const message: ChatMessage = {
      id,
      roomId,
      author,
      text,
      mode: room.kind === "lead" ? "work" : room.kind === "direct" ? "consult" : "discussion",
      mentions: o.mentions ?? [],
      runIds: o.runIds ?? [],
      uploadIds,
      cards: o.cards ?? [],
      createdAt: this.nowIso(),
      // Like the orchestrator (F8): a message with uploads carries their name, mime, size and file id.
      ...(uploadIds.length ? { attachments: uploadIds.flatMap((u) => this.attachment(u)) } : {}),
    };
    (this.state.messages[roomId] ??= []).push(message);
    this.emit({ type: "message.created", roomId, message });
    return message;
  }

  /** An upload as a message attachment; GET /files/upload-<id> serves it. */
  private attachment(uploadId: string): MessageAttachment[] {
    const u = this.state.uploads[uploadId];
    if (!u) return [];
    return [{ id: u.id, filename: u.filename, mime: u.mime, size: u.size, file: { id: `upload-${u.id}`, kind: "upload", filename: u.filename, mime: u.mime } }];
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

  progress(task: Task, kind: ProgressLine["kind"], text: string, tool: string | null = null): void {
    const line: ProgressLine = { at: this.nowIso(), kind, text, tool };
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

  /** Like the orchestrator's POST /engines/:engine/resume ("Resume now"): not paused is a conflict. */
  async resumeEngine(engine: Engine): Promise<void> {
    const status = this.state.engines.find((e) => e.engine === engine);
    if (!status) throw fail(404, "not_found", `engine ${engine} not found`);
    if (!status.pausedUntil && !status.reason) throw fail(409, "conflict", `${engine} is not paused`);
    await sim.resumeEngineNow(this, engine);
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

  async sendMessage(input: SendMessageInput): Promise<ChatMessage> {
    const room = this.room(input.roomId);
    const text = input.text.trim();
    const uploadIds = input.uploadIds ?? [];
    if (!text && uploadIds.length === 0) throw fail(400, "validation_failed", "type a message or attach a file");
    for (const id of uploadIds) {
      if (!this.state.uploads[id]) throw fail(400, "validation_failed", `upload ${id} not found`);
    }
    const targets = room.kind === "group" ? sim.roomTargets(this, room, text) : { answering: [], notes: [] };
    const message = await this.post(room.id, { type: "ba" }, text, { uploadIds, mentions: targets.answering });
    for (const note of targets.notes) await this.post(room.id, { type: "system" }, note);
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
      // The orchestrator serves it as GET /files/upload-<id>; the bare id stays for older callers.
      this.state.fileUrls[`upload-${id}`] = this.state.fileUrls[id] = typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : `/dev/${file.name}`;
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
      this.state.savedAnswers = [...this.state.savedAnswers.filter((a) => a.key !== key), { key, label: q.label, answer: value, updatedAt: this.nowIso() }];
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

  async declineDomain(taskId: string): Promise<void> {
    const pause = this.state.pauses[taskId];
    if (!pause || pause.reason.code !== "domain_confirm") throw fail(409, "conflict", `task ${taskId} is not waiting for a domain to confirm`);
    delete this.state.pauses[taskId];
    this.background(sim.afterDecline(this, pause));
  }

  async chooseOption(input: ChoiceRequest): Promise<void> {
    await this.choose(input);
  }

  /** Like the orchestrator's POST /chat/choices: the card keeps the choice and its label is Ba's answer in the room. */
  async choose(input: ChoiceRequest): Promise<Message> {
    const message = Object.values(this.state.messages)
      .flat()
      .find((m) => m.id === input.messageId);
    const card = message?.cards.find((c): c is Extract<MessageCard, { type: "choice" }> => c.type === "choice" && c.key === input.key);
    if (!message || !card) throw fail(404, "not_found", `choice ${input.key} on message ${input.messageId} not found`);
    const option = card.options.find((o) => o.id === input.optionId);
    if (!option) throw fail(400, "validation_failed", `unknown option ${input.optionId}`);
    if (card.chosen) throw fail(409, "conflict", "already chosen");
    // PM3 M3 / S1: criteria-save:<id> and schedule-create:<id> act on the stored proposal.
    const proposal = await chooseProposal(this, message, card, option.id);
    if (proposal) return proposal;
    card.chosen = option.id;
    const answer = await this.post(message.roomId, { type: "ba" }, option.label);
    this.background(sim.afterChoice(this, message.roomId, input.key, option.id));
    return answer;
  }

  // ------------------------------------------------------------ WebApi: runs

  async listRuns(query: RunsQuery = {}) {
    const runs = Object.values(this.state.runs)
      .map((r): RunRow => ({ ...r.run, presetName: r.presetName ?? null }))
      .filter((r) => !query.status || r.status === query.status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return structuredClone(runs.slice(0, query.limit ?? 50));
  }

  async getRun(runId: string) {
    const r = this.runState(runId);
    return structuredClone({ run: r.run, steps: r.steps, tasks: r.tasks, presetName: r.presetName ?? null });
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
    return toSavedLines(this.state.transcripts[taskId] ?? []);
  }

  // ------------------------------------------------------------ WebApi: review

  /** Cards Ba decided on while Apply or CV works (kept so answers can find their job). */
  acted: ReviewCard[] = [];

  async getReviewQueue() {
    return structuredClone(this.state.queue);
  }

  async approve(jobId: string, input: ApproveInput): Promise<ApproveResult> {
    // W5: like the engine, a find-only job (Upwork) is never approved, not even as a dry run.
    const findOnly = findOnlySourceOf(this.card(jobId).job);
    if (findOnly) throw fail(409, "conflict", FIND_ONLY_NOTE, { reason: FIND_ONLY_REASON, source: findOnly });
    const card = this.card(jobId);
    if (isApplyBlockedByInjection(card.job)) {
      throw fail(403, "forbidden", "This job is flagged for a possible prompt injection; confirm it before approving", { reason: "injection_flagged" });
    }
    const option = card.cvOptions.find((o) => o.cvVersion.id === input.cvVersionId);
    if (!option) throw fail(400, "validation_failed", `CV version ${input.cvVersionId} is not on this card`);
    if (card.flags.dryRunSettled) {
      // PM2 S15 "Approve live" after a settled dry run (engine approveLiveAfterDryRun).
      if (input.dryRun) throw fail(409, "conflict", "this card's dry run has finished; approve it live, or skip it");
      const dry = sim.settledDryRun(this, card.job.id);
      if (dry?.blocking) {
        throw fail(409, "already_applied", "the dry run reported that it submitted, so it may really have been sent; check it on the Applications screen first");
      }
      if (dry && dry.app.cvVersionId !== input.cvVersionId) throw fail(400, "validation_failed", "a live approval after a dry run keeps the CV version the dry run used");
      card.flags = { ...card.flags, dryRunSettled: false };
    }
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

  /** CV auto-extend: a scan's derive step adds these drafts (screened) as one version; e2e drives it through withMock. */
  deriveFacts(drafts: Parameters<typeof mockDeriveFacts>[1], opts: Parameters<typeof mockDeriveFacts>[2] = {}): ReturnType<typeof mockDeriveFacts> {
    return mockDeriveFacts(this, drafts, opts);
  }

  fileUrl(id: string): string {
    return this.state.fileUrls[id] ?? "/dev/sample-cv.pdf";
  }

  // ------------------------------------------------------------ WebApi: any route

  /** Any API_ROUTES call (routes.ts), answered like the orchestrator and checked like http.ts. */
  async request<S extends z.ZodTypeAny = z.ZodTypeAny>(method: HttpMethod, route: string, opts: ApiRequestOptions<S> = {}): Promise<z.infer<S>> {
    const data = await handleMockRequest(this, method, route, opts);
    if (!opts.schema) return undefined as z.infer<S>;
    const parsed = opts.schema.safeParse(structuredClone(data));
    if (!parsed.success) {
      throw fail(200, "bad_response", `${method} ${route} answered a shape the UI does not understand.`, parsed.error.issues);
    }
    return parsed.data;
  }

  /** Mock answers carry URLs the browser opens as they are (data: ZIPs, /dev samples). */
  apiUrl(path: string): string {
    return path;
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
