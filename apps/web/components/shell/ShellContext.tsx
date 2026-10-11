"use client";

import { createContext, useContext } from "react";
import type { HealthState } from "@/lib/api/contract";
import type { ShellData } from "@/lib/api/types";

export interface ShellState {
  /** Live sidebar data (bots with status, usage, review count, active run). */
  data: ShellData;
  health: HealthState;
}

export const ShellContext = createContext<ShellState | null>(null);

/** The shell's live state for screens inside it (bot tabs, review count, engine pauses). */
export function useShell(): ShellState {
  const value = useContext(ShellContext);
  if (!value) throw new Error("useShell must be used inside <AppShell>");
  return value;
}
