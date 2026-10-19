// screenGuidanceUpdate (§5.5, AD-11; SEC-22, SEC-23): the only way drafts from the extraction task,
// or the seed, enter the rule set. Pure: the refresh time and the pages this refresh fetched are
// passed in. Nothing is ever removed or rewritten: a draft adds a source to a position, a position
// to a rule (the rule becomes disputed, REQ-32), or a new rule. A source's url, title and retrieval
// date come from the fetch, never from the model; a quote must occur in that page's text.
import { z } from "zod";
import {
  GUIDANCE_LIMITS,
  GuidanceRuleSetSchema,
  GuidanceTopicSchema,
  ruleText,
  type GuidanceMarket,
  type GuidancePosition,
  type GuidanceRule,
  type GuidanceRuleSet,
  type GuidanceSource,
  type GuidanceSourceKind,
} from "./schema.js";
import { plainText } from "./schema.js";
import { constraintsOverriding, evidenceInText, normaliseForMatch, screenStatement, slugFrom } from "./text.js";

/** What research.guidance_extract drafts (bots/research-guidance.ts holds the output schema). */
export const GuidanceDraftSchema = z
  .object({
    ruleId: z.string().min(1).nullable(),
    topic: GuidanceTopicSchema,
    point: z.string().min(1),
    positionId: z.string().min(1).nullable(),
    text: z.string().min(1),
    sourceUrl: z.string().min(1),
    evidence: z.string().min(1),
  })
  .strict();
export type GuidanceDraft = z.infer<typeof GuidanceDraftSchema>;

/** A page the orchestrator fetched in this refresh, reduced to plain text (SEC-20). */
export interface FetchedGuidancePage {
  /** The URL that was asked for (a source's url, or a discovered one). */
  url: string;
  /** Where the fetch ended after redirects (https, re-checked). */
  finalUrl: string;
  title: string | null;
  text: string;
  /** Registrable domain, by code. */
  host: string;
  kind: GuidanceSourceKind;
  market: GuidanceMarket;
  contentHash: string;
  etag: string | null;
  lastModified: string | null;
}

export interface GuidanceChange {
  kind: "rule_added" | "rule_changed";
  ruleId: string;
  point: string;
  /** Empty for an added rule. */
  previousText: string;
  newText: string;
  sourceIds: string[];
}

export interface RejectedGuidanceDraft {
  index: number;
  ruleId: string | null;
  reason: string;
}

export interface GuidanceScreenResult {
  ruleSet: GuidanceRuleSet;
  /** The set differs from `current` (rules, positions, sources or their fetch state). */
  changed: boolean;
  changes: GuidanceChange[];
  accepted: number;
  rejected: RejectedGuidanceDraft[];
}

const pointKey = (topic: string, point: string) => `${topic}:${normaliseForMatch(point).replace(/[^\p{L}\p{N}]+/gu, " ").trim()}`;
const textKey = (text: string) => normaliseForMatch(text).replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function uniqueId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

function sameUrl(a: string, b: string): boolean {
  const norm = (u: string) => {
    try {
      const x = new URL(u);
      x.hash = "";
      return `${x.protocol}//${x.hostname.toLowerCase()}${x.pathname.replace(/\/+$/, "")}${x.search}`;
    } catch {
      return u;
    }
  };
  return norm(a) === norm(b);
}

function overriddenBy(rule: Pick<GuidanceRule, "topic" | "positions">): GuidanceRule["overriddenBy"] {
  return [...new Set(rule.positions.flatMap((p) => constraintsOverriding(rule.topic, p.text)))].sort();
}

/**
 * Screen `drafts` against `current`. A rejected draft leaves the set unchanged for that draft
 * (REQ-29.AC-2); a page fetched in this refresh that belongs to a known source updates that
 * source's fetch state (hash, validators, title, retrieval date).
 */
export function screenGuidanceUpdate(
  current: GuidanceRuleSet,
  drafts: readonly unknown[],
  fetchedPages: readonly FetchedGuidancePage[],
  refreshedAt: string,
): GuidanceScreenResult {
  const set: GuidanceRuleSet = structuredClone(current);
  const rejected: RejectedGuidanceDraft[] = [];
  const touched = new Map<string, string>(); // rule id → text before (null marker for added)
  const added = new Set<string>();
  let accepted = 0;
  let changed = false;

  // Known sources fetched in this refresh: their fetch state follows the page.
  for (const page of fetchedPages) {
    const source = set.sources.find((s) => s.url !== null && (sameUrl(s.url, page.url) || sameUrl(s.url, page.finalUrl)));
    if (!source) continue;
    const next = { contentHash: page.contentHash, etag: page.etag, lastModified: page.lastModified, retrievedAt: refreshedAt, title: page.title ? plainText(page.title, GUIDANCE_LIMITS.titleChars) : source.title };
    if (source.contentHash !== next.contentHash || source.etag !== next.etag || source.lastModified !== next.lastModified) {
      Object.assign(source, next);
      changed = true;
    }
  }

  drafts.forEach((raw, index) => {
    const reject = (reason: string, ruleId: string | null = null) => rejected.push({ index, ruleId, reason });
    const parsed = GuidanceDraftSchema.safeParse(raw);
    if (!parsed.success) return reject(`the draft does not fit the rule schema (${parsed.error.issues[0]?.path.join(".") || "root"})`);
    const d = parsed.data;
    // Provenance first (SEC-23): a page this refresh fetched, and the quote is in its text.
    if (d.sourceUrl.trim() === "") return reject("the draft names no source (REQ-29.AC-2)", d.ruleId);
    const page = fetchedPages.find((p) => sameUrl(p.url, d.sourceUrl) || sameUrl(p.finalUrl, d.sourceUrl));
    if (!page) return reject("the source was not fetched in this refresh (SEC-23)", d.ruleId);
    if (d.evidence.length > GUIDANCE_LIMITS.textChars) return reject(`the quote has more than ${GUIDANCE_LIMITS.textChars} characters`, d.ruleId);
    if (!evidenceInText(d.evidence, page.text)) return reject("the quote is not in the fetched page's text (SEC-23)", d.ruleId);
    // Content (SEC-22).
    const text = d.text.trim();
    const problem = screenStatement(text);
    if (problem) return reject(problem, d.ruleId);

    let rule = d.ruleId ? set.rules.find((r) => r.id === d.ruleId) : undefined;
    if (d.ruleId && !rule) return reject(`unknown rule ${d.ruleId}`, d.ruleId);
    if (!rule) rule = set.rules.find((r) => pointKey(r.topic, r.point) === pointKey(d.topic, d.point));
    let isNew = false;
    if (!rule) {
      const pointProblem = screenStatement(d.point.trim());
      if (pointProblem) return reject(`the point: ${pointProblem}`);
      if (set.rules.length >= GUIDANCE_LIMITS.rules) return reject(`the rule set already holds ${GUIDANCE_LIMITS.rules} rules`);
      rule = {
        id: uniqueId(slugFrom(`${d.topic} ${d.point}`, 50), new Set(set.rules.map((r) => r.id))),
        topic: d.topic,
        point: plainText(d.point),
        // A new rule is judged by cv.review; deterministic checkers are attached by developers only.
        check: "judgement",
        appliesWhen: "always",
        overriddenBy: [],
        positions: [],
      };
      isNew = true;
    }

    // The source: an existing one for this URL, or a new one from the fetch (never from the model).
    let source = set.sources.find((s) => s.url !== null && (sameUrl(s.url, page.finalUrl) || sameUrl(s.url, page.url)));
    if (!source) {
      if (set.sources.length >= GUIDANCE_LIMITS.sources) return reject(`the rule set already holds ${GUIDANCE_LIMITS.sources} sources`, d.ruleId);
      if (!page.finalUrl.startsWith("https://")) return reject("the source is not https", d.ruleId);
      const fresh: GuidanceSource = {
        id: uniqueId(slugFrom(page.host.replace(/\.[^.]+$/, ""), 30), new Set(set.sources.map((s) => s.id))),
        title: page.title ? plainText(page.title, GUIDANCE_LIMITS.titleChars) : null,
        publisher: page.title ? null : page.host,
        url: page.finalUrl,
        repoPath: null,
        retrievedAt: refreshedAt,
        kind: page.kind,
        market: page.market,
        host: page.host,
        contentHash: page.contentHash,
        etag: page.etag,
        lastModified: page.lastModified,
      };
      set.sources.push(fresh);
      source = fresh;
    }

    // Same advice (named position or same words): add the source; else a new position.
    let position: GuidancePosition | undefined =
      (d.positionId ? rule.positions.find((p) => p.id === d.positionId) : undefined) ?? rule.positions.find((p) => textKey(p.text) === textKey(text));
    const before = ruleText(rule);
    const quote = plainText(d.evidence);
    if (position) {
      if (position.sourceIds.includes(source.id)) {
        // Already cited: nothing new (a re-extraction of an unchanged statement).
        accepted++;
        return;
      }
      position.sourceIds.push(source.id);
      position.evidence.push({ sourceId: source.id, quote });
    } else {
      if (rule.positions.length >= GUIDANCE_LIMITS.positionsPerRule) return reject(`rule ${rule.id} already has ${GUIDANCE_LIMITS.positionsPerRule} positions`, rule.id);
      position = {
        id: uniqueId(slugFrom(`${source.id} ${text}`, 40), new Set(set.rules.flatMap((r) => r.positions.map((p) => p.id)))),
        text: plainText(text),
        sourceIds: [source.id],
        evidence: [{ sourceId: source.id, quote }],
      };
      rule.positions.push(position);
    }
    // overriddenBy is set by code (SEC-22): a position allowing two pages gets over_one_page.
    rule.overriddenBy = overriddenBy(rule);
    if (isNew) {
      set.rules.push(rule);
      added.add(rule.id);
    } else if (!touched.has(rule.id) && !added.has(rule.id)) {
      touched.set(rule.id, before);
    }
    accepted++;
    changed = true;
  });

  const parsed = GuidanceRuleSetSchema.safeParse(set);
  if (!parsed.success) {
    // Defensive: a draft that would break the set's invariants never commits a half-valid set.
    return { ruleSet: current, changed: false, changes: [], accepted: 0, rejected: [...rejected, { index: -1, ruleId: null, reason: `the updated rule set is invalid: ${parsed.error.issues[0]?.message ?? "unknown"}` }] };
  }
  const changes: GuidanceChange[] = [];
  for (const rule of parsed.data.rules) {
    const sourceIds = [...new Set(rule.positions.flatMap((p) => p.sourceIds))];
    if (added.has(rule.id)) changes.push({ kind: "rule_added", ruleId: rule.id, point: rule.point, previousText: "", newText: ruleText(rule), sourceIds });
    // A changed statement, or a source that joined a position (same text, more sources).
    else if (touched.has(rule.id)) {
      changes.push({ kind: "rule_changed", ruleId: rule.id, point: rule.point, previousText: touched.get(rule.id)!, newText: ruleText(rule), sourceIds });
    }
  }
  return { ruleSet: parsed.data, changed, changes, accepted, rejected };
}

/**
 * At start (AD-10): what of the seed the current snapshot lacks (a source, a rule, a position or a
 * position's source), merged through the same content screen. Pinned positions are never rewritten;
 * a missing one is added back next to whatever a refresh added.
 */
export function mergeGuidanceSeed(current: GuidanceRuleSet, seed: GuidanceRuleSet): GuidanceScreenResult {
  const set: GuidanceRuleSet = structuredClone(current);
  const changes: GuidanceChange[] = [];
  const rejected: RejectedGuidanceDraft[] = [];
  let changed = false;
  for (const s of seed.sources) {
    if (!set.sources.some((x) => x.id === s.id)) {
      set.sources.push(structuredClone(s));
      changed = true;
    }
  }
  seed.rules.forEach((seedRule, index) => {
    const problem = [seedRule.point, ...seedRule.positions.map((p) => p.text)].map(screenStatement).find((p) => p !== null);
    if (problem) {
      rejected.push({ index, ruleId: seedRule.id, reason: problem });
      return;
    }
    const rule = set.rules.find((r) => r.id === seedRule.id);
    if (!rule) {
      const copy = structuredClone(seedRule);
      copy.overriddenBy = overriddenBy(copy);
      set.rules.push(copy);
      changes.push({ kind: "rule_added", ruleId: copy.id, point: copy.point, previousText: "", newText: ruleText(copy), sourceIds: [...new Set(copy.positions.flatMap((p) => p.sourceIds))] });
      changed = true;
      return;
    }
    const before = ruleText(rule);
    let touchedRule = false;
    for (const sp of seedRule.positions) {
      const p = rule.positions.find((x) => x.id === sp.id);
      if (!p) {
        if (rule.positions.length >= GUIDANCE_LIMITS.positionsPerRule) continue;
        rule.positions.push(structuredClone(sp));
        touchedRule = true;
        continue;
      }
      for (const id of sp.sourceIds) {
        if (p.sourceIds.includes(id)) continue;
        p.sourceIds.push(id);
        const e = sp.evidence.find((x) => x.sourceId === id);
        if (e) p.evidence.push({ ...e });
        touchedRule = true;
      }
    }
    if (touchedRule) {
      rule.overriddenBy = overriddenBy(rule);
      changes.push({ kind: "rule_changed", ruleId: rule.id, point: rule.point, previousText: before, newText: ruleText(rule), sourceIds: [...new Set(rule.positions.flatMap((p) => p.sourceIds))] });
      changed = true;
    }
  });
  const parsed = GuidanceRuleSetSchema.safeParse(set);
  if (!parsed.success) return { ruleSet: current, changed: false, changes: [], accepted: 0, rejected: [{ index: -1, ruleId: null, reason: `the merged rule set is invalid: ${parsed.error.issues[0]?.message ?? "unknown"}` }] };
  return { ruleSet: parsed.data, changed, changes, accepted: changes.length, rejected };
}

export const EMPTY_GUIDANCE_RULE_SET: GuidanceRuleSet = { sources: [], rules: [] };
