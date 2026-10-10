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

export interface FlowGraph {
  nodes: FlowNodeModel[];
  edges: FlowEdgeModel[];
  lanes: LaneModel[];
}

interface StepDef {
  key: string;
  kind: NodeKind;
  label: string;
  bot: string | null;
}

const RUN_LAYOUTS: Record<string, StepDef[]> = {
  "job-scan": [
    { key: "scan", kind: "map", label: "Scan sources", bot: "research" },
    { key: "dedupe", kind: "filter", label: "Dedupe", bot: null },
    { key: "fit", kind: "map", label: "Fit score", bot: "research" },
    { key: "top", kind: "filter", label: "Top matches", bot: null },
  ],
  "apply-to-link": [
    { key: "scan", kind: "task", label: "Read the job page", bot: "research" },
    { key: "fit", kind: "map", label: "Fit score", bot: "research" },
    { key: "selected", kind: "filter", label: "Selected job", bot: null },
  ],
  "apply-to-file": [
    { key: "scan", kind: "task", label: "Read the JD file", bot: "research" },
    { key: "fit", kind: "map", label: "Fit score", bot: "research" },
    { key: "selected", kind: "filter", label: "Selected job", bot: null },
  ],
};

const LANE_STEPS: StepDef[] = [
  { key: "company", kind: "task", label: "Company profile", bot: "research" },
  { key: "tailor", kind: "gate", label: "Tailor CV ⇄ QA", bot: "cv" },
  { key: "review", kind: "human", label: "Your review", bot: null },
  { key: "apply", kind: "action", label: "Fill & submit", bot: "apply" },
  { key: "record", kind: "record", label: "Applications", bot: null },
];

const BOT_NAMES: Record<string, string> = { research: "Research", cv: "CV", qa: "QA", apply: "Apply", lead: "Lead" };
const COL = 230;
const ROW = 200;

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
  const c = (rows[0]?.output as { counts?: MapCounts } | null)?.counts;
  return c && typeof c.total === "number" ? c : null;
}

function roundsOf(rows: readonly StepView[]): GateRoundView[] {
  return rows.flatMap((r) => {
    const out = (r.output ?? {}) as { language?: string; rounds?: { total?: number | null; passed?: boolean | null }[] };
    const language = out.language ?? r.branchKey?.split(":")[1] ?? "";
    return (out.rounds ?? []).map((x, i) => ({ language, round: i + 1, total: x.total ?? null, passed: x.passed ?? null }));
  });
}

function makeNode(def: StepDef, rows: StepView[], tasks: readonly Task[], lane: string | null, position: { x: number; y: number }): FlowNodeModel {
  const stepIds = rows.map((r) => r.id);
  const own = tasks.filter((t) => t.stepId !== null && stepIds.includes(t.stepId));
  let status = aggregate(rows);
  if (status === "running" && own.some((t) => t.status === "waiting_limit")) status = "waiting_limit";
  const counts = def.kind === "map" ? countsOf(rows) : null;
  const preview =
    rows.length > 1
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
    if (!runDefs.some((d) => d.key === s.stepKey)) runDefs.push({ key: s.stepKey, kind: "task", label: titleCase(s.stepKey), bot: null });
  }

  // Lanes: the jobs the filter step selected, then any other branch the steps have.
  const lanes: { jobId: string; title: string }[] = [];
  for (const s of runRows) {
    const items = (s.output as { items?: { jobId?: number | string; title?: string; company?: string }[] } | null)?.items;
    if (!Array.isArray(items) || s.stepKey === "scan" || s.stepKey === "fit") continue;
    for (const it of items) {
      const jobId = String(it.jobId ?? "");
      if (jobId && !lanes.some((l) => l.jobId === jobId)) lanes.push({ jobId, title: it.company && it.title ? `${it.company} — ${it.title}` : `Job ${jobId}` });
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
    nodes.push(makeNode(def, runRows.filter((s) => s.stepKey === def.key), tasks, null, { x: (i + 1) * COL, y: centerY }));
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

  return { nodes, edges, lanes: lanes.map((l, i) => ({ ...l, y: i * ROW })) };
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
