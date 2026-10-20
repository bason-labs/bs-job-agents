// The flow canvas model (§11 Flow canvas, UC-22): a run's steps laid out as nodes, one lane per
// selected job (per-job branches, §7.1), pending nodes for steps not started yet, edges that light
// up as work moves, and the red dashed QA loop on a gate that sent a CV back. Pure, so it is
// unit-tested; FlowCanvas.tsx only renders it with React Flow.
//
// RunDetail does not carry the workflow definition (W3a handoff), so the three shared workflows'
// step layouts live here; any other workflow is drawn from the step rows it has.
import type { Step, Task } from "@bs-job-agents/shared";
import { stepPreview, type RunView, type StepView } from "@/lib/api/runs";

export type NodeStatus = Step["status"] | "waiting_limit";
export type NodeKind = "trigger" | "task" | "map" | "filter" | "gate" | "human" | "action" | "record";

export interface MapCounts {
  total: number;
  queued: number;
  running: number;
  done: number;
  failed: number;
}

export interface GateRoundView {
  language: string;
  /** 1, then 2… for each new pass after Ba asked for changes (UC-09); rounds restart at 1. */
  pass: number;
  round: number;
  total: number | null;
  passed: boolean | null;
}

export interface FlowNodeData extends Record<string, unknown> {
  key: string;
  lane: string | null;
  kind: NodeKind;
  label: string;
  /** Bot name, or null for Ba, code steps and the store. */
  bot: string | null;
  botLabel: string;
  status: NodeStatus;
  preview: string | null;
  counts: MapCounts | null;
  rounds: GateRoundView[];
  /** Step rows behind the node (a gate has one per CV language). */
  stepIds: string[];
  taskIds: string[];
}

export interface FlowNodeModel {
  id: string;
  position: { x: number; y: number };
  data: FlowNodeData;
}

export type EdgeState = "lit" | "running" | "idle";

export interface FlowEdgeModel {
  id: string;
  source: string;
  target: string;
  kind: "flow" | "loop";
  state: EdgeState;
}

export interface LaneModel {
  jobId: string;
  title: string;
  y: number;
}

/** The jobs the top step left out (scored under the fit threshold): shown as a note, never as lanes. */
export interface BelowThresholdModel {
  threshold: number | null;
  jobs: { jobId: string; title: string; fitScore: number | null }[];
}

export interface FlowGraph {
  nodes: FlowNodeModel[];
  edges: FlowEdgeModel[];
  lanes: LaneModel[];
  belowThreshold: BelowThresholdModel | null;
}

interface StepDef {
  key: string;
  kind: NodeKind;
  label: string;
  bot: string | null;
  /** Step keys this node stands for, in order (the prototype folds dedupe + fit + top-N into one). */
  keys?: string[];
}

const RUN_LAYOUTS: Record<string, StepDef[]> = {
  "job-scan": [
    { key: "scan", kind: "map", label: "Scan sources", bot: "research" },
    { key: "fit", kind: "map", label: "Dedupe + fit score", bot: "research", keys: ["dedupe", "fit", "top"] },
  ],
  "apply-to-link": [
    { key: "scan", kind: "task", label: "Read the job page", bot: "research" },
    { key: "fit", kind: "map", label: "Fit score", bot: "research", keys: ["fit", "selected"] },
  ],
  "apply-to-file": [
    { key: "scan", kind: "task", label: "Read the JD file", bot: "research" },
    { key: "fit", kind: "map", label: "Fit score", bot: "research", keys: ["fit", "selected"] },
  ],
};

const keysOf = (def: StepDef) => def.keys ?? [def.key];
/** The run steps whose items are the jobs that get a branch. */
const SELECTION_STEPS = ["top", "selected"];

const LANE_STEPS: StepDef[] = [
  { key: "company", kind: "task", label: "Company profile", bot: "research" },
  { key: "tailor", kind: "gate", label: "Tailor CV ⇄ QA", bot: "cv" },
  { key: "review", kind: "human", label: "Your review", bot: null },
  { key: "apply", kind: "action", label: "Fill & submit", bot: "apply" },
  { key: "record", kind: "record", label: "Applications", bot: null },
];

const BOT_NAMES: Record<string, string> = { research: "Research", cv: "CV", qa: "QA", apply: "Apply", lead: "Lead" };
const COL = 230;
const ROW = 250;

const isJoin = (key: string) => key.endsWith("-join");
const laneOf = (s: StepView) => (s.branchKey ? s.branchKey.split(":")[0]! : null);

function aggregate(rows: readonly StepView[]): NodeStatus {
  if (!rows.length) return "pending";
  const has = (s: string) => rows.some((r) => r.status === s);
  for (const s of ["running", "paused", "failed", "waiting", "locked"] as const) if (has(s)) return s;
  if (rows.every((r) => r.status === "skipped")) return "skipped";
  if (rows.every((r) => r.status === "done" || r.status === "skipped")) return "done";
  if (has("cancelled")) return "cancelled";
  return "pending";
}

function countsOf(rows: readonly StepView[]): MapCounts | null {
  for (const r of rows) {
    const c = (r.output as { counts?: MapCounts } | null)?.counts;
    if (c && typeof c.total === "number") return c;
  }
  return null;
}

function roundsOf(rows: readonly StepView[]): GateRoundView[] {
  return rows.flatMap((r) => {
    const out = (r.output ?? {}) as { language?: string; rounds?: { pass?: number; round?: number; total?: number | null; passed?: boolean | null }[] };
    const language = out.language ?? r.branchKey?.split(":")[1] ?? "";
    // Each round keeps its pass and its number within the pass (a second pass after Ba's changes
    // restarts at round 1), never its position in the list.
    return (out.rounds ?? []).map((x, i) => ({ language, pass: x.pass ?? 1, round: x.round ?? i + 1, total: x.total ?? null, passed: x.passed ?? null }));
  });
}

function makeNode(def: StepDef, rows: StepView[], tasks: readonly Task[], lane: string | null, position: { x: number; y: number }): FlowNodeModel {
  const stepIds = rows.map((r) => r.id);
  const own = tasks.filter((t) => t.stepId !== null && stepIds.includes(t.stepId));
  let status = aggregate(rows);
  if (status === "running" && own.some((t) => t.status === "waiting_limit")) status = "waiting_limit";
  const counts = def.kind === "map" ? countsOf(rows) : null;
  // A folded node shows its furthest step's preview (top-N, else fit, else dedupe).
  const folded = def.keys ? [...rows].reverse().map((r) => stepPreview(r)).find(Boolean) : undefined;
  const preview = folded !== undefined
    ? (folded ?? null)
    : rows.length > 1
      ? rows
          .map((r) => {
            const p = stepPreview(r);
            const lang = r.branchKey?.split(":")[1];
            return p ? `${lang ? `${lang.toUpperCase()}: ` : ""}${p}` : null;
          })
          .filter(Boolean)
          .join(" · ") || null
      : rows[0]
        ? stepPreview(rows[0])
        : def.kind === "action"
          ? "unlocks after approval"
          : null;
  const botName = def.bot ? (BOT_NAMES[def.bot] ?? def.bot) : null;
  const botLabel =
    def.kind === "gate"
      ? "CV ⇄ QA"
      : def.kind === "human"
        ? "You"
        : def.kind === "record"
          ? "Store"
          : def.kind === "filter"
            ? "Code"
            : counts
              ? `${botName} ×${counts.total}`
              : (botName ?? "Code");
  return {
    id: lane ? `lane:${lane}:${def.key}` : `step:${def.key}`,
    position,
    data: {
      key: def.key,
      lane,
      kind: def.kind,
      label: def.label,
      bot: def.kind === "gate" ? "cv" : def.bot,
      botLabel,
      status,
      preview,
      counts,
      rounds: def.kind === "gate" ? roundsOf(rows) : [],
      stepIds,
      taskIds: own.map((t) => t.id),
    },
  };
}

const edgeState = (status: NodeStatus): EdgeState =>
  status === "running" ? "running" : ["pending", "locked", "cancelled"].includes(status) ? "idle" : "lit";

const titleCase = (key: string) => key.replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export function buildFlowGraph(view: RunView): FlowGraph {
  const { run, steps, tasks } = view;
  const layout = RUN_LAYOUTS[run.workflowName];
  const runRows = steps.filter((s) => s.branchKey === null && !isJoin(s.stepKey));

  // Run-level steps: the known layout, plus any other step the run has.
  const runDefs: StepDef[] = [...(layout ?? [])];
  for (const s of runRows) {
    if (!runDefs.some((d) => keysOf(d).includes(s.stepKey))) runDefs.push({ key: s.stepKey, kind: "task", label: titleCase(s.stepKey), bot: null });
  }

  // Lanes: the jobs the filter step selected (top, or apply-to-link's selected), then any other
  // branch the steps have. Dedupe and fit list every candidate: those are not branches (live
  // 2026-10-20: they drew 7 phantom pending pipelines beside the one real job).
  const lanes: { jobId: string; title: string }[] = [];
  const titleOf = (it: { jobId?: number | string; title?: string; company?: string }) =>
    it.company && it.title ? `${it.company} — ${it.title}` : (it.title ?? `Job ${String(it.jobId ?? "")}`);
  let belowThreshold: BelowThresholdModel | null = null;
  for (const s of runRows) {
    if (!SELECTION_STEPS.includes(s.stepKey)) continue;
    const out = (s.output ?? {}) as { items?: { jobId?: number | string; title?: string; company?: string }[]; threshold?: number; belowThreshold?: { jobId?: number | string; title?: string; company?: string; fitScore?: number }[] };
    for (const it of Array.isArray(out.items) ? out.items : []) {
      const jobId = String(it.jobId ?? "");
      if (jobId && !lanes.some((l) => l.jobId === jobId)) lanes.push({ jobId, title: titleOf(it) });
    }
    if (Array.isArray(out.belowThreshold) && out.belowThreshold.length > 0) {
      belowThreshold = {
        threshold: typeof out.threshold === "number" ? out.threshold : null,
        jobs: out.belowThreshold.map((it) => ({ jobId: String(it.jobId ?? ""), title: titleOf(it), fitScore: typeof it.fitScore === "number" ? it.fitScore : null })),
      };
    }
  }
  for (const s of steps) {
    const lane = laneOf(s);
    if (lane && !lanes.some((l) => l.jobId === lane)) lanes.push({ jobId: lane, title: `Job ${lane}` });
  }

  const centerY = lanes.length > 1 ? ((lanes.length - 1) * ROW) / 2 : 0;
  const nodes: FlowNodeModel[] = [
    {
      id: "trigger",
      position: { x: 0, y: centerY },
      data: {
        key: "trigger",
        lane: null,
        kind: "trigger",
        label: "Trigger",
        bot: null,
        botLabel: run.trigger === "schedule" ? "Schedule" : "You",
        status: "done",
        preview: run.trigger === "schedule" ? "scheduled scan" : run.trigger === "link" ? "pasted link" : "from chat",
        counts: null,
        rounds: [],
        stepIds: [],
        taskIds: [],
      },
    },
  ];
  runDefs.forEach((def, i) => {
    nodes.push(makeNode(def, keysOf(def).flatMap((k) => runRows.filter((s) => s.stepKey === k)), tasks, null, { x: (i + 1) * COL, y: centerY }));
  });

  const laneDefs = layout ? LANE_STEPS : [...LANE_STEPS.filter((d) => steps.some((s) => laneOf(s) && s.stepKey === d.key))];
  if (!layout) {
    for (const s of steps) if (laneOf(s) && !laneDefs.some((d) => d.key === s.stepKey)) laneDefs.push({ key: s.stepKey, kind: "task", label: titleCase(s.stepKey), bot: null });
  }
  const laneStart = runDefs.length + 1;
  lanes.forEach((lane, li) => {
    laneDefs.forEach((def, i) => {
      const rows = steps.filter((s) => laneOf(s) === lane.jobId && s.stepKey === def.key);
      nodes.push(makeNode(def, rows, tasks, lane.jobId, { x: (laneStart + i) * COL, y: li * ROW }));
    });
  });

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges: FlowEdgeModel[] = [];
  const link = (source: string, target: string) => {
    const t = byId.get(target);
    if (byId.has(source) && t) edges.push({ id: `${source}->${target}`, source, target, kind: "flow", state: edgeState(t.data.status) });
  };
  const chain = ["trigger", ...runDefs.map((d) => `step:${d.key}`)];
  chain.slice(1).forEach((id, i) => link(chain[i]!, id));
  for (const lane of lanes) {
    const ids = laneDefs.map((d) => `lane:${lane.jobId}:${d.key}`);
    link(chain.at(-1)!, ids[0]!);
    ids.slice(1).forEach((id, i) => link(ids[i]!, id));
  }
  for (const n of nodes) {
    if (n.data.kind === "gate" && n.data.rounds.some((r) => r.passed === false)) {
      edges.push({ id: `loop:${n.id}`, source: n.id, target: n.id, kind: "loop", state: "lit" });
    }
  }

  return { nodes, edges, lanes: lanes.map((l, i) => ({ ...l, y: i * ROW })), belowThreshold };
}

/** The status word on a node (prototype). */
export function nodeStatusText(status: NodeStatus, key: string): string {
  switch (status) {
    case "done":
      return "✓ done";
    case "running":
      return "● running";
    case "failed":
      return "✗ failed";
    case "waiting":
      return key === "review" ? "waiting" : "⏳ waiting";
    case "waiting_limit":
      return "⏸ limit";
    case "paused":
      return "⏸ paused";
    case "locked":
      return "🔒 locked";
    default:
      return status;
  }
}

export const LAYOUT = { COL, ROW };
