// Bots screen (§11 Bots, UC-19, PM S21). Ba's changes are refused when they break a Phase 1 rule:
// - engine: checkBotSafety (§4.4 a browser bot that writes runs on Claude, where the site guard is a
//   hook; §6.2 a Figma bot runs on Claude, where the Drafts-only guard is a hook) — so Apply and CV
//   stay on Claude. A queued task keeps the engine it was queued on; the runner checks again.
// - trust level: never above the Phase 1 cap (Apply: L1, every submit needs Ba's token), and up one
//   level at a time (a promotion, or restoring a demoted bot); lowering is always allowed.
import { join } from "node:path";
import { API_ROUTES, BotUpdateRequestSchema, BotViewSchema, BotsResponseSchema, checkBotSafety, maxTrustLevel, type BotDefinition, type BotView } from "@bs-job-agents/shared";
import type { FastifyInstance } from "fastify";
import { appendMemoryChange, getBot, latestBotDemotion, listBots, syncBotFromDefinition, updateBot, type Bot, type Db } from "../../db/index.js";
import { removeMemoryNote } from "../../runner/index.js";
import { emitEvent, requireDb, type ApiContext } from "../context.js";
import { conflict, forbidden, notFound } from "../errors.js";
import { keepValid, parseWith, respond } from "../http.js";
import { updateApiState } from "../state.js";
import { botMemoryNotes, botView, promotionStreak } from "../views/bots.js";

type NameParams = { Params: { name: string } };

function trustRefusal(name: string, from: number, to: number): string | null {
  if (to <= from) return null;
  const cap = maxTrustLevel(name);
  if (to > cap) {
    return name === "apply"
      ? "Apply stays at L1 in Phase 1: every submit needs Ba's approval (UC-19)"
      : `${name} may be at most L${cap} in Phase 1`;
  }
  if (to > from + 1) return `raise ${name}'s trust level one step at a time (L${from} → L${from + 1})`;
  return null;
}

export function botRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const defOf = (name: string): BotDefinition | undefined => ctx.bots?.get(name);
  const viewOf = (db: Db, def: BotDefinition | undefined, row: Bot | undefined) =>
    botView(db, { botsDir: ctx.config.botsDir, dataDir: ctx.config.dataDir, workflows: ctx.workflows ?? ctx.engine?.deps.workflows ?? null }, def, row);

  app.get(API_ROUTES.bots, async () => {
    const db = requireDb(ctx);
    const rows = new Map(listBots(db).map((r) => [r.name, r]));
    const names = [...new Set([...rows.keys(), ...(ctx.bots?.list().map((d) => d.name) ?? [])])].sort();
    const views = names.map((n) => viewOf(db, defOf(n), rows.get(n))).filter((v) => v !== null);
    return respond(BotsResponseSchema, { bots: keepValid(BotViewSchema, views, (m) => ctx.log.warn(m)) });
  });

  app.get<NameParams>(API_ROUTES.bot, async (req) => {
    const db = requireDb(ctx);
    const view = viewOf(db, defOf(req.params.name), getBot(db, req.params.name));
    if (!view) throw notFound(`bot ${req.params.name} not found`);
    return respond(BotViewSchema, view);
  });

  app.patch<NameParams>(API_ROUTES.bot, async (req) => {
    const db = requireDb(ctx);
    const name = req.params.name;
    const patch = parseWith(BotUpdateRequestSchema, req.body);
    const def = defOf(name);
    let row = getBot(db, name);
    if (!def && !row) throw notFound(`bot ${name} not found`);
    if (patch.engine !== undefined && patch.engine !== (row?.engine ?? def?.engine)) {
      if (!def) throw conflict(`bots/${name}/bot.json is not loaded, so its engine cannot be checked`);
      const issues = checkBotSafety({ ...def, engine: patch.engine });
      if (issues.length > 0) throw forbidden(issues.join("; "));
    }
    if (patch.trustLevel !== undefined) {
      const refusal = trustRefusal(name, row?.trustLevel ?? def!.trustLevel, patch.trustLevel);
      if (refusal) throw forbidden(refusal);
    }
    // PM2 S8: raising a demoted bot back to the level its demotion took is a restore; the engine
    // closes the demotion (capped at the Phase 1 limit) and announces it.
    const demotion = row && patch.trustLevel !== undefined && patch.trustLevel > row.trustLevel ? latestBotDemotion(db, name) : undefined;
    const restore = ctx.engine && demotion && patch.trustLevel === Math.min(demotion.fromLevel, maxTrustLevel(name));
    if (restore) ctx.engine!.restoreBot(name);
    const rest = restore ? { ...patch, trustLevel: undefined } : patch;
    row = db.transaction((tx) => {
      // A bot.json the engine has not synced yet (degraded start) gets its row first.
      if (!getBot(tx, name) && def) {
        syncBotFromDefinition(tx, { name, displayName: def.displayName, engine: def.engine, trustLevel: def.trustLevel, model: def.model, promptVersion: def.promptVersion, enabled: def.enabled });
      }
      const fields = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
      return Object.keys(fields).length > 0 ? updateBot(tx, name, fields) : getBot(tx, name)!;
    });
    const view = viewOf(db, def, row)!;
    emitUpdated(view);
    return respond(BotViewSchema, view);
  });

  const emitUpdated = (view: BotView) =>
    emitEvent(ctx, {
      type: "bot.updated",
      botName: view.name,
      engine: view.engine,
      trustLevel: view.trustLevel,
      enabled: view.enabled,
      activity: view.activity,
      promotionSuggested: view.promotionSuggested,
    });

  const existing = (db: Db, name: string) => {
    const def = defOf(name);
    const row = getBot(db, name);
    if (!def && !row) throw notFound(`bot ${name} not found`);
    return { def, row };
  };

  // PM S14: Ba deletes one memory note (a poisoned note would reach every later prompt). The
  // deletion runs under the same per-bot lock as the engine's memory appends (rule 2: one write at
  // a time, so a delete never loses a note appended at the same moment, nor brings the deleted
  // one back) and is recorded in memory_changes like every memory write.
  app.delete<{ Params: { name: string; noteId: string } }>(API_ROUTES.botMemoryNote, async (req) => {
    const db = requireDb(ctx);
    const { name, noteId } = req.params;
    const { def, row } = existing(db, name);
    const text = /^[a-z][a-z0-9-]*$/.test(name) ? botMemoryNotes(ctx.config.botsDir, name).find((n) => n.id === noteId)?.text : undefined;
    const removed =
      text === undefined
        ? null
        : await removeMemoryNote({
            botDir: join(ctx.config.botsDir, name),
            noteId,
            onRemoved: () => void appendMemoryChange(db, { botName: name, note: `deleted by Ba: ${text}` }, { now: ctx.now() }),
          });
    if (removed === null) throw notFound(`bot ${name} has no memory note ${noteId}`);
    const view = viewOf(db, def, row)!;
    emitUpdated(view);
    return respond(BotViewSchema, view);
  });

  // UC-19: Ba dismisses a promotion suggestion; it returns after another full streak.
  app.post<NameParams>(API_ROUTES.botPromotionDismiss, async (req) => {
    const db = requireDb(ctx);
    const name = req.params.name;
    const { def, row } = existing(db, name);
    const before = viewOf(db, def, row)!;
    if (!before.promotionSuggested) throw conflict(`there is no promotion suggestion for ${name}`);
    const count = promotionStreak(db, ctx.workflows ?? ctx.engine?.deps.workflows ?? null, name);
    updateApiState(ctx.config.dataDir, (s) => ({ ...s, promotionDismissals: { ...s.promotionDismissals, [name]: { count, at: ctx.now().toISOString() } } }));
    const view = viewOf(db, def, row)!;
    emitUpdated(view);
    return respond(BotViewSchema, view);
  });
}
