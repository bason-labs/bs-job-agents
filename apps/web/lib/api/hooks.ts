"use client";

// Per-screen data hooks: a cached read (useResource) kept current by the live events that touch it.
import type { AppEvent, ReviewCard, Room, Run } from "@bs-job-agents/shared";
import { useEffect, useRef } from "react";
import { useAppEvents, useDebounced, useResource, type Resource } from "./react";
import { applyRunEvent, mergeRunDetail, type RunView } from "./runs";

const eventRunId = (e: AppEvent): string | null => ("runId" in e && typeof e.runId === "string" ? e.runId : null);

/** One run with its steps and tasks; step/task/run events patch it at once and trigger a re-read. */
export function useRun(runId: string | null): Resource<RunView> {
  const latest = useRef<RunView | undefined>(undefined);
  const res = useResource<RunView>(runId ? `run:${runId}` : null, async (api) => mergeRunDetail(latest.current, await api.getRun(runId!)));
  useEffect(() => {
    latest.current = res.data;
  });
  const refresh = useDebounced(() => void res.reload(), 300);
  useAppEvents((e) => {
    if (!runId || eventRunId(e) !== runId) return;
    res.mutate((prev) => (prev ? applyRunEvent(prev, e) : prev));
    refresh();
  });
  return res;
}

/** Every run, newest first (Flows list). */
export function useRuns(): Resource<Run[]> {
  const res = useResource("runs", (api) => api.listRuns());
  const refresh = useDebounced(() => void res.reload(), 300);
  useAppEvents((e) => {
    if (e.type === "run.started" || e.type === "run.updated" || e.type === "run.finished") refresh();
  });
  return res;
}

const REVIEW_STEPS = new Set(["review", "apply", "tailor"]);

/** The review queue; re-read when a card becomes ready or a decision lands. */
export function useReviewQueue(): Resource<ReviewCard[]> {
  const res = useResource("review", (api) => api.getReviewQueue());
  const refresh = useDebounced(() => void res.reload(), 300);
  useAppEvents((e) => {
    if (e.type === "review.ready" || e.type === "application.updated" || e.type === "run.finished") refresh();
    else if ((e.type === "step.finished" || e.type === "step.updated") && REVIEW_STEPS.has(e.stepKey)) refresh();
  });
  return res;
}

/** Rooms (Lead, consult, group). */
export function useRooms(): Resource<Room[]> {
  return useResource("rooms", (api) => api.listRooms());
}
