import type { Task } from "@bs-job-agents/shared";
import { runFixture, stepFixture, taskFixture } from "@bs-job-agents/shared/fixtures";
import { describe, expect, it } from "vitest";
import type { RunView, StepView } from "@/lib/api/runs";
import { MockBackend } from "@/lib/api/mock/backend";
import { buildFlowGraph, nodeStatusText } from "./graph";

const step = (stepKey: string, branchKey: string | null, status: StepView["status"], over: Partial<StepView> = {}): StepView => ({
  ...stepFixture,
  id: `${stepKey}:${branchKey ?? "run"}`,
  stepKey,
  branchKey,
  status,
  output: null,
  preview: null,
  ...over,
});

describe("buildFlowGraph", () => {
  it("lays out the job-scan run steps, one lane per selected job, and pending nodes for steps not started", async () => {
    const api = new MockBackend({ sleep: () => Promise.resolve() });
    const view = (await api.getRun("12")) as RunView;
    const g = buildFlowGraph(view);
    const ids = g.nodes.map((n) => n.id);
    expect(ids.slice(0, 3)).toEqual(["trigger", "step:scan", "step:fit"]);
    // Joins are bookkeeping, and dedupe + fit + top-N fold into one node (prototype).
    expect(ids.some((id) => /join|dedupe|top/.test(id))).toBe(false);
    expect(g.nodes.find((n) => n.id === "step:fit")!.data).toMatchObject({ label: "Dedupe + fit score", preview: "3 jobs ≥ 60 (16 dropped, 2 already applied)", botLabel: "Research ×21" });
    for (const job of ["101", "102", "103"]) {
      expect(ids).toEqual(expect.arrayContaining([`lane:${job}:company`, `lane:${job}:tailor`, `lane:${job}:review`, `lane:${job}:apply`, `lane:${job}:record`]));
    }
    expect(g.lanes.map((l) => l.title)).toEqual([
      "NovaPay — Senior Frontend Engineer (React/Next.js)",
      "Sao Việt Tech — Lập trình viên Frontend ReactJS",
      "Kite Labs — Software Engineer — AI Workflows",
    ]);
    const node = (id: string) => g.nodes.find((n) => n.id === id)!.data;
    expect(node("step:scan")).toMatchObject({ kind: "map", status: "done", preview: "34 found → 21 new", botLabel: "Research ×3" });
    expect(node("lane:101:review")).toMatchObject({ status: "waiting", preview: "waiting for Ba", bot: null, botLabel: "You" });
    expect(node("lane:101:apply")).toMatchObject({ status: "locked", botLabel: "Apply" });
    expect(node("lane:101:record")).toMatchObject({ status: "pending", stepIds: [] });
    expect(node("lane:102:company")).toMatchObject({ status: "skipped", preview: "cache hit" });
    // The VI JD's gate has one row per language, folded into one node.
    expect(node("lane:102:tailor").rounds.map((r) => [r.language, r.round, r.total, r.passed])).toEqual([
      ["vi", 1, 78, false],
      ["vi", 2, 84, true],
      ["en", 1, 85, true],
    ]);
    expect(node("lane:102:tailor").stepIds).toHaveLength(2);
    expect(node("lane:103:tailor").preview).toBe("QA not passed after 3 rounds");
  });

  it("edges follow the pipeline; a gate with a failed round gets the red dashed QA loop", async () => {
    const api = new MockBackend({ sleep: () => Promise.resolve() });
    const g = buildFlowGraph((await api.getRun("12")) as RunView);
    const has = (source: string, target: string) => g.edges.some((e) => e.source === source && e.target === target);
    expect(has("trigger", "step:scan")).toBe(true);
    expect(has("step:fit", "lane:101:company")).toBe(true);
    expect(has("lane:101:tailor", "lane:101:review")).toBe(true);
    expect(has("lane:101:apply", "lane:101:record")).toBe(true);
    const loops = g.edges.filter((e) => e.kind === "loop").map((e) => e.source);
    expect(loops).toEqual(["lane:101:tailor", "lane:102:tailor", "lane:103:tailor"]);
    // An edge into a finished node is lit; into a locked or pending one it is dashed.
    expect(g.edges.find((e) => e.target === "lane:101:review")!.state).toBe("lit");
    expect(g.edges.find((e) => e.target === "lane:101:apply")!.state).toBe("idle");
  });

  it("a fresh job scan shows the run steps pending and no lanes yet", () => {
    const view: RunView = { run: { ...runFixture, status: "running" }, steps: [step("scan", null, "running", { round: null })], tasks: [] };
    const g = buildFlowGraph(view);
    expect(g.nodes.map((n) => [n.id, n.data.status])).toEqual([
      ["trigger", "done"],
      ["step:scan", "running"],
      ["step:fit", "pending"],
    ]);
    expect(g.edges.find((e) => e.target === "step:scan")!.state).toBe("running");
  });

  it("map counts and a task waiting for the usage limit show on the node", () => {
    const tasks: Task[] = [{ ...taskFixture, id: "t1", stepId: "scan:run", botName: "research", status: "waiting_limit" }];
    const view: RunView = {
      run: runFixture,
      steps: [step("scan", null, "running", { output: { counts: { total: 3, queued: 1, running: 1, done: 1, failed: 0 } } })],
      tasks,
    };
    const scan = buildFlowGraph(view).nodes.find((n) => n.id === "step:scan")!.data;
    expect(scan.counts).toEqual({ total: 3, queued: 1, running: 1, done: 1, failed: 0 });
    expect(scan.status).toBe("waiting_limit");
  });

  it("apply-to-link reads one page and selects its job; unknown workflows still render their steps", () => {
    const link: RunView = {
      run: { ...runFixture, workflowName: "apply-to-link" },
      steps: [step("scan", null, "done"), step("selected", null, "done", { output: { items: [{ jobId: 7, title: "FE", company: "Hyperion" }] } })],
      tasks: [],
    };
    const g = buildFlowGraph(link);
    expect(g.nodes.map((n) => n.id)).toEqual(expect.arrayContaining(["step:scan", "step:fit", "lane:7:company"]));
    expect(g.nodes.find((n) => n.id === "step:scan")!.data.label).toBe("Read the job page");

    const custom: RunView = { run: { ...runFixture, workflowName: "my-flow" }, steps: [step("alpha", null, "done"), step("beta", null, "running")], tasks: [] };
    expect(buildFlowGraph(custom).nodes.map((n) => n.id)).toEqual(["trigger", "step:alpha", "step:beta"]);
  });

  it("status words on the node (prototype)", () => {
    expect(nodeStatusText("done", "scan")).toBe("✓ done");
    expect(nodeStatusText("running", "scan")).toBe("● running");
    expect(nodeStatusText("failed", "tailor")).toBe("✗ failed");
    expect(nodeStatusText("waiting", "review")).toBe("waiting");
    expect(nodeStatusText("waiting_limit", "tailor")).toBe("⏸ limit");
    expect(nodeStatusText("locked", "apply")).toBe("🔒 locked");
    expect(nodeStatusText("paused", "apply")).toBe("⏸ paused");
  });
});
