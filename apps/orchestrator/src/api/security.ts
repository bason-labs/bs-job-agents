// PM S18: the API is Ba's human gate (approve), and bots browse untrusted pages in Ba's own Chrome,
// so a page must never be able to drive it. Every request is checked before routing:
// - Host is the API's loopback address and port (DNS rebinding: a rebound name sends its own Host);
//   a request the web app's proxy forwards names the web app in X-Forwarded-Host.
// - Origin, when the browser sends one, is the web app's. No CORS headers are ever sent, so a
//   cross-origin fetch can neither read a response nor pass a preflight.
// - PM3 M2: every state change (POST/PUT/PATCH/DELETE) must carry the web app's Origin; a missing
//   one is refused like a foreign one, so a local process cannot approve a review card with a bare
//   POST. (Node can forge the header: this stops naive payloads; E1 option A is the real fix.)
// - Sec-Fetch-Site: cross-site is refused even without an Origin.
// - Every state-changing request carries the shared CSRF header, which a form cannot set and a
//   cross-origin fetch cannot send without the preflight the API never answers.
// - Bodies are JSON only (multipart only on routes that say so).
// Responses get nosniff, no-store, no referrer, same-origin resources and a closed CSP.
import { CSRF_HEADER, CSRF_HEADER_VALUE } from "@bs-job-agents/shared";
import type { IncomingHttpHeaders } from "node:http";
import type { FastifyInstance } from "fastify";
import { ApiHttpError, forbidden } from "./errors.js";

export interface SecurityOptions {
  /** The port the API listens on: Host must name it. A function, because tests listen on port 0. */
  port: () => number;
  /** The web app's origins, e.g. http://localhost:3000. */
  webOrigins: readonly string[];
}

const MUTATIONS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Host header values the API answers on `port`. */
export function loopbackHosts(port: number): Set<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
}

const header = (headers: IncomingHttpHeaders, name: string): string | undefined => {
  const v = headers[name];
  return Array.isArray(v) ? v.join(",") : v;
};

function originOf(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.origin === "null" ? null : url.origin;
  } catch {
    return null;
  }
}

export interface RequestFacts {
  method: string;
  headers: IncomingHttpHeaders;
  /** The route takes multipart/form-data. */
  multipart: boolean;
}

/** Why a request is refused, or null. Pure, so each rule has its own test. */
export function checkRequest(r: RequestFacts, opts: SecurityOptions): ApiHttpError | null {
  const apiHosts = loopbackHosts(opts.port());
  const host = header(r.headers, "host")?.trim().toLowerCase();
  if (!host || !apiHosts.has(host)) {
    return forbidden(`this API answers only on 127.0.0.1:${opts.port()} (Host ${host ?? "missing"} refused)`);
  }
  const webHosts = new Set(opts.webOrigins.map((o) => new URL(o).host.toLowerCase()));
  const forwarded = header(r.headers, "x-forwarded-host");
  if (forwarded !== undefined) {
    for (const h of forwarded.split(",").map((s) => s.trim().toLowerCase())) {
      if (!webHosts.has(h) && !apiHosts.has(h)) return forbidden(`a request forwarded for ${h} is refused; only the web app may proxy the API`);
    }
  }
  const origin = header(r.headers, "origin");
  if (origin !== undefined) {
    const o = originOf(origin.trim());
    if (o === null || !opts.webOrigins.includes(o)) return forbidden(`requests from ${origin} are refused; only the web app may call the API`);
  }
  if (header(r.headers, "sec-fetch-site")?.toLowerCase() === "cross-site") {
    return forbidden("cross-site requests are refused");
  }
  if (!MUTATIONS.has(r.method.toUpperCase())) return null;
  // PM3 M2: a browser always sends Origin on a state change, and the web app's proxy forwards it.
  // Without one the caller is a local process (curl, Node fetch, a bot's REPL), never Ba's click.
  if (origin === undefined) {
    return forbidden("a state-changing request needs the web app's Origin; only the web app may change anything");
  }
  if (header(r.headers, CSRF_HEADER) !== CSRF_HEADER_VALUE) {
    return forbidden(`a state-changing request needs the ${CSRF_HEADER}: ${CSRF_HEADER_VALUE} header`);
  }
  const length = header(r.headers, "content-length");
  const hasBody = (length !== undefined && length.trim() !== "0") || header(r.headers, "transfer-encoding") !== undefined;
  if (!hasBody) return null;
  const type = (header(r.headers, "content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const wanted = r.multipart ? "multipart/form-data" : "application/json";
  if (type !== wanted) {
    return new ApiHttpError(415, "validation_failed", r.multipart ? "send the files as multipart/form-data" : "send the body as JSON (application/json)");
  }
  return null;
}

/** Headers every response carries (a route may set its own CSP or frame rule first, e.g. files). */
function securityHeaders(reply: { header(k: string, v: string): unknown; hasHeader(k: string): boolean }): void {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("Cross-Origin-Resource-Policy", "same-origin");
  if (!reply.hasHeader("Cache-Control")) reply.header("Cache-Control", "no-store");
  if (!reply.hasHeader("Content-Security-Policy")) reply.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; sandbox");
  if (!reply.hasHeader("X-Frame-Options")) reply.header("X-Frame-Options", "DENY");
}

export function registerSecurity(app: FastifyInstance, opts: SecurityOptions): void {
  app.addHook("onRequest", async (req) => {
    const refusal = checkRequest({ method: req.method, headers: req.headers, multipart: req.routeOptions.config?.multipart === true }, opts);
    if (refusal) throw refusal;
  });
  app.addHook("onSend", async (_req, reply, payload) => {
    securityHeaders(reply);
    return payload;
  });
}

export { securityHeaders };
