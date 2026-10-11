// Page URLs a Claude in Chrome session reported (PM2 S10, decision 10c): the site guard checks
// `navigate` before it runs, but a click that takes the tab to another site is no navigate call.
// The runner lists every page URL the Chrome tools reported so the engine can check them against
// the approval's domains after the run:
// - navigate: the URL its reply names (after redirects), else its target;
// - the tab tools (tabs_context_mcp, tabs_create_mcp): every tab URL they list;
// - any other Chrome tool: only a URL labelled as the page's ("URL: …") in the reply's first lines,
//   never a link inside page text.
// Only http(s) URLs of calls that succeeded count (a blocked navigate never reached its site).

const CHROME = "mcp__claude-in-chrome__";
const TAB_TOOLS = ["tabs_context_mcp", "tabs_create_mcp"];
const HEADER_LINES = 2;
const URL_RE = /https?:\/\/[^\s"'<>)\]\\]+/gi;
const LABELLED_RE = /^\s*(?:page\s+|current\s+|tab\s+)?url\s*[:=]\s*(https?:\/\/[^\s"'<>)\]\\]+)/i;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => (isObj(c) && typeof c.text === "string" ? c.text : "")).filter(Boolean).join("\n");
}

const trimUrl = (u: string): string => u.replace(/[.,;:!?]+$/, "");

function withScheme(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const v = raw.trim();
  const url = /^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v.replace(/^\/\//, "")}`;
  return /^https?:\/\//i.test(url) ? url : null;
}

/** One page a navigate call opened, and when the bot asked for it (W4a: LinkedIn's 3–8 s pauses). */
export interface PageVisit {
  url: string;
  /** ISO time the runner saw the navigate call. */
  at: string;
}

export class PageUrlCollector {
  private readonly seen = new Set<string>();
  readonly urls: string[] = [];
  /** Every successful navigate, in order, repeats included. */
  readonly visits: PageVisit[] = [];
  private readonly calls = new Map<string, { tool: string; input: unknown; at: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  push(line: string): void {
    if (!line.includes("tool_use") && !line.includes("tool_result")) return;
    let e: unknown;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    if (!isObj(e) || !isObj(e.message) || !Array.isArray(e.message.content)) return;
    for (const c of e.message.content) {
      if (!isObj(c)) continue;
      if (c.type === "tool_use" && typeof c.id === "string" && typeof c.name === "string" && c.name.startsWith(CHROME)) {
        this.calls.set(c.id, { tool: c.name.slice(CHROME.length), input: c.input, at: this.now() });
      } else if (c.type === "tool_result" && typeof c.tool_use_id === "string") {
        const call = this.calls.get(c.tool_use_id);
        if (!call || c.is_error === true) continue;
        this.fromResult(call, textOf(c.content));
      }
    }
  }

  private add(url: string): void {
    const u = trimUrl(url);
    if (!/^https?:\/\//i.test(u) || this.seen.has(u)) return;
    this.seen.add(u);
    this.urls.push(u);
  }

  private fromResult(call: { tool: string; input: unknown; at: number }, text: string): void {
    if (call.tool === "navigate") {
      const found = [...text.matchAll(URL_RE)].map((m) => m[0]);
      const target = withScheme((call.input as { url?: unknown } | null)?.url);
      if (found.length > 0) found.forEach((u) => this.add(u));
      else if (target) this.add(target);
      const reached = found.length > 0 ? trimUrl(found[0]!) : target;
      if (reached) this.visits.push({ url: reached, at: new Date(call.at).toISOString() });
      return;
    }
    if (TAB_TOOLS.includes(call.tool)) {
      for (const m of text.matchAll(URL_RE)) this.add(m[0]);
      return;
    }
    for (const line of text.split("\n").slice(0, HEADER_LINES)) {
      const m = LABELLED_RE.exec(line);
      if (m) this.add(m[1]!);
    }
  }
}
