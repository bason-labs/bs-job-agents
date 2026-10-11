"use client";

import "@xyflow/react/dist/base.css";
import "./flows.css";
import { MiniMap, ReactFlow, ReactFlowProvider, useReactFlow, useStore, type Edge, type Node } from "@xyflow/react";
import { Maximize, Minus, Pause, Play, Plus, Square, Workflow } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { errorMessage } from "@/lib/api/errors";
import { useRun } from "@/lib/api/hooks";
import { useApi } from "@/lib/api/react";
import { cn } from "@/lib/cn";
import { formatWhen } from "@/lib/datetime";
import { runTitle, workflowTitle } from "@/components/chat/RunCard";
import { Page } from "@/components/shell/Page";
import { useShell } from "@/components/shell/ShellContext";
import { StatusPill } from "@/components/ui/Badge";
import { Button, buttonClass } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { IconButton } from "@/components/ui/IconButton";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { FlowEdge, LoopEdge, type FlowEdgeData } from "./Edges";
import { focusBox, followView } from "./follow";
import { buildFlowGraph, type FlowNodeData } from "./graph";
import { StepDrawer } from "./StepDrawer";
import { StepNode } from "./StepNode";

const nodeTypes = { step: StepNode };
const edgeTypes = { flow: FlowEdge, loop: LoopEdge };

const TRIGGER_TEXT: Record<string, string> = { chat: "from chat", schedule: "scheduled", link: "from a pasted link" };

/**
 * Our own zoom buttons (the design system's IconButton), bound to React Flow's viewport. Zooming by
 * hand stops the canvas following the run; "Fit to screen" starts it again (PM3 S6).
 */
function ZoomControls({ onManual, onFit }: { onManual: () => void; onFit: () => void }) {
  const { zoomIn, zoomOut } = useReactFlow();
  return (
    <div className="absolute bottom-3 left-3 z-10 flex flex-col gap-1 rounded-2xl border border-border bg-surface/90 p-1 backdrop-blur-md">
      <IconButton size="sm" label="Zoom in" icon={<Plus aria-hidden />} onClick={() => (onManual(), void zoomIn())} />
      <IconButton size="sm" label="Zoom out" icon={<Minus aria-hidden />} onClick={() => (onManual(), void zoomOut())} />
      <IconButton size="sm" label="Fit to screen" icon={<Maximize aria-hidden />} onClick={onFit} />
    </div>
  );
}

/**
 * PM3 S6 (UX D1): keeps a live run in view. When branches appear or the run moves to another step,
 * the view re-fits (animated) unless Ba panned or zoomed since; the fit never goes below the
 * readable zoom, and at that floor it centres on the running step (followView).
 */
function FollowRun({ following, focusId, fitTick }: { following: MutableRefObject<boolean>; focusId: string | null; fitTick: number }) {
  const rf = useReactFlow<Node<FlowNodeData, "step">>();
  const width = useStore((st) => st.width);
  const height = useStore((st) => st.height);
  // The nodes React Flow holds: a new branch (more nodes) re-fits once they are in its store.
  const nodeCount = useStore((st) => st.nodes.length);
  const first = useRef(true);
  useEffect(() => {
    if (!following.current) return;
    const boxes = rf.getNodes().map((n) => ({
      id: n.id,
      x: n.position.x,
      y: n.position.y,
      width: n.measured?.width ?? 180,
      height: n.measured?.height ?? 90,
      status: n.data.status,
    }));
    const view = followView(boxes, { width, height });
    if (!view) return;
    void rf.setCenter(view.center.x, view.center.y, { zoom: view.zoom, duration: first.current ? 0 : 400 });
    first.current = false;
  }, [rf, following, nodeCount, focusId, fitTick, width, height]);
  return null;
}

/**
 * Flow canvas (§11, UC-22, UC-23): a run's steps live (step/task/run events patch the view), lanes
 * per job, the QA loop, the locked Apply node; Pause / Resume / Cancel; click a node → step drawer.
 */
export function FlowCanvas({ runId }: { runId: string }) {
  const api = useApi();
  const { toast } = useToast();
  const { data: shell } = useShell();
  const run = useRun(runId);
  const [selected, setSelected] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const view = run.data;
  const graph = useMemo(() => (view ? buildFlowGraph(view) : null), [view]);
  // PM3 S6: follow the run until Ba pans or zooms; "Fit to screen" follows again.
  const following = useRef(true);
  const [fitTick, setFitTick] = useState(0);
  const refit = useCallback(() => {
    following.current = true;
    setFitTick((t) => t + 1);
  }, []);
  const focusId = useMemo(
    () => focusBox((graph?.nodes ?? []).map((n) => ({ id: n.id, x: n.position.x, y: n.position.y, width: 180, height: 90, status: n.data.status })))?.id ?? null,
    [graph],
  );

  const nodes: Node<FlowNodeData, "step">[] = useMemo(
    () => (graph?.nodes ?? []).map((n) => ({ id: n.id, type: "step" as const, position: n.position, data: n.data, selected: n.id === selected, initialWidth: 180, initialHeight: n.data.rounds.length ? 90 + n.data.rounds.length * 24 : 90 })),
    [graph, selected],
  );
  const edges: Edge<FlowEdgeData>[] = useMemo(
    () =>
      (graph?.edges ?? []).map((e) =>
        e.kind === "loop"
          ? { id: e.id, source: e.source, target: e.target, sourceHandle: "loop-out", targetHandle: "loop-in", type: "loop", data: { state: e.state } }
          : { id: e.id, source: e.source, target: e.target, type: "flow", data: { state: e.state } },
      ),
    [graph],
  );

  const control = async (action: "pause" | "resume" | "cancel") => {
    setPending(action);
    try {
      const res = await api.controlRun(runId, action);
      run.mutate((prev) => (prev ? { ...prev, run: res.run } : prev));
      toast({ title: action === "pause" ? "Paused: no new tasks start; running ones finish" : action === "resume" ? "Resumed" : `Cancelled ${workflowTitle(res.run.workflowName)} #${runId}` });
      setConfirmCancel(false);
    } catch (err) {
      toast({ title: errorMessage(err), tone: "err" });
    } finally {
      setPending(null);
    }
  };

  if (!view) {
    return (
      <Page width="full" className="p-5">
        {run.error ? (
          <EmptyState
            icon={<Workflow aria-hidden />}
            title={`Couldn't load run #${runId}`}
            description={errorMessage(run.error)}
            action={
              <Button size="sm" onClick={() => void run.reload()}>
                Retry
              </Button>
            }
          />
        ) : (
          <Skeleton className="h-full min-h-80 w-full rounded-3xl" />
        )}
      </Page>
    );
  }

  const status = view.run.status;
  const finished = status === "done" || status === "failed" || status === "cancelled";
  const node = graph?.nodes.find((n) => n.id === selected)?.data ?? null;

  return (
    <Page width="full" className="relative">
      <div className="absolute top-3 left-3 z-10 flex max-w-[calc(100%-1.5rem)] flex-wrap items-center gap-2 rounded-2xl border border-border bg-surface/80 px-3 py-2 backdrop-blur-md">
        <b className="font-display">
          {runTitle(view.run.workflowName, view.presetName)} #{runId}
        </b>
        <StatusPill status={status} />
        <span className="text-xs text-muted" data-testid="run-meta">
          {TRIGGER_TEXT[view.run.trigger] ?? view.run.trigger} · started {formatWhen(view.run.createdAt)}
          {view.run.searchProfileVersion ? ` · criteria v${view.run.searchProfileVersion}` : ""}
        </span>
      </div>
      <div className="absolute top-3 right-3 z-10 flex flex-wrap justify-end gap-2">
        {status === "paused" ? (
          <Button size="sm" leftIcon={<Play aria-hidden className="size-3.5" />} loading={pending === "resume"} onClick={() => void control("resume")}>
            Resume
          </Button>
        ) : (
          <Button size="sm" leftIcon={<Pause aria-hidden className="size-3.5" />} disabled={finished} loading={pending === "pause"} onClick={() => void control("pause")}>
            Pause
          </Button>
        )}
        <Button size="sm" variant="warn" leftIcon={<Square aria-hidden className="size-3.5" />} disabled={finished} onClick={() => setConfirmCancel(true)}>
          Cancel run
        </Button>
        <Link href="/review" className={buttonClass({ variant: "primary", size: "sm" })}>
          Open review ({shell.reviewCount})
        </Link>
      </div>

      <div className={cn("bsja-flow bg-grid relative min-h-0 flex-1")} data-testid="flow-canvas">
        <ReactFlowProvider>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodeClick={(_, n) => setSelected(n.id)}
            onMoveStart={(event) => {
              // A pan or zoom by Ba (programmatic moves have no event) stops the following.
              if (event) following.current = false;
            }}
            nodesDraggable={false}
            nodesConnectable={false}
            edgesFocusable={false}
            minZoom={0.25}
            maxZoom={1.5}
            attributionPosition="bottom-left"
          >
            <MiniMap pannable zoomable position="bottom-right" nodeClassName={(n) => `bsja-mm bsja-mm-${(n.data as FlowNodeData).status}`} />
            <ZoomControls onManual={() => (following.current = false)} onFit={refit} />
            <FollowRun following={following} focusId={focusId} fitTick={fitTick} />
          </ReactFlow>
        </ReactFlowProvider>
      </div>

      <StepDrawer view={view} data={node} onClose={() => setSelected(null)} />
      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title={`Cancel ${runTitle(view.run.workflowName, view.presetName)} #${runId}?`}
        description="Running tasks stop and the run ends. Finished steps keep their results; cards still waiting for review leave the queue. Submitted applications are never touched."
        confirmLabel="Cancel run"
        cancelLabel="Keep running"
        loading={pending === "cancel"}
        onConfirm={() => void control("cancel")}
      />
    </Page>
  );
}
