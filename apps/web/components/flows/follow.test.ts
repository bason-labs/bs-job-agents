import { describe, expect, it } from "vitest";
import { EDGE_PAD, MAX_FIT_ZOOM, READABLE_ZOOM, focusBox, followView, type NodeBox } from "./follow";

const box = (id: string, x: number, y: number, status: NodeBox["status"] = "done"): NodeBox => ({ id, x, y, width: 180, height: 90, status });
const viewport = { width: 1180, height: 820 };

describe("which node the canvas follows (PM3 S6)", () => {
  it("the running node first, then one waiting for Ba, then the furthest step that has started", () => {
    const nodes = [box("a", 0, 0), box("b", 230, 0, "running"), box("c", 460, 0, "waiting"), box("d", 690, 0, "pending")];
    expect(focusBox(nodes)?.id).toBe("b");
    expect(focusBox(nodes.map((n) => (n.id === "b" ? { ...n, status: "done" as const } : n)))?.id).toBe("c");
    expect(focusBox([box("a", 0, 0), box("b", 230, 0), box("c", 460, 0, "pending")])?.id).toBe("b");
    expect(focusBox([box("a", 0, 0, "pending")])?.id).toBe("a");
    expect(focusBox([])).toBeNull();
  });
});

describe("followView (PM3 S6, UX D1)", () => {
  it("a graph that fits at a readable zoom is fitted and centred (never above the fit's maximum)", () => {
    const small = [box("a", 0, 0), box("b", 230, 0, "running")];
    const v = followView(small, viewport)!;
    expect(v.zoom).toBe(MAX_FIT_ZOOM);
    expect(v.center).toEqual({ x: (0 + 230 + 180) / 2, y: 45 });
  });

  it("a wide graph never goes below the readable zoom: it centres on the running node instead", () => {
    // 9 columns × 3 lanes, like a finished 3-branch job scan.
    const wide = Array.from({ length: 9 }, (_, c) => [0, 1, 2].map((l) => box(`n${c}-${l}`, c * 230, l * 250, c === 4 && l === 2 ? "running" : c < 4 ? "done" : "pending"))).flat();
    const v = followView(wide, viewport)!;
    expect(v.zoom).toBe(READABLE_ZOOM);
    // x on the running node; the three lanes' height (≈ 590 px at 0.8) fits, so y is the graph's middle.
    expect(v.center.x).toBe(4 * 230 + 90);
    expect(v.center.y).toBe((0 + 500 + 90) / 2);
    // A 14 px node title stays ≥ 11 px on screen.
    expect(14 * v.zoom).toBeGreaterThanOrEqual(11);
  });

  it("at the floor, the view does not scroll past the graph's ends", () => {
    const wide = Array.from({ length: 10 }, (_, c) => box(`n${c}`, c * 230, 0, c === 0 ? "running" : "pending"));
    const v = followView(wide, viewport)!;
    const halfWidth = viewport.width / 2 / READABLE_ZOOM;
    const pad = EDGE_PAD;
    expect(v.center.x).toBeCloseTo(0 - pad + halfWidth);
    const end = followView(wide.map((n) => ({ ...n, status: n.id === "n9" ? ("running" as const) : ("done" as const) })), viewport)!;
    expect(end.center.x).toBeCloseTo(9 * 230 + 180 + pad - halfWidth);
  });

  it("a tall graph at the floor follows the running node's lane", () => {
    const tall = Array.from({ length: 8 }, (_, l) => [0, 1, 2, 3, 4, 5].map((c) => box(`n${c}-${l}`, c * 230, l * 250, c === 5 && l === 4 ? "running" : "done"))).flat();
    const v = followView(tall, viewport)!;
    expect(v.zoom).toBe(READABLE_ZOOM);
    expect(v.center.y).toBeCloseTo(4 * 250 + 45, 0);
  });

  it("nothing to follow without nodes or a measured viewport", () => {
    expect(followView([], viewport)).toBeNull();
    expect(followView([box("a", 0, 0)], { width: 0, height: 0 })).toBeNull();
  });
});
