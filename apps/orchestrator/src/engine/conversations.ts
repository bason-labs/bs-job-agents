// PM2 S2: the engine seams W3a builds the chat flows on (S20). W3a never creates conversation tasks
// with raw createTask:
// - enqueueConversation validates the strict prompt schema (ConversationInput for consult and
//   discussion, LeadChatInput for Lead's chat), queues on the bot's effective engine (the Bots
//   screen's switch) and holds the task while that engine is paused for a usage limit (UC-16);
// - the ConversationSink is called inside the transaction that settles a conversation task, so W3a
//   posts the reply, and queues Lead's chat for a UC-25 a handoff, atomically with the result. A sink
//   that throws rolls the result back with it (the task then fails as an engine error).
import {
  CONVERSATION_TASK_KINDS,
  promptInputSchemaFor,
  type ConsultOutput,
  type LeadOutput,
} from "@bs-job-agents/shared";
import { createTask, holdEngineTasks, isEnginePaused, type Conn, type Task } from "../db/index.js";
import { effectiveBot, taskNeeds } from "./bots.js";
import type { EngineCore } from "./core.js";
import { invalidInput, invalidState, notFound } from "./errors.js";

/** Lead's chat (`lead.chat`), a 1:1 consult thread (UC-25) or a room reply (UC-15). */
export type ConversationKind = "chat" | "consult" | "discussion";

export interface ConversationRequest {
  bot: string;
  kind: ConversationKind;
  /** LeadChatInput for Lead's chat, ConversationInput otherwise (strict: no unknown key). */
  input: unknown;
}

export type ConversationResult =
  | { kind: "chat"; output: LeadOutput }
  | { kind: "consult" | "discussion"; output: ConsultOutput };

export interface ConversationSinkContext {
  /** The settle transaction: write the reply and anything else with it. */
  conn: Conn;
  task: Task;
  /** Queue a follow-up conversation in this transaction (e.g. Lead's chat for a UC-25 a handoff); it starts after the commit. */
  enqueue(req: ConversationRequest): { taskId: number };
}

/** W3a's port: the engine calls it in the transaction that settles a conversation task. */
export interface ConversationSink {
  /** The task finished: its reply (and Lead's actions, or a consult's handoffToLead). */
  done(ctx: ConversationSinkContext, result: ConversationResult): void;
  /** The task failed for good (never for an attempt that is retried), e.g. to post an error reply. */
  failed(ctx: ConversationSinkContext, error: string): void;
}

export function isConversationTask(task: Pick<Task, "botName" | "kind">): boolean {
  return (CONVERSATION_TASK_KINDS as readonly string[]).includes(task.kind) || (task.botName === "lead" && task.kind === "chat");
}

/** Validate a request and create its task inside `conn`'s transaction (the caller dispatches after the commit). */
export function createConversationTask(core: EngineCore, conn: Conn, req: ConversationRequest): Task {
  if (!core.deps.bots.get(req.bot)) throw notFound("bot", req.bot);
  const conversation = (CONVERSATION_TASK_KINDS as readonly string[]).includes(req.kind);
  if (!conversation && !(req.bot === "lead" && req.kind === "chat")) {
    throw invalidInput(`${req.bot} has no ${req.kind} conversation: Lead has the chat, every bot has consult and discussion`);
  }
  const schema = promptInputSchemaFor(req.bot, req.kind);
  const parsed = schema?.safeParse(req.input);
  if (!schema || !parsed) throw invalidInput(`${req.bot}.${req.kind} has no prompt input schema`);
  if (!parsed.success) throw invalidInput(`${req.bot}.${req.kind} input is invalid`, parsed.error.issues);
  const bot = effectiveBot(conn, core.deps.bots, req.bot);
  if (!bot.enabled) throw invalidState(`${req.bot} is disabled on the Bots screen`, { reason: "bot_disabled" });
  const task = createTask(
    conn,
    {
      runId: null,
      stepId: null,
      botName: req.bot,
      kind: req.kind,
      engine: bot.def.engine,
      input: parsed.data,
      promptVersion: bot.def.promptVersion,
      ...taskNeeds(bot.def, req.kind),
    },
    { now: core.now() },
  );
  // UC-16: a conversation waits out its engine's usage limit like any task.
  if (isEnginePaused(conn, task.engine, { now: core.now() })) holdEngineTasks(conn, task.engine);
  return task;
}

export function sinkContext(core: EngineCore, conn: Conn, task: Task): ConversationSinkContext {
  return { conn, task, enqueue: (req) => ({ taskId: createConversationTask(core, conn, req).id }) };
}

/** Tell the sink a conversation failed for good, in a savepoint: a sink error never breaks the caller. */
export function sinkFailed(core: EngineCore, conn: Conn, task: Task, error: string): void {
  const sink = core.deps.conversations;
  if (!sink || !isConversationTask(task)) return;
  try {
    conn.transaction((sp) => sink.failed(sinkContext(core, sp, task), error));
  } catch (err) {
    core.log.warn(`the conversation sink failed for task ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
