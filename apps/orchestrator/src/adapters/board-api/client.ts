// AD-2 (REQ-23, NFR-1, design §5.2): the only way the orchestrator talks to a board's API. Built
// from the board's access record, it allows a GET to an endpoint the record lists for its path
// (the usable public API, or the internal GET endpoints for the account API) and nothing else:
// any other method, host, path or query parameter name throws EndpointNotAllowed before any network I/O. Apply endpoints
// are only read to refuse them; nothing here builds one. Requests go through the shared per-host
// gate (≥ 1500 ms per host), and each is reported with its method, host and path only (no query,
// no header). Redirects are never followed blindly: each hop must stay on https and the same host
// and pass the same allowlist, and goes through the gate itself. Every error text passes the redactor.
// The one POST (2026-10-20 addendum) is a board's read-only search the record lists under
// internalApiPostSearchEndpoints (VietnamWorks): postSearch checks the whole body against the record
// before any I/O, sends no credential, and follows no redirect at all.
import {
  applyEndpointsOf,
  internalGetEndpoints,
  internalPostSearchEndpoints,
  usablePublicEndpoints,
  type GetEndpoint,
  type PostSearchEndpoint,
  type SourceAccessRecord,
} from "@bs-job-agents/shared";
import { HttpRequestError, sendRequestNoRedirect, type HostGate, type HttpAnswer, type HttpFetch } from "../http/index.js";
import { Redactor } from "../secrets/redactor.js";

export const BOARD_API_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";

export class EndpointNotAllowed extends Error {
  constructor(source: string, method: string, host: string, path: string, query: readonly string[] = [], why?: string) {
    super(
      why !== undefined
        ? `${method} ${host}${path} is refused: ${why} (${source} access record)`
        : query.length > 0
          ? `${method} ${host}${path} with query parameter${query.length === 1 ? "" : "s"} ${query.join(", ")} is not a GET endpoint in the ${source} access record`
          : `${method} ${host}${path} is not a${method === "POST" ? " POST search" : " GET"} endpoint in the ${source} access record`,
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
    /** The HTTP status when the board answered one (a mapper may treat 429 as a block). */
    readonly status: number | null = null,
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
    readonly method: "GET" | "POST" = "GET",
  ) {
    super("failed", reason);
    this.name = "ApiChanged";
  }
}

/**
 * QA L4: the board answered 200 with a bot-check page (Cloudflare "Just a moment…", a CAPTCHA) instead
 * of its content. Not a changed API: this run reads the board in the browser and the API health is
 * left as it is.
 */
export class DirectReadBlocked extends Error {
  constructor(
    readonly source: string,
    readonly host: string,
    readonly path: string,
  ) {
    super(`${host}${path} answered with a bot check`);
    this.name = "DirectReadBlocked";
  }
}

/** A 200 page that is a bot check, not the board's content. */
export function isBotCheckPage(html: string): boolean {
  return /just a moment|cf-chl|challenge-platform|cf-browser-verification|captcha|verify you are (?:a )?human|are you a robot|attention required|access denied|enable javascript and cookies to continue|ddos-guard|perimeterx|px-captcha/i.test(html.slice(0, 50_000));
}

export interface RecordedRequest {
  method: "GET" | "POST";
  host: string;
  /** The path only: the query string and every header are left out. */
  path: string;
}

export interface BoardRequest {
  host: string;
  /** Without the query string. */
  path: string;
  query?: Record<string, string | number | boolean>;
  /** Extra non-secret headers (Accept, x-requested-with, …). Never Cookie or Authorization. */
  headers?: Record<string, string>;
}

/** A read-only search POST: the body is built by the mapper's code from the scan criteria. */
export interface BoardPostRequest {
  host: string;
  path: string;
  body: Record<string, unknown>;
  /** Only the endpoint's own `headers`, each with its recorded value. */
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
  /** Redirect hops one GET may follow (default MAX_REDIRECTS); 0: any 3xx is RedirectRefused, never requested. */
  maxRedirects?: number;
  userAgent?: string;
}

const PARAM = /:[A-Za-z_][A-Za-z0-9_]*(\(digits\))?/g;

/**
 * "/v1/jobs/:id" or "/viec-lam/:slug/:id.html": each ":name" matches one non-empty piece of a
 * segment; ":name(digits)" matches digits only ("/:jobSlug-:jobId(digits)-jv").
 */
export function matchesPathPattern(pattern: string, path: string): boolean {
  const escape = (p: string) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let source = "";
  let at = 0;
  for (const m of pattern.matchAll(PARAM)) {
    source += escape(pattern.slice(at, m.index)) + (m[1] ? "\\d+" : "[^/]+");
    at = m.index + m[0].length;
  }
  source += escape(pattern.slice(at));
  return new RegExp(`^${source}$`).test(path);
}

/** Redirect hops one request may follow. */
export const MAX_REDIRECTS = 3;

const sameHost = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** Headers a caller may never set: credentials come only from authHeaders (and never on a POST). */
const CREDENTIAL_HEADER = /^(cookie|authorization|proxy-authorization|csrf-token|x-csrf-token)$/i;
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
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
  private readonly searches: PostSearchEndpoint[];
  private readonly redactor: Redactor;

  constructor(private readonly opts: BoardApiClientOptions) {
    this.source = opts.record.source;
    this.allowed = opts.path === "public_api" ? usablePublicEndpoints(opts.record) : internalGetEndpoints(opts.record);
    // A POST search is an internal (account-API) endpoint only.
    this.searches = opts.path === "account_api" ? internalPostSearchEndpoints(opts.record) : [];
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
   * onRequest like any request. At most maxRedirects hops (default MAX_REDIRECTS); a hop that changes a
   * query value the request set is refused too; a refused hop throws EndpointNotAllowed.
   */
  async getPage(req: BoardRequest, signal?: AbortSignal): Promise<{ body: string; url: URL }> {
    if (req.path.includes("?") || req.path.includes("#")) throw new EndpointNotAllowed(this.source, "GET", req.host, req.path);
    this.endpointFor(req.host, req.path, Object.keys(req.query ?? {}));
    const credentialHeader = Object.keys(req.headers ?? {}).find((h) => CREDENTIAL_HEADER.test(h));
    if (credentialHeader) throw new EndpointNotAllowed(this.source, "GET", req.host, req.path, [], `a ${credentialHeader} header is never set by a reader`);
    const headers: Record<string, string> = { "User-Agent": this.opts.userAgent ?? BOARD_API_USER_AGENT, Accept: "application/json, text/html;q=0.9, */*;q=0.5", ...req.headers };
    if (this.opts.path === "account_api") Object.assign(headers, this.authHeaders());
    let url = new URL(`https://${req.host}${req.path}`);
    for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, String(v));
    const max = this.opts.maxBodyBytes ?? 8 * 1024 * 1024;
    const limit = this.opts.maxRedirects ?? MAX_REDIRECTS;
    for (let hop = 0; ; hop++) {
      this.opts.onRequest?.({ method: "GET", host: url.hostname, path: url.pathname });
      let answer: HttpAnswer;
      try {
        answer = await sendRequestNoRedirect({ fetch: this.opts.fetch, gate: this.opts.gate, url: url.toString(), headers, timeoutMs: this.opts.timeoutMs ?? 20_000, maxBodyBytes: max, ...(signal ? { signal } : {}) });
      } catch (err) {
        throw this.classify(err, url, "GET");
      }
      if (answer.kind === "body") return { body: answer.body, url };
      let next: URL | null = null;
      try {
        next = answer.location ? new URL(answer.location, url) : null;
      } catch {
        next = null;
      }
      // A reader that follows no redirect (LinkedIn): any 3xx is refused and its Location never requested.
      if (limit === 0) throw new RedirectRefused(this.source, next ?? url);
      if (hop >= limit) throw new BoardApiError("failed", `${url.hostname}${url.pathname} redirected more than ${limit} times`);
      if (!answer.location) throw new BoardApiError("failed", `${url.hostname}${url.pathname} answered HTTP ${answer.status} without a Location`);
      if (!next) throw new BoardApiError("failed", `${url.hostname}${url.pathname} redirected to an invalid URL`);
      // Another host, or plain http: refused (a cross-host hop would carry the board's headers).
      next.hash = "";
      if (next.protocol !== "https:" || !sameHost(next.hostname, url.hostname)) throw new RedirectRefused(this.source, next);
      try {
        this.endpointFor(next.hostname, next.pathname, [...new Set(next.searchParams.keys())]);
      } catch {
        throw new RedirectRefused(this.source, next);
      }
      // A hop may not change a query value the request set (e.g. ?start=0 → ?start=10: another page
      // the scan never asked for and never counted).
      const from = url;
      if ([...new Set(next.searchParams.keys())].some((k) => from.searchParams.has(k) && from.searchParams.getAll(k).join("\u0000") !== next.searchParams.getAll(k).join("\u0000"))) {
        throw new RedirectRefused(this.source, next);
      }
      url = next;
    }
  }

  /**
   * The record's POST search a request would hit, or EndpointNotAllowed: the exact host and path, and
   * a body and headers the record allows (see checkSearchBody). An apply endpoint is never matched.
   */
  searchEndpointFor(req: BoardPostRequest): PostSearchEndpoint {
    const refuse = (why?: string) => new EndpointNotAllowed(this.source, "POST", req.host, req.path, [], why);
    if (req.path.includes("?") || req.path.includes("#")) throw refuse();
    if (applyEndpointsOf(this.opts.record).some((e) => sameHost(e.host, req.host) && matchesPathPattern(e.pathPattern, req.path))) throw refuse();
    const endpoint = this.searches.find((e) => sameHost(e.host, req.host) && matchesPathPattern(e.pathPattern, req.path));
    if (!endpoint) throw refuse();
    const bad = checkSearchBody(endpoint, req.body) ?? checkSearchHeaders(endpoint, req.headers ?? {});
    if (bad) throw refuse(bad);
    return endpoint;
  }

  /**
   * One read-only search POST (JSON in, JSON text out). Everything is checked before any I/O
   * (searchEndpointFor); no credential is sent (the endpoint has requiresAuth: false); the request
   * takes its turn at the host gate like a GET, under the same body cap and redactor. A POST is never
   * redirected: any 3xx is an error and its Location is not requested.
   */
  async postSearch(req: BoardPostRequest, signal?: AbortSignal): Promise<string> {
    const endpoint = this.searchEndpointFor(req);
    const url = new URL(`https://${req.host}${req.path}`);
    const headers: Record<string, string> = {
      "User-Agent": this.opts.userAgent ?? BOARD_API_USER_AGENT,
      Accept: "application/json",
      "Content-Type": endpoint.contentType,
      ...req.headers,
    };
    this.opts.onRequest?.({ method: "POST", host: url.hostname, path: url.pathname });
    let answer: HttpAnswer;
    try {
      answer = await sendRequestNoRedirect({
        fetch: this.opts.fetch,
        gate: this.opts.gate,
        url: url.toString(),
        method: "POST",
        body: JSON.stringify(req.body),
        headers,
        timeoutMs: this.opts.timeoutMs ?? 20_000,
        maxBodyBytes: this.opts.maxBodyBytes ?? 8 * 1024 * 1024,
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      throw this.classify(err, url, "POST");
    }
    if (answer.kind === "redirect") throw new ApiChanged(url.hostname, url.pathname, `POST ${url.hostname}${url.pathname} answered HTTP ${answer.status} (a redirect; a search POST is never redirected)`, "POST");
    return answer.body;
  }

  /** A search POST whose answer is JSON. */
  async postSearchJson(req: BoardPostRequest, signal?: AbortSignal): Promise<unknown> {
    const body = await this.postSearch(req, signal);
    try {
      return JSON.parse(body) as unknown;
    } catch {
      if (isBotCheckPage(body)) throw new DirectReadBlocked(this.source, req.host, req.path);
      throw new ApiChanged(req.host, req.path, `${req.host}${req.path} did not answer JSON`, "POST");
    }
  }

  /** An HTTP failure as the client's error: 401/403 AuthRejected, 404/410 ApiChanged, else BoardApiError (redacted). */
  private classify(err: unknown, url: URL, method: "GET" | "POST"): unknown {
    if (!(err instanceof HttpRequestError)) return err;
    if (err.kind === "auth_rejected") return new AuthRejected(this.source, err.status ?? 401);
    const where = `${url.hostname}${url.pathname}`;
    if (err.status === 404 || err.status === 410) return new ApiChanged(url.hostname, url.pathname, `${method === "POST" ? "POST " : ""}${where} answered HTTP ${err.status}`, method);
    return new BoardApiError(err.kind, this.redactor.redact(err.status === null ? `could not reach ${where} (${err.detail})` : `${where} answered ${err.detail}`), err.status);
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

/**
 * Why a search body breaks its record, or null: only listed top-level keys; `userId` 0 (a guest);
 * `ranges` empty; `filter` items { field, value: string } with a listed field; `order` items
 * { field, value: "asc" | "desc" } with a listed field; `hitsPerPage` 1..maxPageSize; `page` a
 * non-negative integer; `retrieveFields` listed names; anything else a plain string, number or boolean.
 */
export function checkSearchBody(endpoint: PostSearchEndpoint, body: unknown): string | null {
  if (!isPlainObject(body)) return "the body is not a JSON object";
  for (const [key, value] of Object.entries(body)) {
    if (!endpoint.bodyKeys.includes(key)) return `body key ${key} is not listed`;
    switch (key) {
      case "userId":
        if (value !== 0) return "userId must be 0 (a guest search)";
        break;
      case "ranges":
        if (!Array.isArray(value) || value.length > 0) return "ranges must be empty";
        break;
      case "filter":
      case "order": {
        const fields = key === "filter" ? endpoint.filterFields : endpoint.orderFields;
        if (!Array.isArray(value)) return `${key} must be a list`;
        for (const item of value) {
          if (!isPlainObject(item) || Object.keys(item).sort().join() !== "field,value") return `a ${key} item must be { field, value }`;
          if (typeof item.field !== "string" || !fields.includes(item.field)) return `${key} field ${String(item.field)} is not listed`;
          if (typeof item.value !== "string" || (key === "order" && item.value !== "asc" && item.value !== "desc")) return `${key} ${item.field} has an invalid value`;
        }
        break;
      }
      case "hitsPerPage":
        if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > endpoint.maxPageSize) return `hitsPerPage must be 1 to ${endpoint.maxPageSize}`;
        break;
      case "page":
        if (!Number.isInteger(value) || (value as number) < 0) return "page must be a non-negative integer";
        break;
      case "retrieveFields":
        if (!Array.isArray(value)) return "retrieveFields must be a list";
        for (const f of value) if (typeof f !== "string" || !endpoint.retrieveFields.includes(f)) return `retrieved field ${String(f)} is not listed`;
        break;
      default:
        if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return `body key ${key} must be a plain value`;
    }
  }
  return null;
}

/** Why the headers break the record, or null: each must be one of the endpoint's, with its value. */
function checkSearchHeaders(endpoint: PostSearchEndpoint, headers: Record<string, string>): string | null {
  for (const [name, value] of Object.entries(headers)) {
    const listed = Object.entries(endpoint.headers).find(([n]) => n.toLowerCase() === name.toLowerCase());
    if (!listed || listed[1] !== value) return `header ${name} is not allowlisted`;
  }
  return null;
}
