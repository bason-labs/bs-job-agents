// Search criteria (UC-21b, §7.5): the active Search Profile; saving creates a new active version.
// A run in progress keeps the version it started with (the engine pins it).
import {
  API_ROUTES,
  CriteriaResponseSchema,
  CriteriaUpdateRequestSchema,
  CriteriaVersionsResponseSchema,
} from "@bs-job-agents/shared";
import type { FastifyInstance } from "fastify";
import { createSearchProfile, getActiveSearchProfile, listSearchProfileVersions, mappers, updateSearchProfile } from "../../db/index.js";
import { requireDb, type ApiContext } from "../context.js";
import { notFound } from "../errors.js";
import { parseWith, respond } from "../http.js";

export function criteriaRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.get(API_ROUTES.criteria, async () => {
    const active = getActiveSearchProfile(requireDb(ctx));
    if (!active) throw notFound("there are no search criteria yet");
    return respond(CriteriaResponseSchema, mappers.toSearchProfile(active));
  });

  app.put(API_ROUTES.criteria, async (req) => {
    const db = requireDb(ctx);
    const fields = parseWith(CriteriaUpdateRequestSchema, req.body);
    const now = ctx.now();
    const saved = db.transaction((tx) =>
      getActiveSearchProfile(tx) ? updateSearchProfile(tx, fields, { now }) : createSearchProfile(tx, fields, { now }),
    );
    return respond(CriteriaResponseSchema, mappers.toSearchProfile(saved));
  });

  app.get(API_ROUTES.criteriaVersions, async () => {
    const db = requireDb(ctx);
    const active = getActiveSearchProfile(db);
    const versions = active ? listSearchProfileVersions(db, active.name) : [];
    return respond(CriteriaVersionsResponseSchema, {
      versions: versions.map((v) => ({ version: v.version, updatedAt: v.updatedAt, active: v.active })),
    });
  });
}
