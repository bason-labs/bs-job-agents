// A small, dependency-free HTML parser for the board-API readers (2026-10-20 addendum: LinkedIn's
// guest job fragments). The orchestrator has no DOM library at runtime (tests use jsdom), so this
// builds a light tree that satisfies dom.ts's DomRoot/DomElement, enough for the same helpers
// (textOf, attrOf, blockText). It is forgiving like a browser where the board's markup needs it:
// unknown end tags are ignored, an end tag closes every element opened inside it, <li> and <p>
// close an open one, void elements never nest, and script/style/textarea/title hold raw text.
// Selectors: tag, #id, .class, [attr], [attr="v"] (also ^= $= *= ~=), :not(<compound>), descendant
// (space) and child (>) combinators, comma lists. Nothing is ever fetched or run.
import type { DomElement, DomNode, DomRoot } from "./dom.js";

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);
/** Opening one of these closes an open <p> (as in a browser). */
const CLOSES_P = new Set(["address", "article", "aside", "blockquote", "div", "dl", "fieldset", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "main", "nav", "ol", "p", "pre", "section", "table", "ul"]);

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
  ndash: "–", mdash: "—", hellip: "…", bull: "•", middot: "·", copy: "©", reg: "®", trade: "™",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

class HtmlText implements DomNode {
  readonly nodeType = 3;
  readonly nodeName = "#text";
  readonly childNodes: DomNode[] = [];
  constructor(readonly textContent: string) {}
}

abstract class HtmlParent {
  readonly childNodes: (HtmlElement | HtmlText)[] = [];

  get textContent(): string {
    let out = "";
    for (const c of this.childNodes) out += c.textContent;
    return out;
  }

  querySelectorAll(selector: string): HtmlElement[] {
    const groups = parseSelector(selector);
    const out: HtmlElement[] = [];
    const walk = (n: HtmlParent) => {
      for (const c of n.childNodes) {
        if (!(c instanceof HtmlElement)) continue;
        if (groups.some((g) => matches(c, g, g.length - 1))) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector: string): HtmlElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

class HtmlElement extends HtmlParent implements DomElement {
  readonly nodeType = 1;
  readonly nodeName: string;

  constructor(
    readonly tag: string,
    readonly attrs: ReadonlyMap<string, string>,
    readonly parent: HtmlParent,
  ) {
    super();
    this.nodeName = tag.toUpperCase();
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name.toLowerCase()) ?? null;
  }

  get classes(): string[] {
    return (this.attrs.get("class") ?? "").split(/\s+/).filter(Boolean);
  }
}

class HtmlDocument extends HtmlParent implements DomRoot {
  readonly nodeType = 9;
  readonly nodeName = "#document";

  get title(): string {
    return this.querySelector("title")?.textContent ?? "";
  }
}

const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttrs(text: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const m of text.matchAll(ATTR)) {
    const name = m[1]!.toLowerCase();
    if (!attrs.has(name)) attrs.set(name, decodeEntities(m[2] ?? m[3] ?? m[4] ?? ""));
  }
  return attrs;
}

/** The index of the ">" that ends a tag starting at `from`, skipping quoted attribute values. */
function tagEnd(html: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < html.length; i++) {
    const c = html[i]!;
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ">") return i;
  }
  return -1;
}

/** Parse an HTML document or fragment into a queryable tree. */
export function parseHtml(html: string): DomRoot & { readonly textContent: string; readonly childNodes: ArrayLike<DomNode> } {
  const doc = new HtmlDocument();
  const stack: HtmlParent[] = [doc];
  const current = () => stack[stack.length - 1]!;
  const isOpen = (tag: string, stopAt: readonly string[] = []) => {
    for (let k = stack.length - 1; k > 0; k--) {
      const el = stack[k] as HtmlElement;
      if (el.tag === tag) return k;
      if (stopAt.includes(el.tag)) return -1;
    }
    return -1;
  };
  const text = (t: string) => {
    if (t) current().childNodes.push(new HtmlText(decodeEntities(t)));
  };
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      text(html.slice(i));
      break;
    }
    text(html.slice(i, lt));
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html[lt + 1] === "!" || html[lt + 1] === "?") {
      const end = html.indexOf(">", lt);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    const close = /^<\/([a-zA-Z][a-zA-Z0-9-]*)[^>]*>/.exec(html.slice(lt, lt + 200));
    if (close) {
      const k = isOpen(close[1]!.toLowerCase());
      if (k > 0) stack.length = k;
      i = lt + close[0].length;
      continue;
    }
    const open = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(html.slice(lt, lt + 100));
    if (!open) {
      text("<");
      i = lt + 1;
      continue;
    }
    const end = tagEnd(html, lt + open[0].length);
    if (end < 0) {
      text(html.slice(lt));
      break;
    }
    const tag = open[1]!.toLowerCase();
    const inner = html.slice(lt + open[0].length, end);
    i = end + 1;
    if (tag === "li") {
      const k = isOpen("li", ["ul", "ol"]);
      if (k > 0) stack.length = k;
    }
    if (CLOSES_P.has(tag)) {
      const k = isOpen("p", ["div", "section", "article", "li", "td", "ul", "ol"]);
      if (k > 0) stack.length = k;
    }
    const el = new HtmlElement(tag, parseAttrs(inner), current());
    current().childNodes.push(el);
    if (VOID.has(tag) || inner.trimEnd().endsWith("/")) continue;
    if (RAW_TEXT.has(tag)) {
      const stop = new RegExp(`</${tag}\\s*>`, "i").exec(html.slice(i));
      const body = stop ? html.slice(i, i + stop.index) : html.slice(i);
      if (body) el.childNodes.push(new HtmlText(tag === "script" || tag === "style" ? body : decodeEntities(body)));
      i = stop ? i + stop.index + stop[0].length : html.length;
      continue;
    }
    stack.push(el);
  }
  return doc;
}

// --- selectors ---------------------------------------------------------------------------------

interface AttrTest {
  name: string;
  op: "" | "=" | "^=" | "$=" | "*=" | "~=";
  value: string;
}

interface Compound {
  tag: string | null;
  id: string | null;
  classes: string[];
  attrs: AttrTest[];
  not: Compound[];
  /** How this compound relates to the one before it in the group. */
  combinator: " " | ">";
}

const IDENT = /^-?[_a-zA-Z][_a-zA-Z0-9-]*|^\*/;

function parseCompound(s: string, at: number, combinator: " " | ">"): [Compound, number] {
  const c: Compound = { tag: null, id: null, classes: [], attrs: [], not: [], combinator };
  const tag = IDENT.exec(s.slice(at));
  if (tag) {
    if (tag[0] !== "*") c.tag = tag[0].toLowerCase();
    at += tag[0].length;
  }
  for (;;) {
    const ch = s[at];
    if (ch === "." || ch === "#") {
      const name = IDENT.exec(s.slice(at + 1));
      if (!name) throw new Error(`bad selector: ${s}`);
      if (ch === ".") c.classes.push(name[0]);
      else c.id = name[0];
      at += 1 + name[0].length;
    } else if (ch === "[") {
      const m = /^\[\s*([^\s~^$*=\]]+)\s*(?:([~^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*)?\]/.exec(s.slice(at));
      if (!m) throw new Error(`bad selector: ${s}`);
      c.attrs.push({ name: m[1]!.toLowerCase(), op: (m[2] ?? "") as AttrTest["op"], value: m[3] ?? m[4] ?? m[5] ?? "" });
      at += m[0].length;
    } else if (s.startsWith(":not(", at)) {
      const [inner, next] = parseCompound(s, at + 5, " ");
      if (s[next] !== ")") throw new Error(`bad selector: ${s}`);
      c.not.push(inner);
      at = next + 1;
    } else break;
  }
  return [c, at];
}

const cache = new Map<string, Compound[][]>();

/** "a.b c > d, e" → one list of compounds per comma group. */
function parseSelector(selector: string): Compound[][] {
  const hit = cache.get(selector);
  if (hit) return hit;
  const groups: Compound[][] = [];
  let group: Compound[] = [];
  let at = 0;
  let combinator: " " | ">" = " ";
  const s = selector.trim();
  while (at < s.length) {
    const ch = s[at]!;
    if (/\s/.test(ch)) {
      at++;
      continue;
    }
    if (ch === ">") {
      combinator = ">";
      at++;
      continue;
    }
    if (ch === ",") {
      groups.push(group);
      group = [];
      combinator = " ";
      at++;
      continue;
    }
    const [compound, next] = parseCompound(s, at, combinator);
    if (next === at) throw new Error(`bad selector: ${selector}`);
    group.push(compound);
    combinator = " ";
    at = next;
  }
  if (group.length > 0) groups.push(group);
  cache.set(selector, groups);
  return groups;
}

function matchesCompound(el: HtmlElement, c: Compound): boolean {
  if (c.tag !== null && el.tag !== c.tag) return false;
  if (c.id !== null && el.getAttribute("id") !== c.id) return false;
  if (c.classes.length > 0) {
    const have = el.classes;
    if (!c.classes.every((k) => have.includes(k))) return false;
  }
  for (const a of c.attrs) {
    const v = el.getAttribute(a.name);
    if (v === null) return false;
    if (a.op === "=" && v !== a.value) return false;
    if (a.op === "^=" && !v.startsWith(a.value)) return false;
    if (a.op === "$=" && !v.endsWith(a.value)) return false;
    if (a.op === "*=" && !v.includes(a.value)) return false;
    if (a.op === "~=" && !v.split(/\s+/).includes(a.value)) return false;
  }
  return c.not.every((n) => !matchesCompound(el, n));
}

/** Does `el` match group[0..index], right to left? */
function matches(el: HtmlElement, group: Compound[], index: number): boolean {
  const c = group[index]!;
  if (!matchesCompound(el, c)) return false;
  if (index === 0) return true;
  let up: HtmlParent | null = el.parent;
  if (c.combinator === ">") return up instanceof HtmlElement && matches(up, group, index - 1);
  while (up instanceof HtmlElement) {
    if (matches(up, group, index - 1)) return true;
    up = up.parent;
  }
  return false;
}
