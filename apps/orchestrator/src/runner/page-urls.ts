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

/**
 * Tab ids in a Chrome tool reply, whatever its shape (the real format is not pinned down): JSON
 * `{"tabId": 7}` / `tab_id`, "Tab ID: 7", "tabId 7", "id=7".
 */
export function tabIdsIn(text: string): string[] {
  const out = new Set<string>();
  for (const re of [/"?tab_?id"?\s*[:=]\s*"?(\d+)/gi, /\btab\s*id\s*[:#=]?\s*(\d+)/gi, /\btabid\s+(\d+)/gi, /(?:^|[\s,{(])"?id"?\s*[=:]\s*"?(\d+)/gi]) {
    for (const m of text.matchAll(re)) out.add(m[1]!);
  }
  return [...out];
}

/** A not-found page: a navigate reply or the start of the page's text says 404 or "not found" (EN, VI). */
const NOT_FOUND = /\b404\b|\bpage not found\b|\bnot found\b|không tìm thấy trang|trang không tồn tại|trang bạn tìm kiếm không tồn tại/i;

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
  /**
   * Skill self-repair (QA M-b): pages the bot really opened in a tab it created in this task: a
   * navigate in such a tab whose reply names the page it reached (that URL, in order, repeats
   * included). Never a tab listing of Ba's own tabs, never a navigate target the reply did not confirm.
   */
  readonly opened: string[] = [];
  /** Confirmed navigates that could not be attributed to the bot's own tab (a reply format mismatch shows here). */
  unattributed = 0;
  private readonly ownTabs = new Set<string>();
  /** Per tab: where its last opened page sits in `opened` (a later not-found page text removes it). */
  private readonly lastOpened = new Map<string, number>();
  /** Ba's tabs: the ids the task's first tabs_context_mcp reply listed (null until it came). */
  private baTabs: Set<string> | null = null;
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

  /**
   * Whether a confirmed navigate ran in the bot's own tab: a tab its tabs_create_mcp reply named;
   * failing that, a tab not among Ba's tabs of the first tabs_context_mcp listing; when neither
   * reply gave any id, every confirmed navigate (a tab listing alone never counts).
   */
  private ownTab(tab: string | null): boolean {
    if (this.ownTabs.size > 0) return tab !== null && this.ownTabs.has(tab);
    if (this.baTabs !== null && this.baTabs.size > 0) return tab !== null && !this.baTabs.has(tab);
    return true;
  }

  private add(url: string): void {
    const u = trimUrl(url);
    if (!/^https?:\/\//i.test(u) || this.seen.has(u)) return;
    this.seen.add(u);
    this.urls.push(u);
  }

  private fromResult(call: { tool: string; input: unknown; at: number }, text: string): void {
    if (call.tool === "tabs_create_mcp") {
      const ids = tabIdsIn(text);
      for (const id of ids.length > 0 ? ids : [/\btab\s+(\d+)\b/i.exec(text)?.[1]].filter((x): x is string => Boolean(x))) this.ownTabs.add(id);
    }
    if (call.tool === "tabs_context_mcp" && this.baTabs === null) this.baTabs = new Set(tabIdsIn(text).filter((id) => !this.ownTabs.has(id)));
    if (call.tool === "navigate") {
      const found = [...text.matchAll(URL_RE)].map((m) => m[0]);
      if (found.length > 0) {
        const raw = (call.input as { tabId?: unknown } | null)?.tabId;
        const tab = typeof raw === "number" || typeof raw === "string" ? String(raw) : null;
        if (NOT_FOUND.test(text)) {
          // A 404 page was reached, not a posting: it never counts as opened.
        } else if (this.ownTab(tab)) {
          this.opened.push(trimUrl(found[0]!));
          if (tab !== null) this.lastOpened.set(tab, this.opened.length - 1);
        } else this.unattributed++;
      }
      const target = withScheme((call.input as { url?: unknown } | null)?.url);
      if (found.length > 0) found.forEach((u) => this.add(u));
      else if (target) this.add(target);
      const reached = found.length > 0 ? trimUrl(found[0]!) : target;
      if (reached) this.visits.push({ url: reached, at: new Date(call.at).toISOString() });
      return;
    }
    // The page text of a tab's last opened page shows a not-found page: that page is not opened.
    if ((call.tool === "get_page_text" || call.tool === "read_page") && NOT_FOUND.test(text.slice(0, 400))) {
      const raw = (call.input as { tabId?: unknown } | null)?.tabId;
      const at = this.lastOpened.get(String(raw));
      if (at !== undefined) {
        this.opened.splice(at, 1);
        this.lastOpened.delete(String(raw));
        for (const [k, v] of this.lastOpened) if (v > at) this.lastOpened.set(k, v - 1);
      }
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
