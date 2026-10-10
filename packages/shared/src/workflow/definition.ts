// Workflow definition schema for workflows/*.yaml (§7.1). The engine (W2a) executes it;
// workflows/*.yaml (W3a) are parsed from YAML and validated with WorkflowDefinitionSchema.
//
// Steps run in list order. A step with `branch: <stepKey>` runs once per item produced by
// that step (per-job pipelines, §7.1): one branch never waits for another.
// Values in `input` / `options` are templates the engine resolves, e.g. "$params.sources",
// "$item", "$steps.top.output", "$profile".
import { z } from "zod";
import { BotNameSchema, LIMITS } from "../common/primitives.js";
import { RunTriggerSchema } from "../domain/run.js";
import { WorkflowSlugSchema } from "./params.js";

export const STEP_TYPES = ["task", "map", "join", "filter", "gate", "human", "action", "record"] as const;
export type StepType = (typeof STEP_TYPES)[number];

const StepKeySchema = z.string().regex(/^[a-z][a-z0-9-]*$/, "step keys are lowercase slugs");

/** Known pure-code functions; the engine may register more. */
export const KNOWN_FILTER_FNS = ["dedupe", "top"] as const;
export const KNOWN_RECORD_FNS = ["jobs", "submission"] as const;

const TaskRefSchema = z
  .object({
    bot: BotNameSchema,
    kind: z.string().min(1),
    input: z.record(z.unknown()).default({}),
  })
  .strict();
export type TaskRef = z.infer<typeof TaskRefSchema>;

const base = {
  key: StepKeySchema,
  name: z.string().min(1).optional(),
  /** Run once per item of this earlier step's output (per-job branch). */
  branch: StepKeySchema.optional(),
};

export const TaskStepSchema = z
  .object({
    ...base,
    type: z.literal("task"),
    task: TaskRefSchema,
    /** Reuse a cached result younger than this (company profile: 30 days, UC-05 a). */
    cacheDays: z.number().int().positive().optional(),
  })
  .strict();

export const MapStepSchema = z
  .object({ ...base, type: z.literal("map"), over: z.string().min(1), task: TaskRefSchema })
  .strict();

export const JoinStepSchema = z
  .object({
    ...base,
    type: z.literal("join"),
    /** The map step to wait for. */
    of: StepKeySchema,
    /** false = continue with successes and record failures (§7.1). */
    requireAll: z.boolean().default(false),
  })
  .strict();

export const FilterStepSchema = z
  .object({
    ...base,
    type: z.literal("filter"),
    fn: z.string().min(1).describe("dedupe | top | …"),
    from: StepKeySchema,
    options: z.record(z.unknown()).default({}),
  })
  .strict();

export const GateStepSchema = z
  .object({
    ...base,
    type: z.literal("gate"),
    producer: TaskRefSchema,
    checker: TaskRefSchema,
    maxRounds: z.number().int().positive().default(LIMITS.qaMaxRounds),
    /** Run the gate once per CV language (§6.3: VI JD → VI and EN). */
    perLanguage: z.boolean().default(false),
  })
  .strict();

export const HumanDecisionSchema = z.enum(["approve", "request_changes", "skip"]);
export type HumanDecision = z.infer<typeof HumanDecisionSchema>;

export const HumanStepSchema = z
  .object({
    ...base,
    type: z.literal("human"),
    kind: z.literal("review"),
    decisions: z.array(HumanDecisionSchema).min(1),
    /** request_changes(comment) goes back to this gate (§7.2 step 8). */
    onRequestChanges: StepKeySchema.optional(),
  })
  .strict();

export const ActionStepSchema = z
  .object({
    ...base,
    type: z.literal("action"),
    task: TaskRefSchema,
    /** The human step whose approval token this action needs. */
    approvalFrom: StepKeySchema,
  })
  .strict();

export const RecordStepSchema = z
  .object({ ...base, type: z.literal("record"), fn: z.string().min(1).describe("jobs | submission | …") })
  .strict();

export const WorkflowStepSchema = z.discriminatedUnion("type", [
  TaskStepSchema,
  MapStepSchema,
  JoinStepSchema,
  FilterStepSchema,
  GateStepSchema,
  HumanStepSchema,
  ActionStepSchema,
  RecordStepSchema,
]);
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;
export type WorkflowStepInput = z.input<typeof WorkflowStepSchema>;

export const WorkflowDefinitionSchema = z
  .object({
    name: WorkflowSlugSchema,
    version: z.number().int().positive(),
    description: z.string().default(""),
    triggers: z.array(RunTriggerSchema).min(1),
    steps: z.array(WorkflowStepSchema).min(1),
  })
  .strict()
  .superRefine((wf, ctx) => {
    const seen = new Map<string, WorkflowStep>();
    const issue = (i: number, field: string, message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", i, field], message });
    const earlier = (i: number, field: string, ref: string | undefined, types?: readonly StepType[]) => {
      if (ref === undefined) return;
      const target = seen.get(ref);
      if (!target) return issue(i, field, `${field} "${ref}" must name an earlier step`);
      if (types && !types.includes(target.type)) {
        issue(i, field, `${field} "${ref}" must be a ${types.join("/")} step, not ${target.type}`);
      }
    };
    wf.steps.forEach((step, i) => {
      if (seen.has(step.key)) issue(i, "key", `duplicate step key "${step.key}"`);
      earlier(i, "branch", step.branch);
      switch (step.type) {
        case "join":
          earlier(i, "of", step.of, ["map"]);
          break;
        case "filter":
          earlier(i, "from", step.from);
          break;
        case "human":
          earlier(i, "onRequestChanges", step.onRequestChanges, ["gate"]);
          break;
        case "action":
          earlier(i, "approvalFrom", step.approvalFrom, ["human"]);
          break;
        default:
          break;
      }
      seen.set(step.key, step);
    });
  });
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;
export type WorkflowDefinitionInput = z.input<typeof WorkflowDefinitionSchema>;

/** Steps that run per item of `branchStepKey`, in order. */
export function stepsInBranch(wf: WorkflowDefinition, branchStepKey: string): WorkflowStep[] {
  return wf.steps.filter((s) => s.branch === branchStepKey);
}
