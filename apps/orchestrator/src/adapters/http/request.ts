// AD-2: errors are classified once, here. HTTP 429, 5xx, a connection error and a timeout are
// transient (the task attempt is retried under maxAttempts); 401 and 403 are auth_rejected (no
// retry: the token is missing its rights or expired); any other non-2xx fails. A cancel by the
// caller is rethrown unclassified.
import type { HostGate } from "./gate.js";

/** The subset of `fetch` the orchestrator's HTTP clients use (injectable: tests pass a fake). */
export type HttpFetch = (
  url: string,
  init: { method?: "GET" | "POST"; body?: string; headers: Record<string, string>; signal: AbortSignal; redirect?: "manual" | "follow" },
) => Promise<HttpResponse>;

export interface HttpResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  /** Real fetch: the response headers (a redirect's Location). */
  headers?: { get(name: string): string | null };
  /** Real fetch: the body stream, read with a running byte count when a cap is set. */
  body?: ReadableStream<Uint8Array> | null;
}

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
  /** GET unless set; a POST is only ever a board's read-only search (BoardApiClient.postSearch). */
  method?: "GET" | "POST";
  /** The POST body (JSON text). */
  body?: string;
  headers: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Stop reading (and fail) past this many bytes, without reading the rest of the body. */
  maxBodyBytes?: number;
}

/** One answer with redirects not followed: a body (2xx), or a 3xx and its Location. */
export type HttpAnswer = { kind: "body"; body: string } | { kind: "redirect"; status: number; location: string | null };

const isRedirect = (status: number) => status >= 300 && status < 400 && status !== 304;

/** The body, read chunk by chunk with a running count when a cap is set: past the cap, the read stops. */
async function readBody(res: HttpResponse, maxBytes: number | undefined): Promise<string> {
  const tooBig = () => new HttpRequestError("failed", res.status, `more than ${maxBytes} bytes`);
  if (maxBytes === undefined) return res.text();
  if (!res.body) {
    const text = await res.text();
    if (Buffer.byteLength(text) > maxBytes) throw tooBig();
    return text;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooBig();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function send(req: SendRequest, redirect: "manual" | "follow"): Promise<HttpAnswer> {
  const host = new URL(req.url).hostname;
  return req.gate.run(
    host,
    async (): Promise<HttpAnswer> => {
      const timeout = AbortSignal.timeout(req.timeoutMs);
      const combined = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
      let res: HttpResponse;
      try {
        res = await req.fetch(req.url, {
          ...(req.method === "POST" ? { method: "POST" as const, body: req.body ?? "" } : {}),
          headers: req.headers,
          signal: combined,
          ...(redirect === "manual" ? { redirect } : {}),
        });
      } catch (err) {
        if (req.signal?.aborted) throw err;
        const detail = timeout.aborted ? `no answer within ${Math.round(req.timeoutMs / 1000)} s` : err instanceof Error ? err.message : String(err);
        throw new HttpRequestError("transient", null, detail);
      }
      if (redirect === "manual" && isRedirect(res.status)) {
        await res.body?.cancel().catch(() => undefined);
        return { kind: "redirect", status: res.status, location: res.headers?.get("location") ?? null };
      }
      const kind = classifyStatus(res.status);
      if (kind !== null) throw new HttpRequestError(kind, res.status, `HTTP ${res.status}`);
      return { kind: "body", body: await readBody(res, req.maxBodyBytes) };
    },
    req.signal,
  );
}

/** One GET through the host gate, redirects followed by fetch: the body on 2xx, else a classified HttpRequestError. */
export async function sendRequest(req: SendRequest): Promise<string> {
  const answer = await send(req, "follow");
  if (answer.kind === "redirect") throw new HttpRequestError("failed", answer.status, `HTTP ${answer.status}`);
  return answer.body;
}

/**
 * One request (GET, or the read-only search POST) through the host gate with redirects NOT followed
 * (redirect: "manual"): the caller checks each Location against its allowlist and sends the next hop
 * itself, through the gate again (a POST is never redirected: its caller refuses every 3xx).
 */
export async function sendRequestNoRedirect(req: SendRequest): Promise<HttpAnswer> {
  return send(req, "manual");
}
