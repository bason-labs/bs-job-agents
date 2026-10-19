// AD-2 (REQ-23, NFR-1, design §5.2): the only way the orchestrator talks to a board's API. Built
// from the board's access record, it allows a GET to an endpoint the record lists for its path
// (the usable public API, or the internal GET endpoints for the account API) and nothing else:
// any other method, host, path or query parameter name throws EndpointNotAllowed before any network I/O. Apply endpoints
// are only read to refuse them; nothing here builds one. Requests go through the shared per-host
// gate (≥ 1500 ms per host), and each is reported with its method, host and path only (no query,
// no header). Redirects are never followed blindly: each hop must stay on https and the same host
// and pass the same allowlist, and goes through the gate itself. Every error text passes the redactor.
import {
  applyEndpointsOf,
  internalGetEndpoints,
  usablePublicEndpoints,
  type GetEndpoint,
  type SourceAccessRecord,
} from "@bs-job-agents/shared";
import { HttpRequestError, sendRequestNoRedirect, type HostGate, type HttpAnswer, type HttpFetch } from "../http/index.js";
import { Redactor } from "../secrets/redactor.js";

export const BOARD_API_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";

export class EndpointNotAllowed extends Error {
  constructor(source: string, method: string, host: string, path: string, query: readonly string[] = []) {
    super(
      query.length > 0
        ? `${method} ${host}${path} with query parameter${query.length === 1 ? "" : "s"} ${query.join(", ")} is not a GET endpoint in the ${source} access record`
        : `${method} ${host}${path} is not a GET endpoint in the ${source} access record`,
    );
    this.name = "EndpointNotAllowed";
  }
}

/** A redirect whose target the record does not allow (another host, http, an unlisted path or query): not followed. */
export class RedirectRefused extends EndpointNotAllowed {
  constructor(
    source: string,
    /** Where the board tried to send the request (a board URL, never a credential). */
    readonly target: URL,
  ) {
    super(source, "GET", target.hostname, target.pathname, [...new Set(target.searchParams.keys())]);
    this.name = "RedirectRefused";
  }
}

/** The board has no credential configured (or misses one of its names): no request was sent. */
export class MissingCredential extends Error {
  constructor(
    readonly source: string,
    readonly names: readonly string[],
  ) {
    super(`no ${names.join(", ")} for ${source} in the secrets file`);
    this.name = "MissingCredential";
  }
}

/** HTTP 401 or 403: the token expired or lacks the rights (no retry, design §5.4 fallback). */
export class AuthRejected extends Error {
  constructor(
    readonly source: string,
    readonly status: number,
  ) {
    super(`${source} refused the token (HTTP ${status})`);
    this.name = "AuthRejected";
  }
}

/** Any other failure: `transient` (429, 5xx, connection, timeout: retried) or `failed`. */
export class BoardApiError extends Error {
  constructor(
    readonly kind: "transient" | "failed",
    message: string,
  ) {
    super(message);
    this.name = "BoardApiError";
  }
}

/**
 * Skill self-repair §5.8: the board's API no longer answers the way its record and mapper expect
 * (404 or 410 on a listed endpoint, a 2xx body the mapper cannot read, or a list whose items give no
 * valid posting). The run falls back to the browser and later runs try the API first again. The
 * reason names a method, host and path only, never a query or a header.
 */
export class ApiChanged extends BoardApiError {
  constructor(
    readonly host: string | null,
    readonly path: string | null,
    reason: string,
  ) {
    super("failed", reason);
    this.name = "ApiChanged";
  }
}

export interface RecordedRequest {
  method: "GET";
  host: string;
  /** The path only: the query string and every header are left out. */
  path: string;
}

export interface BoardRequest {
  host: string;
  /** Without the query string. */
  path: string;
  query?: Record<string, string | number | boolean>;
  /** Extra non-secret headers (Accept, x-requested-with, …). */
  headers?: Record<string, string>;
}

export interface BoardApiClientOptions {
  record: SourceAccessRecord;
  /** Which of the record's endpoint lists this client may call. */
  path: "public_api" | "account_api";
  fetch: HttpFetch;
  gate: HostGate;
  /** The board's named values from the SecretStore (null: none configured). Unused on the public API. */
  credentials: Record<string, string> | null;
  redactor?: Redactor;
  /** Each request, before it is sent (a task.progress event). */
  onRequest?: (request: RecordedRequest) => void;
  timeoutMs?: number;
  maxBodyBytes?: number;
  userAgent?: string;
}

const PARAM = /:[A-Za-z_][A-Za-z0-9_]*/g;

/** "/v1/jobs/:id" or "/viec-lam/:slug/:id.html": each ":name" matches one non-empty piece of a segment. */
export function matchesPathPattern(pattern: string, path: string): boolean {
  const parts = pattern.split(PARAM).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${parts.join("[^/]+")}$`).test(path);
}

/** Redirect hops one request may follow. */
export const MAX_REDIRECTS = 3;

const sameHost = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const COOKIE_PREFIX = "cookie:";
const HEADER_PREFIX = "header:";

/**
 * How each auth name is sent. `cookie`: every name is a cookie; `header`: every name is a header;
 * `cookie+header`: names written "header:<name>" are headers, the others cookies. The secrets file
 * keys a value by the bare name.
 */
function authParts(record: SourceAccessRecord): { cookies: string[]; headers: string[] } {
  const { kind, names } = record.auth;
  if (kind === "none") return { cookies: [], headers: [] };
  const bare = (n: string) => (n.startsWith(HEADER_PREFIX) ? n.slice(HEADER_PREFIX.length) : n.startsWith(COOKIE_PREFIX) ? n.slice(COOKIE_PREFIX.length) : n);
  if (kind === "cookie") return { cookies: names.map(bare), headers: [] };
  if (kind === "header") return { cookies: [], headers: names.map(bare) };
  return { cookies: names.filter((n) => !n.startsWith(HEADER_PREFIX)).map(bare), headers: names.filter((n) => n.startsWith(HEADER_PREFIX)).map(bare) };
}

export class BoardApiClient {
  readonly source: string;
  private readonly allowed: GetEndpoint[];
  private readonly redactor: Redactor;

  constructor(private readonly opts: BoardApiClientOptions) {
    this.source = opts.record.source;
    this.allowed = opts.path === "public_api" ? usablePublicEndpoints(opts.record) : internalGetEndpoints(opts.record);
    this.redactor = opts.redactor ?? new Redactor();
  }

  /**
   * The record's endpoint a request would hit, or EndpointNotAllowed (apply endpoints always
   * refused). Every query parameter name must be in that endpoint's `query` list (none listed: no
   * query allowed); when several endpoints match the path, one that takes all the names is used.
   */
  endpointFor(host: string, path: string, queryNames: readonly string[] = []): GetEndpoint {
    const refuse = () => new EndpointNotAllowed(this.source, "GET", host, path, queryNames);
    if (applyEndpointsOf(this.opts.record).some((e) => sameHost(e.host, host) && matchesPathPattern(e.pathPattern, path))) throw refuse();
    const takes = (e: GetEndpoint) => queryNames.every((n) => (e.query ?? []).includes(n));
    const endpoint = this.allowed.find((e) => sameHost(e.host, host) && matchesPathPattern(e.pathPattern, path) && takes(e));
    if (!endpoint) throw refuse();
    return endpoint;
  }

  /** One GET to a listed endpoint: the response body. */
  async get(req: BoardRequest, signal?: AbortSignal): Promise<string> {
    return (await this.getPage(req, signal)).body;
  }

  /**
   * One GET to a listed endpoint: the body and the URL it finally came from. Redirects are not
   * followed by fetch: each Location must be https on the same host and pass endpointFor (path and
   * query names; an apply endpoint never does), and each hop goes through the host gate and
   * onRequest like any request. At most MAX_REDIRECTS hops; a refused hop throws EndpointNotAllowed.
   */
  async getPage(req: BoardRequest, signal?: AbortSignal): Promise<{ body: string; url: URL }> {
    if (req.path.includes("?") || req.path.includes("#")) throw new EndpointNotAllowed(this.source, "GET", req.host, req.path);
    this.endpointFor(req.host, req.path, Object.keys(req.query ?? {}));
    const headers: Record<string, string> = { "User-Agent": this.opts.userAgent ?? BOARD_API_USER_AGENT, Accept: "application/json, text/html;q=0.9, */*;q=0.5", ...req.headers };
    if (this.opts.path === "account_api") Object.assign(headers, this.authHeaders());
    let url = new URL(`https://${req.host}${req.path}`);
    for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, String(v));
    const max = this.opts.maxBodyBytes ?? 8 * 1024 * 1024;
    for (let hop = 0; ; hop++) {
      this.opts.onRequest?.({ method: "GET", host: url.hostname, path: url.pathname });
      let answer: HttpAnswer;
      try {
        answer = await sendRequestNoRedirect({ fetch: this.opts.fetch, gate: this.opts.gate, url: url.toString(), headers, timeoutMs: this.opts.timeoutMs ?? 20_000, maxBodyBytes: max, ...(signal ? { signal } : {}) });
      } catch (err) {
        if (!(err instanceof HttpRequestError)) throw err;
        if (err.kind === "auth_rejected") throw new AuthRejected(this.source, err.status ?? 401);
        const where = `${url.hostname}${url.pathname}`;
        if (err.status === 404 || err.status === 410) throw new ApiChanged(url.hostname, url.pathname, `${where} answered HTTP ${err.status}`);
        throw new BoardApiError(err.kind, this.redactor.redact(err.status === null ? `could not reach ${where} (${err.detail})` : `${where} answered ${err.detail}`));
      }
      if (answer.kind === "body") return { body: answer.body, url };
      if (hop >= MAX_REDIRECTS) throw new BoardApiError("failed", `${url.hostname}${url.pathname} redirected more than ${MAX_REDIRECTS} times`);
      if (!answer.location) throw new BoardApiError("failed", `${url.hostname}${url.pathname} answered HTTP ${answer.status} without a Location`);
      let next: URL;
      try {
        next = new URL(answer.location, url);
      } catch {
        throw new BoardApiError("failed", `${url.hostname}${url.pathname} redirected to an invalid URL`);
      }
      // Another host, or plain http: refused (a cross-host hop would carry the board's headers).
      next.hash = "";
      if (next.protocol !== "https:" || !sameHost(next.hostname, url.hostname)) throw new RedirectRefused(this.source, next);
      try {
        this.endpointFor(next.hostname, next.pathname, [...new Set(next.searchParams.keys())]);
      } catch {
        throw new RedirectRefused(this.source, next);
      }
      url = next;
    }
  }

  /** A GET whose body is JSON. */
  async getJson(req: BoardRequest, signal?: AbortSignal): Promise<unknown> {
    const body = await this.get(req, signal);
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new BoardApiError("failed", `${req.host}${req.path} did not answer JSON`);
    }
  }

  /** Cookie and header values from the credentials; a missing name sends nothing. */
  private authHeaders(): Record<string, string> {
    const { cookies, headers } = authParts(this.opts.record);
    const names = [...cookies, ...headers];
    if (names.length === 0) return {};
    const creds = this.opts.credentials;
    const missing = names.filter((n) => !creds?.[n]);
    if (missing.length > 0) throw new MissingCredential(this.source, missing);
    this.redactor.register(names.map((n) => creds![n]!));
    const out: Record<string, string> = Object.fromEntries(headers.map((n) => [n, creds![n]!]));
    if (cookies.length > 0) out.Cookie = cookies.map((n) => `${n}=${creds![n]!}`).join("; ");
    return out;
  }
}
