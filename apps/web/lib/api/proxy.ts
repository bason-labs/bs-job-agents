// Same-origin gateway from the browser to the orchestrator: /api/orch/<path> → <ORCH>/<path>.
// The orchestrator answers only local, same-site callers (PM S18: Host/Origin checks, no CORS),
// so the browser reaches it through the web app. This proxy:
// - refuses any request whose Host is not localhost / 127.0.0.1 / [::1] (DNS rebinding: a page on
//   another site resolved to 127.0.0.1 must not read Ba's files or approve anything);
// - forwards only the headers the API needs (Origin, CSRF, cookies, Last-Event-ID, types);
// - streams bodies both ways (uploads, file downloads, the SSE stream) without buffering.
import { orchestratorUrl } from "./config";

const REQUEST_HEADERS = ["accept", "content-type", "origin", "cookie", "last-event-id", "x-requested-with", "x-csrf-token", "range"];
const RESPONSE_HEADERS = ["content-type", "content-disposition", "content-length", "cache-control", "etag", "last-modified", "accept-ranges", "content-range"];

/** `localhost:3000` → true; `evil.com:3000` → false. */
export function isLocalHost(host: string | null): boolean {
  if (!host) return false;
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0]!;
  return ["localhost", "127.0.0.1", "[::1]"].includes(name.toLowerCase());
}

const apiError = (status: number, code: string, message: string) =>
  Response.json({ error: { code, message, details: null } }, { status });

export async function proxyToOrchestrator(
  req: Request,
  path: readonly string[],
  opts: { baseUrl?: string; fetch?: typeof fetch } = {},
): Promise<Response> {
  if (!isLocalHost(req.headers.get("host"))) {
    return apiError(403, "forbidden", "The orchestrator only answers this Mac (open the app at http://localhost:3000).");
  }
  const base = (opts.baseUrl ?? orchestratorUrl()).replace(/\/+$/, "");
  const search = new URL(req.url).search;
  const target = `${base}/${path.map(encodeURIComponent).join("/")}${search}`;

  const headers = new Headers();
  for (const name of REQUEST_HEADERS) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  const init: RequestInit & { duplex?: "half" } = { method: req.method, headers, redirect: "manual", signal: req.signal, cache: "no-store" };
  if (req.method !== "GET" && req.method !== "HEAD" && req.body) {
    init.body = req.body;
    init.duplex = "half";
  }

  let upstream: Response;
  try {
    upstream = await (opts.fetch ?? fetch)(target, init);
  } catch {
    return apiError(502, "internal", "Can't reach the orchestrator. Is it running? Start it with `pnpm dev:orchestrator`.");
  }

  const out = new Headers();
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  for (const cookie of upstream.headers.getSetCookie?.() ?? []) out.append("set-cookie", cookie);
  if (out.get("content-type")?.startsWith("text/event-stream")) {
    out.set("cache-control", "no-cache, no-transform");
    out.set("x-accel-buffering", "no");
    out.delete("content-length");
  }
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
}
