// AD-2: errors are classified once, here. HTTP 429, 5xx, a connection error and a timeout are
// transient (the task attempt is retried under maxAttempts); 401 and 403 are auth_rejected (no
// retry: the token is missing its rights or expired); any other non-2xx fails. A cancel by the
// caller is rethrown unclassified.
import type { HostGate } from "./gate.js";

/** The subset of `fetch` the orchestrator's HTTP clients use (injectable: tests pass a fake). */
export type HttpFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export type HttpFailureKind = "transient" | "auth_rejected" | "failed";

export function classifyStatus(status: number): HttpFailureKind | null {
  if (status >= 200 && status < 300) return null;
  if (status === 429 || status >= 500) return "transient";
  if (status === 401 || status === 403) return "auth_rejected";
  return "failed";
}

export class HttpRequestError extends Error {
  constructor(
    readonly kind: HttpFailureKind,
    /** null for a connection error or timeout. */
    readonly status: number | null,
    /** "fetch failed", "no answer within 20 s", or "HTTP 503". */
    readonly detail: string,
  ) {
    super(detail);
    this.name = "HttpRequestError";
  }
}

export interface SendRequest {
  fetch: HttpFetch;
  gate: HostGate;
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** One GET through the host gate: the body on 2xx, else a classified HttpRequestError. */
export async function sendRequest(req: SendRequest): Promise<string> {
  const host = new URL(req.url).hostname;
  return req.gate.run(
    host,
    async () => {
      const timeout = AbortSignal.timeout(req.timeoutMs);
      const combined = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
      let res: Awaited<ReturnType<HttpFetch>>;
      try {
        res = await req.fetch(req.url, { headers: req.headers, signal: combined });
      } catch (err) {
        if (req.signal?.aborted) throw err;
        const detail = timeout.aborted ? `no answer within ${Math.round(req.timeoutMs / 1000)} s` : err instanceof Error ? err.message : String(err);
        throw new HttpRequestError("transient", null, detail);
      }
      const kind = classifyStatus(res.status);
      if (kind !== null) throw new HttpRequestError(kind, res.status, `HTTP ${res.status}`);
      return res.text();
    },
    req.signal,
  );
}
