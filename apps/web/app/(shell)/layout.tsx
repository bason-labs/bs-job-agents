import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/AppShell";
import { api } from "@/lib/api";

// Sidebar data comes through the lib/api seam (mock today, orchestrator in Phase 3).
export default async function ShellLayout({ children }: { children: ReactNode }) {
  const data = await api.getShellData();
  return <AppShell data={data}>{children}</AppShell>;
}
