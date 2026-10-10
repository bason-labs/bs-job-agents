// Dedupe keys for jobs (UC-04, §7.2 step 3): canonical URL and a
// company + title + location hash.
import { createHash } from "node:crypto";

const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "msclkid",
  "ref",
  "refid",
  "ref_src",
  "trk",
  "trkinfo",
  "trackingid",
  "tracking_id",
  "alternatechannel",
  "eba",
  "lipi",
  "ta_source",
  "lab_feature",
  "src",
  "source",
  "si",
  "igshid",
  "mc_cid",
  "mc_eid",
  "_hsenc",
  "_hsmi",
  "originalsubdomain",
]);

/**
 * Canonical form of a job URL: https, lower-case host without `www.`/`m.`, no
 * fragment, no tracking params (utm_*, trk, ta_source…), sorted query, no
 * trailing slash. LinkedIn job links collapse to `linkedin.com/jobs/view/<id>`.
 */
export function canonicalizeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return raw.trim().toLowerCase();
  }
  const host = url.hostname.toLowerCase().replace(/^(www\.|m\.)/, "");

  if (host === "linkedin.com" || host.endsWith(".linkedin.com")) {
    const fromQuery = url.searchParams.get("currentJobId");
    const fromPath = /\/jobs\/view\/(?:[^/]*?-)?(\d+)/.exec(url.pathname)?.[1];
    const id = fromPath ?? fromQuery;
    if (id) return `https://linkedin.com/jobs/view/${id}`;
  }

  const params = [...url.searchParams.entries()]
    .filter(([k]) => {
      const key = k.toLowerCase();
      return !key.startsWith("utm_") && !TRACKING_PARAMS.has(key);
    })
    .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : "";
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : "";
  return `https://${host}${path}${query}`;
}

/** Lower-case ASCII words: strips Vietnamese diacritics (đ → d) and punctuation. */
export function normalizeText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9+#]+/g, " ")
    .trim();
}

const COMPANY_SUFFIXES =
  /\b(cong ty|tnhh|co phan|cp|jsc|co|ltd|limited|llc|inc|corp|corporation|company|pte|plc|gmbh)\b/g;

/** Normalised company name: diacritics, punctuation and legal suffixes removed. */
export function companyKey(name: string): string {
  return normalizeText(name).replace(COMPANY_SUFFIXES, " ").replace(/\s+/g, " ").trim();
}

const LOCATION_ALIASES: [RegExp, string][] = [
  [/^(tp )?(hcm|hcmc|tphcm|ho chi minh|thanh pho ho chi minh|sai gon|saigon)( city)?$/, "ho chi minh"],
  [/^(tp )?(ha noi|hanoi|hn)( city)?$/, "ha noi"],
  [/^(tp )?(da nang|danang)( city)?$/, "da nang"],
];

export function locationKey(location: string | null | undefined): string {
  const norm = normalizeText(location).replace(/\s+/g, " ");
  for (const [re, canonical] of LOCATION_ALIASES) if (re.test(norm)) return canonical;
  return norm;
}

/** SHA-256 of normalised `company|title|location`. */
export function jobDedupeHash(input: { company: string; title: string; location?: string | null }): string {
  const key = [companyKey(input.company), normalizeText(input.title), locationKey(input.location)].join("|");
  return createHash("sha256").update(key).digest("hex");
}
