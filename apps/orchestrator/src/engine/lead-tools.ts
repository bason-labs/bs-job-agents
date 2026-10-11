// Lead's tools, engine side (§3 rules 1 and 5, §5.2 Lead): what the orchestrator MCP server
// (W3a) exposes as create_task, start_workflow, get_status and get_result. Lead only divides
// work: it can start workflows and create research tasks, never an outward-facing action, and
// only from the Lead chat. A consult-mode or room bot that tries is refused with a safety event
// (UC-15, UC-25: "the trust guard rejects any attempt").
import {
  BOT_TASK_INPUT_SCHEMAS,
  BotNameSchema,
  StartWorkflowInputSchema,
  WORKFLOW_NAMES,
  isOutwardFacingTask,
  taskKey,
  type BotTaskKey,
  type ChatMode,
  type Engine,
  type StartWorkflowInput,
} from "@bs-job-agents/shared";
import { z } from "zod";
import {
  createTask,
  findJobByUrl,
  getApplicationByJob,
  getRun,
  getTask,
  getWorkflowPreset,
  holdEngineTasks,
  isEnginePaused,
  listActiveRuns,
  listEngineStates,
  listSteps,
  listTasks,
  listWorkflowPresets,
  mappers,
  type Run,
} from "../db/index.js";
import { effectiveBot, taskNeeds } from "./bots.js";
import type { EngineCore } from "./core.js";
import { forbidden, invalidInput, notFound } from "./errors.js";
import { emitSafetyDenied } from "./task-events.js";

/** Who calls a tool: the bot whose CLI session holds it, and the chat mode it runs in. */
export interface LeadCaller {
  botName: string;
  mode: ChatMode;
}

/** Standalone tasks Lead may create (§5.2: Research answers questions; everything else runs in a workflow). */
export const LEAD_TASK_KEYS = ["research.scan", "research.single", "research.file", "research.fit", "research.company"] as const;

const CreateTaskToolInputSchema = z.object({ bot: BotNameSchema, kind: z.string().min(1), input: z.unknown() }).strict();

function assertLead(core: EngineCore, caller: LeadCaller, action: string): void {
  if (caller.botName === "lead" && caller.mode === "work") return;
  emitSafetyDenied(core, core.db, {
    botName: BotNameSchema.safeParse(caller.botName).success ? caller.botName : "lead",
    taskId: null,
    action,
    reason: "consult_mode",
    detail: `${caller.botName} (${caller.mode}) cannot ${action}; work requests are handed to Lead (rule 1)`,
  });
  core.bus.flush();
  throw forbidden(`only Lead, in the Lead chat, can ${action} (rule 1, UC-25)`);
}

export type StartWorkflowFn = (input: StartWorkflowInput, opts: { trigger: Run["trigger"]; presetName?: string | null }) => Run;

const isShippedName = (name: unknown): boolean => typeof name === "string" && (WORKFLOW_NAMES as readonly string[]).includes(name);

/** get_status: the saved presets Lead may start by name (PM3 S4, rule 3). */
export interface PresetSummary {
  name: string;
  description: string;
  basedOn: string;
  params: Record<string, unknown>;
}

/**
 * Lead has no tool that answers Apply's questions or resumes Apply: an answer reaches a waiting
 * Apply only from Ba, through the question card (Engine.answerQuestion via the API), so a form
 * value is never something Lead made up (UC-12, PM FYI c).
 */
export class LeadTools {
  constructor(
    private readonly core: EngineCore,
    private readonly startWorkflowFn: StartWorkflowFn,
  ) {}

  /** create_task: a standalone Research task (runs outside a workflow, under the same caps). */
  createTask(caller: LeadCaller, raw: unknown): { taskId: number } {
    const core = this.core;
    assertLead(core, caller, "create_task");
    const parsed = CreateTaskToolInputSchema.safeParse(raw);
    if (!parsed.success) throw invalidInput("create_task needs { bot, kind, input }", parsed.error.issues);
    const { bot: botName, kind } = parsed.data;
    const key = taskKey(botName, kind);
    if (isOutwardFacingTask(botName, kind)) {
      // Rule 5: Lead only divides work; outward-facing tasks start only from an approved review card.
      emitSafetyDenied(core, core.db, {
        botName: "lead",
        taskId: null,
        action: `create_task ${key}`,
        reason: "trust_level",
        detail: "Lead only divides work; an outward-facing task runs only after Ba approves its review card",
      });
      core.bus.flush();
      throw forbidden(`Lead cannot create ${key}: it is outward-facing (§3 rule 5, §10.2 rule 1)`);
    }
    if (botName === "lead") throw invalidInput("Lead cannot assign work to itself");
    if (!(LEAD_TASK_KEYS as readonly string[]).includes(key)) {
      throw invalidInput(`Lead can create ${LEAD_TASK_KEYS.join(", ")}; other work runs in a workflow (rule 3)`);
    }
    if (!core.deps.bots.get(botName)) throw notFound("bot", botName);
    const input = BOT_TASK_INPUT_SCHEMAS[key as BotTaskKey].safeParse(parsed.data.input);
    if (!input.success) throw invalidInput(`${key} input is invalid`, input.error.issues);
    const task = core.db.transaction((tx) => {
      const bot = effectiveBot(tx, core.deps.bots, botName);
      const created = createTask(
        tx,
        {
          runId: null,
          stepId: null,
          botName,
          kind,
          engine: bot.def.engine,
          input: input.data,
          promptVersion: bot.def.promptVersion,
          ...taskNeeds(bot.def, kind),
        },
        { now: core.now() },
      );
      if (isEnginePaused(tx, created.engine, { now: core.now() })) holdEngineTasks(tx, created.engine);
      return created;
    });
    core.dispatch();
    return { taskId: task.id };
  }

  /** start_workflow (UC-01, UC-14, UC-24): refuses an already-applied link unless "apply again". */
  startWorkflow(
    caller: LeadCaller,
    raw: unknown,
  ): { started: true; runId: number } | { started: false; reason: "already_applied"; applicationId: number } {
    assertLead(this.core, caller, "start_workflow");
    // PM3 S4: a saved preset's name starts its base workflow with the stored params; a param Lead
    // gives replaces the preset's for this run only. The run keeps the preset's name.
    const preset = this.resolvePreset(raw);
    const parsed = StartWorkflowInputSchema.safeParse(preset?.input ?? raw);
    if (!parsed.success) throw invalidInput("start_workflow input is invalid", parsed.error.issues);
    if (parsed.data.workflow === "apply-to-link" && !parsed.data.params.applyAgain) {
      // UC-14 a: the URL was already applied to → Lead says so and stops.
      const job = findJobByUrl(this.core.db, parsed.data.params.url);
      const app = job ? getApplicationByJob(this.core.db, job.id) : undefined;
      if (app) return { started: false, reason: "already_applied", applicationId: app.id };
    }
    const trigger: Run["trigger"] = parsed.data.workflow === "apply-to-link" ? "link" : "chat";
    const run = this.startWorkflowFn(parsed.data, { trigger, presetName: preset?.name ?? null });
    return { started: true, runId: run.id };
  }

  /** A start_workflow call naming a saved preset → its base workflow's input; null for a shipped name. */
  private resolvePreset(raw: unknown): { name: string; input: unknown } | null {
    const r = (raw ?? {}) as { workflow?: unknown; params?: unknown };
    if (isShippedName(r.workflow)) return null;
    const name = typeof r.workflow === "string" ? r.workflow : "";
    const preset = name ? getWorkflowPreset(this.core.db, name) : undefined;
    if (!preset || !isShippedName(preset.basedOn)) {
      const saved = listWorkflowPresets(this.core.db).map((p) => p.name);
      throw invalidInput(
        `there is no workflow or saved preset named ${JSON.stringify(name.slice(0, 60))}; start one of ${[...WORKFLOW_NAMES, ...saved].join(", ")}`,
      );
    }
    const given = r.params && typeof r.params === "object" && !Array.isArray(r.params) ? (r.params as Record<string, unknown>) : {};
    return { name: preset.name, input: { workflow: preset.basedOn, params: { ...preset.params, ...given } } };
  }

  /** The saved presets, for get_status (PM3 S4). */
  presets(): PresetSummary[] {
    return listWorkflowPresets(this.core.db).map((p) => ({ name: p.name, description: p.description, basedOn: p.basedOn, params: p.params }));
  }

  /** get_status: active runs (or one run) with steps and tasks, engines, reviews waiting. */
  getStatus(caller: LeadCaller, raw: unknown = {}) {
    assertLead(this.core, caller, "get_status");
    const db = this.core.db;
    const runId = (raw as { runId?: unknown } | null)?.runId;
    const runs = runId === undefined ? listActiveRuns(db) : [getRun(db, Number(runId))].filter((r): r is Run => r !== undefined);
    if (runId !== undefined && runs.length === 0) throw notFound("run", String(runId));
    return {
      runs: runs.map((run) => ({
        run: mappers.toRun(run),
        steps: listSteps(db, run.id).map(mappers.toStep),
        // Task inputs never hold an approval token (PM S5).
        tasks: listTasks(db, { runId: run.id }).map(mappers.toTask),
      })),
      engines: listEngineStates(db).map((s) => ({ ...mappers.toEngineState(s), running: listTasks(db, { status: "running", engine: s.engine as Engine }).length })),
      pausedTasks: listTasks(db, { status: "paused" }).map((t) => ({ taskId: String(t.id), runId: t.runId === null ? null : String(t.runId), botName: t.botName, kind: t.kind, reason: t.pauseReason })),
      // PM3 S4: saved presets Lead can start by name with start_workflow.
      presets: this.presets(),
    };
  }

  /** get_result: a task's output once it is done. */
  getResult(caller: LeadCaller, raw: unknown) {
    assertLead(this.core, caller, "get_result");
    const taskId = Number((raw as { taskId?: unknown } | null)?.taskId);
    const task = Number.isInteger(taskId) ? getTask(this.core.db, taskId) : undefined;
    if (!task) throw notFound("task", String((raw as { taskId?: unknown } | null)?.taskId));
    return { taskId: String(task.id), status: task.status, output: task.status === "done" ? task.output : null, error: task.error };
  }
}
