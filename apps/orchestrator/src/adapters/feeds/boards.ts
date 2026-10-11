// The four feed boards (W5): request URLs and response parsers. Formats observed 2026-10-11 on the
// real responses in ../fixtures/{remoteok-api.json, weworkremotely-full-stack.rss, remotive-api.json,
// jobspresso-feed.rss}. Terms honoured: every posting links back to its page on the board, and the
// source is named on the card (job.source); the scanner caches responses and spaces requests.
//   Remote OK        GET https://remoteok.com/api                     JSON array (item 0 = legal notice)
//   We Work Remotely GET https://weworkremotely.com/categories/remote-<category>-jobs.rss   RSS
//   Remotive         GET https://remotive.com/api/remote-jobs?category=software-dev&limit=100  JSON
//                    (≤ 4 calls a day asked: one URL per scan, cached 6 h, filtered here)
//   Jobspresso       GET https://jobspresso.co/?feed=job_feed&search_keywords=<role>&posts_per_page=30  RSS
import type { FeedSource, SearchProfileFieldsBase } from "@bs-job-agents/shared";
import { canonicalJobUrl } from "../canonical-url.js";
import { htmlToText } from "../parsers/dom.js";
import { cleanText } from "../text.js";
import { decodeEntities, parseRssItems, rssDate } from "./rss.js";
import { FeedFormatError, type FeedAdapter, type FeedPosting } from "./types.js";

const HOUR = 3_600_000;

function isoOrNull(text: unknown): string | null {
  if (typeof text !== "string" && typeof text !== "number") return null;
  // Remotive's dates carry no zone ("2026-10-08T21:47:32"): they are UTC.
  const raw = typeof text === "string" && /T\d{2}:\d{2}(:\d{2})?$/.test(text) ? `${text}Z` : text;
  const t = typeof raw === "number" ? raw * 1000 : Date.parse(raw);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * Remote OK serves some text as UTF-8 read as Latin-1 ("weâ\u0080\u0099re", "aÂ contract"): such a
 * string (every character ≤ U+00FF, with the tell-tale Ã/Â/â sequences) is decoded again as UTF-8.
 */
export function fixMojibake(s: string): string {
  if (!/[ÂÃâ][\u0080-\u00BF]/.test(s) || [...s].some((c) => c.codePointAt(0)! > 0xff)) return s;
  const fixed = Buffer.from(s, "latin1").toString("utf8");
  return fixed.includes("\uFFFD") ? s : fixed;
}

const str = (v: unknown): string => (typeof v === "string" ? cleanText(decodeEntities(fixMojibake(v))) : "");

function posting(p: Omit<FeedPosting, "url"> & { url: unknown }): FeedPosting | null {
  const url = typeof p.url === "string" ? canonicalJobUrl(p.url) : null;
  if (!url || !p.title || !p.company) return null;
  return { ...p, url };
}

function usd(n: number): string {
  return `$${n.toLocaleString("en-US")}`;
}

// ---------------------------------------------------------------- Remote OK

export const remoteOkAdapter: FeedAdapter = {
  source: "remoteok",
  cacheTtlMs: HOUR,
  requests: () => [{ url: "https://remoteok.com/api", format: "json" }],
  parse(body) {
    const data: unknown = JSON.parse(body);
    if (!Array.isArray(data)) throw new FeedFormatError("Remote OK: expected a JSON array");
    const out: FeedPosting[] = [];
    for (const item of data as Record<string, unknown>[]) {
      // Item 0 is the API's legal notice (link back to Remote OK and name it as the source).
      if (!item || typeof item !== "object" || !("position" in item)) continue;
      const min = Number(item.salary_min) || 0;
      const max = Number(item.salary_max) || 0;
      const salaryText = min > 0 && max > 0 ? `${usd(min)} – ${usd(max)} a year` : min > 0 || max > 0 ? `${usd(min || max)} a year` : null;
      const p = posting({
        source: "remoteok",
        url: item.url,
        title: str(item.position),
        company: str(item.company),
        companyWebsite: null,
        regionText: str(item.location),
        salaryText,
        postedAt: isoOrNull(item.date) ?? isoOrNull(item.epoch),
        tags: Array.isArray(item.tags) ? item.tags.filter((t): t is string => typeof t === "string").map((t) => t.toLowerCase()) : [],
        jdText: htmlToText(typeof item.description === "string" ? fixMojibake(item.description) : ""),
      });
      if (p) out.push(p);
    }
    return out;
  },
};

// ---------------------------------------------------------------- We Work Remotely

/** WWR programming categories (observed 2026-10): the feeds a scan reads. */
export const WWR_CATEGORIES = ["remote-full-stack-programming-jobs", "remote-back-end-programming-jobs", "remote-front-end-programming-jobs"] as const;

export const weWorkRemotelyAdapter: FeedAdapter = {
  source: "weworkremotely",
  cacheTtlMs: HOUR,
  requests: () => WWR_CATEGORIES.map((c) => ({ url: `https://weworkremotely.com/categories/${c}.rss`, format: "rss" as const })),
  parse(body) {
    if (!/<rss\b/i.test(body)) throw new FeedFormatError("We Work Remotely: expected an RSS feed");
    const out: FeedPosting[] = [];
    for (const item of parseRssItems(body)) {
      // "<Company>: <Title>"
      const full = cleanText(item.title);
      const at = full.indexOf(": ");
      const company = at > 0 ? full.slice(0, at) : "";
      const title = at > 0 ? full.slice(at + 2) : full;
      const region = [item.region, item.country].map((s) => cleanText(s)).filter(Boolean).join(" · ");
      const p = posting({
        source: "weworkremotely",
        url: item.link || item.guid,
        title,
        company,
        companyWebsite: null,
        regionText: region,
        salaryText: null,
        postedAt: rssDate(item.pubdate),
        tags: [item.category, item.type, ...(item.skills ?? "").split(",")].map((t) => cleanText(t).toLowerCase()).filter(Boolean),
        jdText: htmlToText(item.description ?? ""),
      });
      if (p) out.push(p);
    }
    return out;
  },
};

// ---------------------------------------------------------------- Remotive

export const remotiveAdapter: FeedAdapter = {
  source: "remotive",
  // Remotive asks for at most 4 calls a day; its jobs are delayed 24 h anyway.
  cacheTtlMs: 6 * HOUR,
  requests: () => [{ url: "https://remotive.com/api/remote-jobs?category=software-dev&limit=100", format: "json" }],
  parse(body) {
    const data = JSON.parse(body) as { jobs?: unknown };
    if (!data || !Array.isArray(data.jobs)) throw new FeedFormatError("Remotive: expected { jobs: [...] }");
    const out: FeedPosting[] = [];
    for (const item of data.jobs as Record<string, unknown>[]) {
      const p = posting({
        source: "remotive",
        url: item.url,
        title: str(item.title),
        company: str(item.company_name),
        companyWebsite: null,
        regionText: str(item.candidate_required_location),
        salaryText: str(item.salary) || null,
        postedAt: isoOrNull(item.publication_date),
        tags: [item.category, item.job_type, ...(Array.isArray(item.tags) ? item.tags : [])].map((t) => str(t).toLowerCase().replace(/_/g, " ")).filter(Boolean),
        jdText: htmlToText(typeof item.description === "string" ? item.description : ""),
      });
      if (p) out.push(p);
    }
    return out;
  },
};

// ---------------------------------------------------------------- Jobspresso

/** At most this many keyword searches per scan (one per role). */
const JOBSPRESSO_MAX_SEARCHES = 3;

export const jobspressoAdapter: FeedAdapter = {
  source: "jobspresso",
  cacheTtlMs: HOUR,
  requests(criteria: SearchProfileFieldsBase) {
    const roles = [...new Set(criteria.roles.map((r) => cleanText(r.replace(/\(.*?\)/g, " "))).filter(Boolean))];
    const searches = roles.length > 0 ? roles.slice(0, JOBSPRESSO_MAX_SEARCHES) : [""];
    return searches.map((q) => {
      const params = new URLSearchParams({ feed: "job_feed", ...(q ? { search_keywords: q } : {}), posts_per_page: "30" });
      return { url: `https://jobspresso.co/?${params.toString()}`, format: "rss" as const };
    });
  },
  parse(body) {
    if (!/<rss\b/i.test(body)) throw new FeedFormatError("Jobspresso: expected an RSS feed");
    const out: FeedPosting[] = [];
    for (const item of parseRssItems(body)) {
      // dc:creator is "<Company><br>⚲&nbsp;<Location>"; job_listing:* carry the same, cleaner.
      const [creatorCompany, creatorPlace] = (item["dc:creator"] ?? "").split(/<br\s*\/?>/i).map((s) => cleanText(decodeEntities(s).replace(/^⚲\s*/, "")));
      const p = posting({
        source: "jobspresso",
        url: item.link,
        title: str(item.title),
        company: cleanText(item["job_listing:company"]) || creatorCompany || "",
        companyWebsite: null,
        regionText: cleanText(item["job_listing:location"]) || creatorPlace || "",
        salaryText: null,
        postedAt: rssDate(item.pubdate),
        tags: [item["job_listing:job_type"], item["job_listing:job_category"]].map((t) => cleanText(t).toLowerCase()).filter(Boolean),
        jdText: htmlToText(item["content:encoded"] || item.description || ""),
      });
      if (p) out.push(p);
    }
    return out;
  },
};

export const FEED_ADAPTERS: Record<FeedSource, FeedAdapter> = {
  remoteok: remoteOkAdapter,
  weworkremotely: weWorkRemotelyAdapter,
  remotive: remotiveAdapter,
  jobspresso: jobspressoAdapter,
};
