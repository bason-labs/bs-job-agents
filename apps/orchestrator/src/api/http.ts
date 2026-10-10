// HTTP plumbing shared by every route: JSON-only body parsing (with prototype-poisoning checks),
// the shared ApiError body for every error and for unknown routes, and request helpers.
import type { FastifyInstance } from "fastify";
import type { z } from "zod";
import { ApiHttpError, apiErrorBody, badRequest, notFound, toApiError, zodMessage } from "./errors.js";

declare module "fastify" {
  interface FastifyContextConfig {
    /** The route takes multipart/form-data (uploads) instead of JSON. */
    multipart?: boolean;
  }
}

/**
 * S18 JSON-only: the only body parser is JSON (text/plain is removed; multipart is added by the
 * uploads route alone). `__proto__` and `constructor.prototype` keys are refused, and an empty
 * body is no body (a bodyless POST that still says application/json).
 */
export function configureBodyParsing(app: FastifyInstance): void {
  const json = app.getDefaultJsonParser("error", "error");
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    if (typeof body === "string" && body.trim() === "") {
      done(null, undefined);
      return;
    }
    json(req, body, done);
  });
}

/** Every error and every unknown route answer with the shared ApiError body. */
export function registerErrorHandling(app: FastifyInstance): void {
  configureBodyParsing(app);
  app.setErrorHandler((err, req, reply) => {
    const { status, body } = toApiError(err);
    if (status >= 500) req.log.error({ err }, "request failed");
    void reply.status(status).type("application/json; charset=utf-8").send(body);
  });
  app.setNotFoundHandler((req, reply) => {
    void reply.status(404).type("application/json; charset=utf-8").send(apiErrorBody("not_found", `no route ${req.method} ${req.url.split("?")[0]}`));
  });
}

/** Validate a body, query or params object with a shared schema; 400 with the issues otherwise. */
export function parseWith<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw badRequest(zodMessage(r.error), r.error.issues);
  return r.data as z.output<S>;
}

/** A positive integer path id (SQLite rows); anything else is a 404, never a lookup. */
export function idParam(raw: unknown, what: string): number {
  if (typeof raw !== "string" || !/^[1-9]\d{0,15}$/.test(raw)) throw notFound(`${what} ${String(raw)} not found`);
  const id = Number(raw);
  if (!Number.isSafeInteger(id)) throw notFound(`${what} ${raw} not found`);
  return id;
}

/** Check what the API sends against the shared schema; a mismatch is a bug, answered as 500. */
export function respond<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw new ApiHttpError(500, "internal", `response does not match its schema: ${zodMessage(r.error)}`);
  return r.data as z.output<S>;
}

/**
 * S18 "list endpoints skip bad rows": each item is checked on its own; one that does not match the
 * shared schema is left out (and logged) instead of failing the whole list.
 */
export function keepValid<S extends z.ZodTypeAny>(schema: S, items: readonly unknown[], warn: (message: string) => void): z.output<S>[] {
  const out: z.output<S>[] = [];
  for (const item of items) {
    const r = schema.safeParse(item);
    if (r.success) out.push(r.data as z.output<S>);
    else warn(`left a bad row out of a list: ${zodMessage(r.error)}`);
  }
  return out;
}
