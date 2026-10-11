// A small RSS 2.0 reader for the job feeds (We Work Remotely, Jobspresso): items → their child
// elements' text, CDATA unwrapped and XML entities decoded. No DOM and no dependency: the feeds are
// flat (<item><title>…</title><link>…</link>…</item>), and anything odd is simply left out.

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** XML/HTML entities (&amp;, &#038;, &#x27;, &nbsp;) → characters. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED[ref.toLowerCase()] ?? whole;
  });
}

/** An element's text: CDATA sections kept as is, the rest entity-decoded. */
function elementText(raw: string): string {
  let out = "";
  let rest = raw;
  for (;;) {
    const start = rest.indexOf("<![CDATA[");
    if (start < 0) {
      out += decodeEntities(rest);
      break;
    }
    out += decodeEntities(rest.slice(0, start));
    const end = rest.indexOf("]]>", start);
    if (end < 0) {
      out += rest.slice(start + 9);
      break;
    }
    out += rest.slice(start + 9, end);
    rest = rest.slice(end + 3);
  }
  return out.trim();
}

export type RssItem = Record<string, string>;

/**
 * Every <item> of the feed: element name (with its namespace prefix, e.g. "content:encoded",
 * "job_listing:company") → text. A repeated element keeps its first value.
 */
export function parseRssItems(xml: string): RssItem[] {
  const items: RssItem[] = [];
  for (const m of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const item: RssItem = {};
    for (const el of m[1]!.matchAll(/<([a-z][\w.-]*(?::[\w.-]+)?)\b[^>]*?(?:\/>|>([\s\S]*?)<\/\1>)/gi)) {
      const name = el[1]!.toLowerCase();
      if (!Object.hasOwn(item, name)) item[name] = elementText(el[2] ?? "");
    }
    items.push(item);
  }
  return items;
}

/** RSS dates ("Sun, 11 Oct 2026 07:31:07 +0000") → ISO, or null. */
export function rssDate(text: string | undefined): string | null {
  if (!text) return null;
  const t = Date.parse(text);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}
