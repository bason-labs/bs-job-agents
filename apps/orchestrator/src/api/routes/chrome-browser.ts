// Live 2026-10-20: the Chrome browser bots use when several Claude in Chrome extensions are
// connected (Bots screen). GET lists the browsers the bots' Chrome tools reported and the choice;
// PUT sets it to one of those (by deviceId) or clears it. The engine passes the choice to every
// browser task: select_browser for that deviceId only (site guard), and a prompt line.
import { API_ROUTES, ChromeBrowserUpdateSchema, ChromeBrowserViewSchema, type ChromeBrowserView } from "@bs-job-agents/shared";
import type { FastifyInstance } from "fastify";
import { getPreferredBrowser, listSeenBrowsers, setPreferredBrowser, type Conn } from "../../db/index.js";
import { requireDb, type ApiContext } from "../context.js";
import { conflict } from "../errors.js";
import { parseWith, respond } from "../http.js";

export function chromeBrowserView(db: Conn): ChromeBrowserView {
  return { preferred: getPreferredBrowser(db), seen: listSeenBrowsers(db) };
}

export function chromeBrowserRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.get(API_ROUTES.chromeBrowser, async () => respond(ChromeBrowserViewSchema, chromeBrowserView(requireDb(ctx))));

  app.put(API_ROUTES.chromeBrowser, async (req) => {
    const db = requireDb(ctx);
    const { deviceId } = parseWith(ChromeBrowserUpdateSchema, req.body);
    if (deviceId === null) {
      setPreferredBrowser(db, null, { now: ctx.now() });
    } else {
      // Only a browser a bot's Chrome tools reported: never an id typed in.
      const seen = listSeenBrowsers(db).find((b) => b.deviceId === deviceId);
      if (!seen) throw conflict(`no connected browser ${deviceId} was reported by the bots`);
      const { seenAt: _s, ...browser } = seen;
      setPreferredBrowser(db, browser, { now: ctx.now() });
    }
    return respond(ChromeBrowserViewSchema, chromeBrowserView(db));
  });
}
