"use client";

import { createContext, useContext } from "react";
import type { HealthState } from "@/lib/api/contract";
import type { ShellData } from "@/lib/api/types";

export interface ShellState {
  /** Live sidebar data (bots with status, usage, review count, active run). */
  data: ShellData;
  health: HealthState;
  /**
   * Re-read the whole shell (bots, rooms, usage, review count). For changes no live event reports,
   * e.g. a room Ba just created (UC-15).
   */
  refresh?: () => void;
}

export const ShellContext = createContext<ShellState | null>(null);

/** The shell's refresh, or a no-op outside the shell (component tests). */
export function useShellRefresh(): () => void {
  return useContext(ShellContext)?.refresh ?? noop;
}

const noop = () => {};

/** The shell's live state for screens inside it (bot tabs, review count, engine pauses). */
export function useShell(): ShellState {
  const value = useContext(ShellContext);
  if (!value) throw new Error("useShell must be used inside <AppShell>");
  return value;
}
