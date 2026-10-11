// cv.fact_draft (owner request 2026-10-11): Ba answers CV's fact request, or tells something new,
// in his own words on the Master CV screen. The engine queues a CV task with no tools (no Figma, so
// no Figma lock), validates its FactDraftOutput like any task (runner), runs the invented-detail
// guard on it here, and hands the accepted facts to the API's FactDraftSink in the transaction that
// settles the task: the sink adds them to data/master-cv.yaml as a new version (Ba can undo).
import {
  CvFactDraftInputSchema,
  screenDraftedFacts,
  type CvFactDraftInput,
  type DraftedFact,
  type FactDraftOutput,
  type RejectedDraftFact,
} from "@bs-job-agents/shared";
import { createTask, holdEngineTasks, isEnginePaused, type Conn, type Task } from "../db/index.js";
import { effectiveBot, taskNeeds } from "./bots.js";
import type { EngineCore } from "./core.js";
import { invalidInput, invalidState } from "./errors.js";

export const FACT_DRAFT_BOT = "cv";
export const FACT_DRAFT_KIND = "fact_draft";

/** The audit row (never streamed) listing the drafted facts the invented-detail guard rejected. */
export const FACT_DRAFT_REJECTED_EVENT = "fact_draft.rejected";

export const isFactDraftTask = (task: Pick<Task, "botName" | "kind">): boolean => task.botName === FACT_DRAFT_BOT && task.kind === FACT_DRAFT_KIND;

/** What CV drafted, split by the invented-detail guard. */
export interface FactDraftResult {
  output: FactDraftOutput;
  /** Facts made only of Ba's words (ids still as CV chose them). */
  accepted: DraftedFact[];
  /** Facts with a number or name Ba did not give; never added. */
  rejected: RejectedDraftFact[];
}

export interface FactDraftSinkContext {
  /** The settle transaction. */
  conn: Conn;
  task: Task;
  now: Date;
}

/** The API's port: called in the transaction that settles a cv.fact_draft task. */
export interface FactDraftSink {
  done(ctx: FactDraftSinkContext, result: FactDraftResult): void;
  /** The task failed for good (never for an attempt that is retried). */
  failed(ctx: FactDraftSinkContext, error: string): void;
}

/** Validate the input (CV's strict prompt schema) and create the task inside `conn`'s transaction. */
export function createFactDraftTask(core: EngineCore, conn: Conn, input: CvFactDraftInput): Task {
  const parsed = CvFactDraftInputSchema.strict().safeParse(input);
  if (!parsed.success) throw invalidInput("cv.fact_draft input is invalid", parsed.error.issues);
  const bot = effectiveBot(conn, core.deps.bots, FACT_DRAFT_BOT);
  if (!bot.enabled) throw invalidState("CV is disabled on the Bots screen", { reason: "bot_disabled" });
  const task = createTask(
    conn,
    {
      runId: null,
      stepId: null,
      botName: FACT_DRAFT_BOT,
      kind: FACT_DRAFT_KIND,
      engine: bot.def.engine,
      input: parsed.data,
      promptVersion: bot.def.promptVersion,
      // Never the Figma lock or the browser: the task has no tools.
      ...taskNeeds(bot.def, FACT_DRAFT_KIND),
    },
    { now: core.now() },
  );
  // UC-16: it waits out its engine's usage limit like any task.
  if (isEnginePaused(conn, task.engine, { now: core.now() })) holdEngineTasks(conn, task.engine);
  return task;
}

/** The invented-detail guard over CV's output (owner request 2026-10-11). */
export function screenFactDraft(task: Pick<Task, "input">, output: FactDraftOutput): FactDraftResult {
  const input = task.input as CvFactDraftInput;
  const { accepted, rejected } = screenDraftedFacts(output.facts, { text: input.text, question: input.question, existingFacts: input.existingFacts });
  return { output, accepted, rejected };
}

/** A settled cv.fact_draft: screen it, then the sink adds the facts (inside the settle transaction). */
export function onFactDraftDone(core: EngineCore, tx: Conn, task: Task, output: FactDraftOutput): void {
  const result = screenFactDraft(task, output);
  if (result.rejected.length > 0) {
    core.bus.audit(tx, FACT_DRAFT_REJECTED_EVENT, { rejected: result.rejected }, { runId: null, taskId: task.id });
  }
  core.deps.factDrafts?.done({ conn: tx, task, now: core.now() }, result);
}

/** Tell the sink a fact draft failed for good, in a savepoint: a sink error never breaks the caller. */
export function factDraftFailed(core: EngineCore, conn: Conn, task: Task, error: string): void {
  const sink = core.deps.factDrafts;
  if (!sink || !isFactDraftTask(task)) return;
  try {
    conn.transaction((sp) => sink.failed({ conn: sp, task, now: core.now() }, error));
  } catch (err) {
    core.log.warn(`the fact draft sink failed for task ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
