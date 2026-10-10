// /api/orch/* → the orchestrator (REST, files, SSE). The logic and its tests live in the data
// seam (lib/api/proxy.ts); this file only mounts it.
import { proxyToOrchestrator } from "@/lib/api/proxy";

export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ path: string[] }>;
}

async function handle(req: Request, ctx: Ctx): Promise<Response> {
  return proxyToOrchestrator(req, (await ctx.params).path);
}

export { handle as DELETE, handle as GET, handle as PATCH, handle as POST, handle as PUT };
