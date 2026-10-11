// PM3 S6 (UX D1): the Flow canvas follows a live run. When branches appear it re-fits the view, but
// never below a zoom where a node's 14 px title stays readable (≥ 11 px on screen); at that floor it
// centres on the step that is running (or waiting for Ba) and Ba pans for the rest. Pure maths, so
// it is unit-tested; FlowCanvas applies it with React Flow's setCenter.
import type { NodeStatus } from "./graph";

/** 14 px titles × 0.8 = 11.2 px on screen. (0.6 would be 8.4 px: the "6 px text" problem again.) */
export const READABLE_ZOOM = 0.8;
/** A fit never zooms in past 1:1 (a two-node run stays its normal size). */
export const MAX_FIT_ZOOM = 1;
/** Space around the graph in a fit, as a share of its size (React Flow's fitView padding). */
export const FIT_PADDING = 0.15;
/** At the floor, the view stops this far (graph units) past the graph's first and last node. */
export const EDGE_PAD = 40;

export interface NodeBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  status: NodeStatus;
}

export interface FollowView {
  zoom: number;
  center: { x: number; y: number };
}

const WAITING: readonly NodeStatus[] = ["waiting", "waiting_limit", "paused"];
const NOT_STARTED: readonly NodeStatus[] = ["pending", "locked"];

/** The step to keep in view: the running one, else one waiting for Ba, else the furthest started one. */
export function focusBox(nodes: readonly NodeBox[]): NodeBox | null {
  if (nodes.length === 0) return null;
  const running = nodes.find((n) => n.status === "running");
  if (running) return running;
  const waiting = nodes.find((n) => WAITING.includes(n.status));
  if (waiting) return waiting;
  const started = nodes.filter((n) => !NOT_STARTED.includes(n.status));
  if (started.length === 0) return nodes[0]!;
  return started.reduce((best, n) => (n.x > best.x ? n : best));
}

/** Centre on `target`, but keep the view inside [lo, hi] (the graph plus EDGE_PAD); if the graph is narrower, its middle. */
function clampCenter(target: number, lo: number, hi: number, half: number): number {
  const min = lo - EDGE_PAD + half;
  const max = hi + EDGE_PAD - half;
  if (min > max) return (lo + hi) / 2;
  return Math.min(max, Math.max(min, target));
}

/** Where the canvas should look: a readable fit of the whole graph, or the focus step at the floor. */
export function followView(nodes: readonly NodeBox[], viewport: { width: number; height: number }): FollowView | null {
  if (nodes.length === 0 || viewport.width <= 0 || viewport.height <= 0) return null;
  const minX = Math.min(...nodes.map((n) => n.x));
  const minY = Math.min(...nodes.map((n) => n.y));
  const maxX = Math.max(...nodes.map((n) => n.x + n.width));
  const maxY = Math.max(...nodes.map((n) => n.y + n.height));
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  const fit = Math.min(viewport.width / (w * (1 + 2 * FIT_PADDING)), viewport.height / (h * (1 + 2 * FIT_PADDING)), MAX_FIT_ZOOM);
  const middle = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  if (fit >= READABLE_ZOOM) return { zoom: fit, center: middle };
  const focus = focusBox(nodes)!;
  const zoom = READABLE_ZOOM;
  return {
    zoom,
    center: {
      x: clampCenter(focus.x + focus.width / 2, minX, maxX, viewport.width / 2 / zoom),
      y: clampCenter(focus.y + focus.height / 2, minY, maxY, viewport.height / 2 / zoom),
    },
  };
}
