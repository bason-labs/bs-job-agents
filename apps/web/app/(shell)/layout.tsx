import { connection } from "next/server";
import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/AppShell";
import { mockSpeed, resolveApiMode } from "@/lib/api/config";
import type { HealthStatus, WebApi } from "@/lib/api/contract";
import { isApiError } from "@/lib/api/errors";
import { offlineShellData } from "@/lib/api/map";
import { ApiProvider } from "@/lib/api/react";
import { getServerApi } from "@/lib/api/server";
import type { ShellData } from "@/lib/api/types";

/** Sidebar data and health; an unreachable or broken API yields the offline sidebar and a banner. */
async function loadShell(server: WebApi): Promise<{ data: ShellData; health: HealthStatus }> {
  const health = await server.getHealth();
  try {
    return { data: await server.getShellData(), health };
  } catch (err) {
    const reason = isApiError(err) && err.code === "unreachable" ? "unreachable" : "api_error";
    return {
      data: offlineShellData(),
      health: health.ok ? { ok: false, reason, detail: reason === "api_error" && err instanceof Error ? err.message : null } : health,
    };
  }
}

// Rendered per request (never at build time): the sidebar is live data, and the backend
// (orchestrator or mock) is chosen from the runtime environment (lib/api/config.ts).
export default async function ShellLayout({ children }: { children: ReactNode }) {
  await connection();
  const mode = await resolveApiMode();
  const { data, health } = await loadShell(await getServerApi(mode));
  return (
    <ApiProvider mode={mode} mockSpeed={mockSpeed()}>
      <AppShell data={data} health={health}>
        {children}
      </AppShell>
    </ApiProvider>
  );
}
