import { describe, expect, it } from "vitest";
import { applyToFileWorkflow, applyToLinkWorkflow, jobScanWorkflow } from "../fixtures/workflows.js";
import { STEP_TYPES, WorkflowDefinitionSchema, stepsInBranch } from "./definition.js";
import {
  ApplyToLinkParamsSchema,
  JobScanParamsSchema,
  StartWorkflowInputSchema,
  WORKFLOW_PARAMS_SCHEMAS,
} from "./params.js";

const clone = <T>(v: T): T => structuredClone(v);

describe("WorkflowDefinitionSchema (§7.1)", () => {
  it("has exactly the eight step types", () => {
    expect([...STEP_TYPES]).toEqual(["task", "map", "join", "filter", "gate", "human", "action", "record"]);
  });

  it.each([
    ["job-scan", jobScanWorkflow],
    ["apply-to-link", applyToLinkWorkflow],
    ["apply-to-file", applyToFileWorkflow],
  ])("parses the %s fixture", (_n, wf) => {
    const r = WorkflowDefinitionSchema.safeParse(wf);
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });

  it("applies defaults: join.requireAll false, gate.maxRounds 3", () => {
    const wf = WorkflowDefinitionSchema.parse(jobScanWorkflow);
    const join = wf.steps.find((s) => s.type === "join");
    const gate = wf.steps.find((s) => s.type === "gate");
    expect(join?.type === "join" && join.requireAll).toBe(false);
    expect(gate?.type === "gate" && gate.maxRounds).toBe(3);
  });

  it("rejects an unknown step type", () => {
    const wf = clone(jobScanWorkflow) as { steps: Array<Record<string, unknown>> };
    wf.steps.push({ key: "loop", type: "while" });
    expect(WorkflowDefinitionSchema.safeParse(wf).success).toBe(false);
  });

  it("rejects duplicate step keys", () => {
    const wf = clone(jobScanWorkflow);
    wf.steps.push({ ...wf.steps[0]! });
    const r = WorkflowDefinitionSchema.safeParse(wf);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/duplicate step key/);
  });

  it("an action step needs an approval from an earlier human step (§7.1, §10.2 rule 1)", () => {
    const wf = clone(jobScanWorkflow) as { steps: Array<Record<string, unknown>> };
    const apply = wf.steps.find((s) => s.type === "action")!;
    apply.approvalFrom = "tailor";
    expect(WorkflowDefinitionSchema.safeParse(wf).success).toBe(false);
    delete apply.approvalFrom;
    expect(WorkflowDefinitionSchema.safeParse(wf).success).toBe(false);
  });

  it("an action placed before its human step is rejected", () => {
    const wf = clone(jobScanWorkflow);
    const idxReview = wf.steps.findIndex((s) => s.key === "review");
    const idxApply = wf.steps.findIndex((s) => s.key === "apply");
    const tmp = wf.steps[idxReview]!;
    wf.steps[idxReview] = wf.steps[idxApply]!;
    wf.steps[idxApply] = tmp;
    expect(WorkflowDefinitionSchema.safeParse(wf).success).toBe(false);
  });

  it("join must refer to an earlier map step", () => {
    const wf = clone(jobScanWorkflow) as { steps: Array<Record<string, unknown>> };
    wf.steps.find((s) => s.type === "join")!.of = "dedupe";
    expect(WorkflowDefinitionSchema.safeParse(wf).success).toBe(false);
  });

  it("human onRequestChanges must refer to a gate", () => {
    const wf = clone(jobScanWorkflow) as { steps: Array<Record<string, unknown>> };
    wf.steps.find((s) => s.type === "human")!.onRequestChanges = "company";
    expect(WorkflowDefinitionSchema.safeParse(wf).success).toBe(false);
  });

  it("branch must refer to an earlier step", () => {
    const wf = clone(jobScanWorkflow) as { steps: Array<Record<string, unknown>> };
    wf.steps.find((s) => s.key === "company")!.branch = "nowhere";
    expect(WorkflowDefinitionSchema.safeParse(wf).success).toBe(false);
  });

  it("gate maxRounds must be positive", () => {
    const wf = clone(jobScanWorkflow) as { steps: Array<Record<string, unknown>> };
    wf.steps.find((s) => s.type === "gate")!.maxRounds = 0;
    expect(WorkflowDefinitionSchema.safeParse(wf).success).toBe(false);
  });

  it("a task kind must be one of its bot's kinds, so typos fail at load time (PM S4)", () => {
    const wf = clone(jobScanWorkflow) as { steps: Array<Record<string, unknown>> };
    (wf.steps.find((s) => s.key === "fit")!.task as { kind: string }).kind = "fitt";
    const r = WorkflowDefinitionSchema.safeParse(wf);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(["steps", 3, "task", "kind"]);
    expect(r.error?.issues[0]?.message).toMatch(/not one of research's kinds/);
  });

  it("checks the gate's producer and checker kinds too (PM S4)", () => {
    const wf = clone(jobScanWorkflow) as { steps: Array<Record<string, unknown>> };
    (wf.steps.find((s) => s.type === "gate")!.checker as { kind: string }).kind = "tailor";
    const r = WorkflowDefinitionSchema.safeParse(wf);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(["steps", 8, "checker", "kind"]);
  });

  it("apply.submit may only run in an action step (PM S4, §10.2 rule 1)", () => {
    const wf = clone(jobScanWorkflow) as { steps: Array<Record<string, unknown>> };
    wf.steps.find((s) => s.key === "company")!.task = { bot: "apply", kind: "submit", input: {} };
    const r = WorkflowDefinitionSchema.safeParse(wf);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/outward-facing.*action step/);

    const asMap = clone(jobScanWorkflow) as { steps: Array<Record<string, unknown>> };
    asMap.steps[0]!.task = { bot: "apply", kind: "submit", input: {} };
    expect(WorkflowDefinitionSchema.safeParse(asMap).success).toBe(false);

    const asGate = clone(jobScanWorkflow) as { steps: Array<Record<string, unknown>> };
    asGate.steps.find((s) => s.type === "gate")!.producer = { bot: "apply", kind: "submit", input: {} };
    expect(WorkflowDefinitionSchema.safeParse(asGate).success).toBe(false);
  });

  it("an action step runs an outward-facing task, nothing else (§7.1)", () => {
    const wf = clone(jobScanWorkflow) as { steps: Array<Record<string, unknown>> };
    wf.steps.find((s) => s.type === "action")!.task = { bot: "research", kind: "company", input: {} };
    const r = WorkflowDefinitionSchema.safeParse(wf);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/action step runs an outward-facing task/);
  });

  it("does not check kinds of bots added after Phase 1", () => {
    const wf = clone(jobScanWorkflow) as { steps: Array<Record<string, unknown>> };
    wf.steps.find((s) => s.key === "company")!.task = { bot: "translator", kind: "translate", input: {} };
    expect(WorkflowDefinitionSchema.safeParse(wf).success).toBe(true);
  });

  it("stepsInBranch lists the per-job pipeline (company → derive facts → CV ⇄ QA gate → review → apply → record)", () => {
    const wf = WorkflowDefinitionSchema.parse(jobScanWorkflow);
    expect(stepsInBranch(wf, "top").map((s) => s.key)).toEqual(["company", "derive", "tailor", "review", "apply", "record"]);
  });
});

describe("workflow params", () => {
  it("job-scan params default to the active profile with no overrides", () => {
    expect(JobScanParamsSchema.parse({})).toEqual({ searchProfileId: null, overrides: null });
  });

  it("job-scan may show jobs Ba skipped before (UC-04 b, optional)", () => {
    expect(JobScanParamsSchema.parse({ showSkipped: true })).toMatchObject({ showSkipped: true });
    expect(JobScanParamsSchema.safeParse({ showSkipped: "yes" }).success).toBe(false);
  });

  it("job-scan overrides are validated", () => {
    expect(JobScanParamsSchema.safeParse({ overrides: { maxJobs: 3, locations: ["Đà Nẵng"] } }).success).toBe(true);
    expect(JobScanParamsSchema.safeParse({ overrides: { maxJobs: 0 } }).success).toBe(false);
    expect(JobScanParamsSchema.safeParse({ bogus: true }).success).toBe(false);
  });

  it("apply-to-link needs an http(s) URL", () => {
    expect(ApplyToLinkParamsSchema.safeParse({ url: "https://www.topcv.vn/viec-lam/x/1.html" }).success).toBe(true);
    expect(ApplyToLinkParamsSchema.safeParse({ url: "javascript:alert(1)" }).success).toBe(false);
  });

  it("start_workflow input discriminates on workflow", () => {
    const r = StartWorkflowInputSchema.parse({ workflow: "apply-to-file", params: { uploadId: "upl_1" } });
    expect(r.workflow).toBe("apply-to-file");
    expect(StartWorkflowInputSchema.safeParse({ workflow: "apply-to-file", params: { url: "https://x.y" } }).success).toBe(false);
    expect(Object.keys(WORKFLOW_PARAMS_SCHEMAS)).toEqual(["job-scan", "apply-to-link", "apply-to-file"]);
  });
});
