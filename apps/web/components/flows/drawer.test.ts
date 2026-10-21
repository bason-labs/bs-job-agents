import { describe, expect, it } from "vitest";
import { MockBackend } from "@/lib/api/mock/backend";
import type { RunView } from "@/lib/api/runs";
import { canRerun, defaultTask, nodeTasks, outputSummary, selfCheckOf } from "./drawer";
import { buildFlowGraph } from "./graph";

async function run12() {
  const api = new MockBackend({ sleep: () => Promise.resolve() });
  const view = (await api.getRun("12")) as RunView;
  const node = (id: string) => buildFlowGraph(view).nodes.find((n) => n.id === id)!.data;
  return { view, node };
}

describe("step drawer model (UC-22)", () => {
  it("a map node lists one task per item, named after the item", async () => {
    const { view, node } = await run12();
    const tasks = nodeTasks(view, node("step:scan"));
    expect(tasks.map((t) => t.label)).toEqual(["TopCV", "ITviec", "LinkedIn"]);
    expect(tasks[2]!.task.attempt).toBe(2);
  });

  it("a gate lists CV and QA per round and language, newest last", async () => {
    const { view, node } = await run12();
    const labels = nodeTasks(view, node("lane:102:tailor")).map((t) => t.label);
    expect(labels).toEqual(["VI · Round 1 · CV", "VI · Round 1 · QA", "VI · Round 2 · CV", "VI · Round 2 · QA", "EN · Round 1 · CV", "EN · Round 1 · QA"]);
  });

  it("live 2026-10-20: a second pass (after Ba's changes) restarts at round 1 and is labelled, not counted on as rounds 4-6", async () => {
    const { view, node } = await run12();
    const row = view.steps.find((s) => s.id === node("lane:102:tailor").stepIds[0])!;
    const out = row.output as { rounds: { producerTaskId: string; checkerTaskId: string | null }[] };
    const second = { ...view, steps: view.steps.map((s) => (s.id === row.id ? { ...s, output: { ...out, rounds: out.rounds.map((r, i) => ({ ...r, pass: i === 0 ? 1 : 2, round: 1 })) } } : s)) };
    const labels = nodeTasks(second, buildFlowGraph(second).nodes.find((n) => n.id === "lane:102:tailor")!.data).map((t) => t.label);
    expect(labels.slice(0, 4)).toEqual(["VI · Round 1 · CV", "VI · Round 1 · QA", "VI · After your changes · Round 1 · CV", "VI · After your changes · Round 1 · QA"]);
  });

  it("the default task is the running one, else the newest", async () => {
    const { view, node } = await run12();
    const tasks = nodeTasks(view, node("step:scan"));
    expect(defaultTask(tasks)!.label).toBe("LinkedIn");
    const running = tasks.map((t, i) => (i === 0 ? { ...t, task: { ...t.task, status: "running" as const } } : t));
    expect(defaultTask(running)!.label).toBe("TopCV");
    expect(defaultTask([])).toBeNull();
  });

  it("self-check items and an output summary come from the bot output", async () => {
    const { view, node } = await run12();
    const scan = nodeTasks(view, node("step:scan"))[0]!.task;
    expect(selfCheckOf(scan).map((c) => c.item)).toEqual([
      "Every job has a reachable URL",
      "Every job has full JD text (not a snippet)",
      "No job is a duplicate of another in this output",
    ]);
    expect(outputSummary(scan)).toBe("1 JobCandidate · 12 page views");
    const qa = nodeTasks(view, node("lane:101:tailor")).at(-1)!.task;
    expect(outputSummary(qa)).toBe("QaReview 88 · passed");
    expect(selfCheckOf({ ...scan, output: null })).toEqual([]);
  });

  it("which steps can be re-run (UC-23: never Apply, the record or the review)", async () => {
    const { node } = await run12();
    expect(canRerun(node("step:scan"))).toEqual({ allowed: true, reason: null });
    expect(canRerun(node("lane:101:tailor")).allowed).toBe(true);
    expect(canRerun(node("lane:101:review"))).toEqual({ allowed: false, reason: "The review step is your decision: use the review card." });
    expect(canRerun(node("lane:101:apply"))).toEqual({ allowed: false, reason: "Apply is never re-run; approve the card again instead." });
    expect(canRerun({ ...node("lane:101:apply"), preview: "submitted", status: "done" }).reason).toBe("A submitted apply step can never be re-run.");
    expect(canRerun({ ...node("step:scan"), status: "running" })).toEqual({ allowed: false, reason: "Only a finished or failed step can be re-run." });
  });
});
