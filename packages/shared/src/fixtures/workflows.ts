// Workflow definitions matching §7.2–7.3b, as the YAML would parse. W3a owns workflows/*.yaml.
import type { WorkflowDefinitionInput, WorkflowStepInput } from "../workflow/definition.js";

/** §7.2 steps 6–10: one pipeline per selected job; it derives master facts before tailoring (CV auto-extend). */
const perJob = (branch: string, opts: { derive?: boolean; review?: boolean } = {}): WorkflowStepInput[] => [
  {
    key: "company",
    type: "task",
    branch,
    task: { bot: "research", kind: "company", input: { name: "$item.company", website: "$item.companyWebsite" } },
    cacheDays: 30,
  },
  ...(opts.derive ? [{ key: "derive", type: "task", branch, task: { bot: "cv", kind: "derive", input: { job: "$item" } } } satisfies WorkflowStepInput] : []),
  {
    key: "tailor",
    type: "gate",
    branch,
    producer: { bot: "cv", kind: "tailor", input: { job: "$item", company: "$steps.company.output" } },
    checker: { bot: "qa", kind: "review", input: { job: "$item", draft: "$producer.output" } },
    // CV guidance (AD-13): cv.review on QA-passed or handed rounds only.
    ...(opts.review ? { reviewer: { bot: "cv", kind: "review", input: {} } } : {}),
    maxRounds: 3,
    perLanguage: true,
  },
  {
    key: "review",
    type: "human",
    branch,
    kind: "review",
    decisions: ["approve", "request_changes", "skip"],
    onRequestChanges: "tailor",
  },
  {
    key: "apply",
    type: "action",
    branch,
    task: { bot: "apply", kind: "submit", input: { approval: "$steps.review.output" } },
    approvalFrom: "review",
  },
  { key: "record", type: "record", branch, fn: "submission" },
];

export const jobScanWorkflow = {
  name: "job-scan",
  version: 3,
  description: "Scan sources, score fit, then tailor, QA, review and apply per job.",
  triggers: ["chat", "schedule"],
  steps: [
    {
      key: "scan",
      type: "map",
      over: "$params.sources",
      task: { bot: "research", kind: "scan", input: { source: "$item", criteria: "$profile" } },
    },
    { key: "scan-join", type: "join", of: "scan", requireAll: false },
    { key: "dedupe", type: "filter", fn: "dedupe", from: "scan-join" },
    { key: "fit", type: "map", over: "$steps.dedupe.output", task: { bot: "research", kind: "fit", input: { job: "$item" } } },
    { key: "fit-join", type: "join", of: "fit" },
    {
      key: "top",
      type: "filter",
      fn: "top",
      from: "fit-join",
      options: { threshold: "$profile.fitThreshold", take: "$profile.maxJobs" },
    },
    // CV guidance (AD-12): one refresh per run, after top and before every branch step.
    { key: "guidance", type: "task", task: { bot: "research", kind: "guidance_extract", input: {} }, optional: true, skipIfEmpty: "top" },
    ...perJob("top", { derive: true, review: true }),
  ],
} satisfies WorkflowDefinitionInput;

/** §7.3: research.scan kind single, no threshold/top-N (fit still computed and shown). */
export const applyToLinkWorkflow = {
  name: "apply-to-link",
  version: 2,
  description: "Apply to one pasted job link.",
  triggers: ["link", "chat"],
  steps: [
    { key: "scan", type: "task", task: { bot: "research", kind: "single", input: { url: "$params.url" } } },
    { key: "fit", type: "map", over: "$steps.scan.output.jobs", task: { bot: "research", kind: "fit", input: { job: "$item" } } },
    { key: "fit-join", type: "join", of: "fit" },
    { key: "selected", type: "filter", fn: "dedupe", from: "fit-join", options: { applyAgain: "$params.applyAgain" } },
    ...perJob("selected", { derive: true }),
  ],
} satisfies WorkflowDefinitionInput;

/** §7.3b: research.scan kind file. */
export const applyToFileWorkflow = {
  ...applyToLinkWorkflow,
  name: "apply-to-file",
  description: "Apply to a job from an uploaded JD file.",
  triggers: ["chat"],
  steps: [
    { key: "scan", type: "task", task: { bot: "research", kind: "file", input: { uploadId: "$params.uploadId" } } },
    ...applyToLinkWorkflow.steps.slice(1),
  ],
} satisfies WorkflowDefinitionInput;
