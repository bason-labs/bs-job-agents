// Creating a workflow task: resolve the step's templates, build and validate the input, record
// which locks it needs, and hold it at once when its engine is paused for a usage limit (UC-16).
import { taskKey, type TaskRef } from "@bs-job-agents/shared";
import { createStep, createTask, getStepByKey, holdEngineTasks, isEnginePaused, type Conn, type Step, type Task } from "../db/index.js";
import { sourceAccess } from "./access.js";
import { effectiveBot, taskNeeds } from "./bots.js";
import { templateScope, type RunCtx, type Scope } from "./context.js";
import type { EngineCore } from "./core.js";
import { buildTaskInput, type InputRequest } from "./inputs.js";
import { resolveTemplate } from "./templates.js";

/** The step row for `key` in `scope`, created `pending` (no event yet) when missing. */
export function ensureStepRow(conn: Conn, ctx: RunCtx, key: string, scope: Scope): Step {
  return getStepByKey(conn, ctx.run.id, key, scope.branchKey) ?? createStep(conn, { runId: ctx.run.id, stepKey: key, branchKey: scope.branchKey, status: "pending" });
}

export type TaskExtras = Pick<InputRequest, "item" | "gate" | "checker" | "derive" | "review" | "prebuilt">;

export function createWorkflowTask(
  core: EngineCore,
  conn: Conn,
  ctx: RunCtx,
  stepRow: Step,
  ref: TaskRef,
  scope: Scope,
  extras: TaskExtras = {},
): { task: Task; jobId?: number } {
  const now = core.now();
  const bot = effectiveBot(conn, core.deps.bots, ref.bot);
  const resolved = (resolveTemplate(ref.input, templateScope(conn, ctx, { ...scope, item: scope.item })) ?? {}) as Record<string, unknown>;
  const built = buildTaskInput({ conn, ctx, now, botName: ref.bot, kind: ref.kind, resolved, scope, ...extras });
  // W5, API research (AD-5): a scan whose source is read through a feed or an API is fetched by the
  // orchestrator (api-tasks.ts): no Chrome, no Figma. It keeps the bot's engine only because the
  // column needs one; it never uses an engine session.
  const source = (built.input as { source?: unknown } | null)?.source;
  const api = taskKey(ref.bot, ref.kind) === "research.scan" && typeof source === "string" && sourceAccess(conn, core.deps.boards, source).path !== "browser";
  const task = createTask(
    conn,
    {
      runId: ctx.run.id,
      stepId: stepRow.id,
      botName: ref.bot,
      kind: ref.kind,
      engine: bot.def.engine,
      input: built.input,
      promptVersion: bot.def.promptVersion,
      ...(api ? { usesBrowser: false, usesFigma: false } : taskNeeds(bot.def, ref.kind)),
    },
    { now },
  );
  if (!api && isEnginePaused(conn, task.engine, { now })) holdEngineTasks(conn, task.engine);
  return { task, jobId: built.jobId };
}
