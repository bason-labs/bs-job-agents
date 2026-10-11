// Canonical posting URLs (W4a, UC-04 dedupe: "canonical URL"). Tracking parameters, fragments and
// board-specific suffixes are dropped so the same posting always has the same URL:
//   TopCV     https://www.topcv.vn/viec-lam/<slug>/<id>.html (or /brand/<b>/tuyen-dung/<slug>-j<id>.html)
//   ITviec    https://itviec.com/it-jobs/<slug>
//   LinkedIn  https://www.linkedin.com/jobs/view/<id>/
//   other     https, lowercase host, no utm_*/gh_src/ref/trk/source…, no trailing slash

//   VietnamWorks https://www.vietnamworks.com/<slug>-<id>-jv (W5)
//   Wellfound    https://wellfound.com/jobs/<id>-<slug> (W5)
//   Upwork       https://www.upwork.com/jobs/~<id> (W5; also from /freelance-jobs/apply/<slug>_~<id>/)

export type BoardSource = "topcv" | "itviec" | "linkedin" | "vietnamworks" | "wellfound" | "upwork";

export const BOARD_HOSTS: Record<BoardSource, readonly string[]> = {
  topcv: ["topcv.vn"],
  itviec: ["itviec.com"],
  linkedin: ["linkedin.com"],
  vietnamworks: ["vietnamworks.com"],
  wellfound: ["wellfound.com"],
  upwork: ["upwork.com"],
};

const TRACKING_PARAM = /^(utm_.*|gh_src|gh_jid|ref|refid|referrer|source|src|trk|trackingid|ta_source|u_sr_id|lab_feature|position|pagenum|fbclid|gclid|lever-source.*|lever-origin)$/i;

function parse(url: string): URL | null {
  try {
    const u = new URL(url.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

/** Is `host` the domain or one of its subdomains? */
export function hostIsOrUnder(host: string, domain: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return h === domain || h.endsWith(`.${domain}`);
}

/** The job board a URL belongs to, or null (a career site or anything else). */
export function sourceOfUrl(url: string): BoardSource | null {
  const u = parse(url);
  if (!u) return null;
  for (const [source, hosts] of Object.entries(BOARD_HOSTS) as [BoardSource, readonly string[]][]) {
    if (hosts.some((d) => hostIsOrUnder(u.hostname, d))) return source;
  }
  return null;
}

export function canonicalJobUrl(url: string): string | null {
  const u = parse(url);
  if (!u) return null;
  const source = sourceOfUrl(url);
  const path = u.pathname;

  if (source === "topcv") {
    const m = /^\/(viec-lam\/[^/]+\/\d+\.html|brand\/[^/]+\/tuyen-dung\/[^/]+-j\d+\.html)/.exec(path);
    if (m) return `https://www.topcv.vn/${m[1]}`;
  }
  if (source === "itviec") {
    const m = /^\/it-jobs\/([^/]+)(?:\/content)?\/?$/.exec(path);
    if (m) return `https://itviec.com/it-jobs/${m[1]}`;
  }
  if (source === "linkedin") {
    const m = /^\/jobs\/view\/(?:[^/]*-)?(\d{6,})\/?$/.exec(path);
    const id = m?.[1] ?? u.searchParams.get("currentJobId");
    if (id && /^\d+$/.test(id)) return `https://www.linkedin.com/jobs/view/${id}/`;
  }
  if (source === "vietnamworks") {
    const m = /^\/([a-z0-9-]+-\d+-jv)\/?$/i.exec(path);
    if (m) return `https://www.vietnamworks.com/${m[1]!.toLowerCase()}`;
  }
  if (source === "wellfound") {
    const m = /^\/jobs\/(\d+(?:-[a-z0-9-]+)?)\/?$/i.exec(path);
    if (m) return `https://wellfound.com/jobs/${m[1]!.toLowerCase()}`;
  }
  if (source === "upwork") {
    const m = /^\/(?:jobs\/(?:[^/]*_)?|freelance-jobs\/apply\/[^/]*_)(?:~|%7e)([0-9a-z]+)\/?$/i.exec(path);
    if (m) return `https://www.upwork.com/jobs/~${m[1]!.toLowerCase()}`;
  }

  const out = new URL(`https://${u.hostname.toLowerCase()}${path.replace(/\/+$/, "")}`);
  for (const [k, v] of u.searchParams) if (!TRACKING_PARAM.test(k)) out.searchParams.append(k, v);
  return out.toString();
}

/** UC-04's second dedupe key: company + title + location, folded. */
export function jobIdentityKey(job: { company: string; title: string; location: string }): string {
  const fold = (s: string) =>
    s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/đ/gi, "d")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  return [job.company, job.title, job.location].map(fold).join("|");
}
