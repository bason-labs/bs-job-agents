// The same-origin /api proxy to the orchestrator (PM S18). The orchestrator sends no CORS headers,
// so the browser calls /api/* on the web app's own origin (REST, files, SSE) and this forwards it.
// Decided per request, so ORCH_URL / ORCH_PORT are honoured by `next start` at run time (a
// next.config rewrite froze them into the build). Next's external rewrite keeps the browser's
// Origin, the CSRF header and the body, and names this app in X-Forwarded-Host, so the
// orchestrator's own Host / Origin / CSRF checks (api/security.ts) see what they did before.
import { NextResponse, type NextRequest } from "next/server";
import { orchestratorProxyTarget } from "./lib/api/config";

export function proxy(request: NextRequest): NextResponse {
  const target = orchestratorProxyTarget({
    host: request.headers.get("host"),
    pathname: request.nextUrl.pathname,
    search: request.nextUrl.search,
  });
  // DNS rebinding: a request not addressed to this Mac is never forwarded.
  if (target === null) return new NextResponse(null, { status: 404 });
  return NextResponse.rewrite(target);
}

export const config = { matcher: "/api/:path*" };
