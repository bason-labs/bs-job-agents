"use client";

import { BaseEdge, EdgeLabelRenderer, getBezierPath, type Edge, type EdgeProps } from "@xyflow/react";
import type { EdgeState } from "./graph";

export type FlowEdgeData = { state: EdgeState };
export type StepFlowEdge = Edge<FlowEdgeData, "flow">;
export type LoopFlowEdge = Edge<FlowEdgeData, "loop">;

/** Pipeline edge: accent once the target has started, flowing dashes while it runs, dotted while idle. */
export function FlowEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<StepFlowEdge>) {
  const [path] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const state = data?.state ?? "idle";
  return (
    <BaseEdge
      id={id}
      path={path}
      className={state === "running" ? "bsja-edge-running" : undefined}
      style={{
        stroke: state === "idle" ? "var(--border)" : "var(--accent)",
        strokeWidth: 2,
        strokeDasharray: state === "idle" ? "3 5" : undefined,
      }}
    />
  );
}

/** The red dashed QA loop under a gate: "QA fail → fixes → next round" (prototype). */
export function LoopEdge({ id, sourceX, sourceY, targetX, targetY }: EdgeProps<LoopFlowEdge>) {
  const drop = 70;
  const path = `M${sourceX},${sourceY} C${sourceX + 30},${sourceY + drop} ${targetX - 30},${targetY + drop} ${targetX},${targetY}`;
  const labelX = (sourceX + targetX) / 2;
  const labelY = sourceY + drop * 0.75;
  return (
    <>
      <BaseEdge id={id} path={path} style={{ stroke: "var(--danger)", strokeWidth: 2, strokeDasharray: "4 5" }} />
      <EdgeLabelRenderer>
        <span
          className="pointer-events-none absolute rounded-full border border-danger/40 bg-surface/90 px-2 py-0.5 text-[10px] whitespace-nowrap text-danger"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
        >
          QA fail → fixes → next round
        </span>
      </EdgeLabelRenderer>
    </>
  );
}
