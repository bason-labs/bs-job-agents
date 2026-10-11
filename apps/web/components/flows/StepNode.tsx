"use client";

import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { cn } from "@/lib/cn";
import type { FlowNodeData, NodeStatus } from "./graph";
import { nodeStatusText } from "./graph";

const STATUS_TONE: Partial<Record<NodeStatus, string>> = {
  done: "text-ok",
  running: "text-accent",
  failed: "text-danger",
  waiting: "text-warn",
  waiting_limit: "text-warn",
  paused: "text-warn",
  locked: "text-warn",
};

const LANG = (l: string) => l.toUpperCase();

/** A step on the canvas (prototype node): bot and status, label, live preview, map counts, QA rounds. */
export function StepNodeCard({ data, selected = false }: { data: FlowNodeData; selected?: boolean }) {
  const idle = data.status === "pending" || data.status === "locked";
  const testId = data.lane ? `node-${data.key}-${data.lane}` : `node-${data.key}`;
  return (
    <div
      data-testid={testId}
      data-status={data.status}
      data-clickable
      className={cn(
        "w-[180px] rounded-2xl border bg-surface/95 p-3 text-sm backdrop-blur transition hover:border-accent",
        data.status === "running" ? "bsja-node-running" : "border-border",
        idle && "border-dashed opacity-70",
        (data.status === "waiting" || data.status === "waiting_limit" || data.status === "paused") && "!border-warn",
        data.status === "failed" && "!border-danger",
        data.status === "cancelled" && "opacity-60",
        data.kind === "map" && "shadow-[4px_4px_0_-1px_var(--surface),4px_4px_0_0_var(--border),8px_8px_0_-1px_var(--surface),8px_8px_0_0_var(--border)]",
        selected && "ring-2 ring-accent",
      )}
    >
      <div className="flex justify-between gap-2 text-[10px] tracking-wider text-muted uppercase">
        <span className="truncate">{data.botLabel}</span>
        <span className={cn("shrink-0", STATUS_TONE[data.status])}>{nodeStatusText(data.status, data.key)}</span>
      </div>
      <p className="mt-1 font-medium">{data.label}</p>
      {data.preview ? <p className="mt-1 line-clamp-3 text-[11px] text-muted">{data.preview}</p> : null}
      {data.counts && data.status === "running" ? (
        <p className="mt-1 text-[10px] text-accent tabular">
          {data.counts.running} running · {data.counts.queued} queued · {data.counts.done}/{data.counts.total} done
        </p>
      ) : null}
      {data.rounds.length ? (
        <div className="mt-2 space-y-1">
          {data.rounds.map((r, i) => (
            <div
              key={`${r.language}-${i}`}
              className={cn(
                "flex justify-between rounded-lg px-2 py-1 text-[11px]",
                r.passed === true ? "bg-ok/10 text-ok" : r.passed === false ? "bg-danger/10 text-danger" : "bg-surface-2 text-muted",
              )}
            >
              <span>
                {new Set(data.rounds.map((x) => x.language)).size > 1 ? `${LANG(r.language)} · ` : ""}Round {r.round}
              </span>
              <b className="tabular">{r.total === null ? "…" : `${r.total} ${r.passed ? "✓" : "✗"}`}</b>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export type StepFlowNode = Node<FlowNodeData, "step">;

/** React Flow wrapper: in/out handles, and the bottom handles the QA loop edge uses. */
export function StepNode({ data, selected }: NodeProps<StepFlowNode>) {
  const lit = data.status === "done" || data.status === "skipped";
  return (
    <>
      <Handle type="target" position={Position.Left} className="!size-2 !min-h-0 !min-w-0 !opacity-0" />
      <StepNodeCard data={data} selected={selected} />
      <Handle
        type="source"
        position={Position.Right}
        className={cn("!size-3 !min-h-0 !min-w-0 !ring-2 !ring-[var(--surface)]", lit ? "!bg-accent" : "!bg-surface-3")}
      />
      {data.kind === "gate" ? (
        <>
          <Handle id="loop-out" type="source" position={Position.Bottom} style={{ left: "72%" }} className="!size-1 !min-h-0 !min-w-0 !opacity-0" />
          <Handle id="loop-in" type="target" position={Position.Bottom} style={{ left: "28%" }} className="!size-1 !min-h-0 !min-w-0 !opacity-0" />
        </>
      ) : null}
    </>
  );
}
