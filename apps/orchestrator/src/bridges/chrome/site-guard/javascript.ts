// Site guard for `javascript_tool` code (spec §4.4: "the hook also checks javascript_tool code
// for navigation"). The code runs in the page, so besides navigation it can send data anywhere;
// the guard therefore checks every way page code can reach another origin that it can see
// statically, and blocks what it cannot verify.
//
// Caught: location writes (location=, .href, .assign/.replace, host/hostname/protocol), window.open,
// navigation.navigate, history.pushState/replaceState URLs, fetch/XMLHttpRequest/sendBeacon/
// WebSocket/EventSource/Worker/Request/import(), src/href/action/srcset/poster/ping writes and
// setAttribute, markup sinks (innerHTML, outerHTML, insertAdjacentHTML, document.write) with URLs,
// meta refresh, inline `on…=` handlers or dynamic content, CSS url(), cookies, eval/Function/
// string timers and `.constructor` (the Function constructor without its name), dynamic property
// access on window/location/document, `with`, Reflect/Object writes to those objects, form submit,
// postMessage, script/iframe creation. Simple aliases (`const l = location`, destructuring,
// `.bind`, `.call`) are followed.
// Not caught (residual risk): clicks on links (`a.click()`, the computer tool), values hidden in
// data structures or returned from functions, string timers built from variables, and anything
// obfuscated beyond what static analysis can follow. Apply runs without javascript_tool.
import type { AnyNode, Expression, Pattern, Program, SpreadElement } from "acorn";
import { collectStringConstants, isReference, parseJs, staticPropName, staticValue, visit } from "../../js/ast.js";
import type { StaticValue } from "../../js/ast.js";
import type { GuardDecision } from "../../hooks/protocol.js";
import { hostAllowed } from "./allowlist.js";
import { checkPageUrlValue, describeAllowlist } from "./url.js";

type Kind =
  | "window"
  | "location"
  | "document"
  | "history"
  | "navigator"
  | "navigation"
  | "fn:navigate"
  | "fn:open"
  | "fn:fetch"
  | "fn:beacon"
  | "fn:eval"
  | "fn:timer"
  | "fn:pushState"
  | "fn:historyNav"
  | "fn:reload"
  | "fn:docWrite"
  | "fn:docOpen"
  | "fn:postMessage"
  | "ctor:url"
  | "ctor:ws"
  | "ctor:xhr"
  | "ns:reflect"
  | "ns:object"
  | "cookie"
  | "cookieStore";

const GLOBALS = new Map<string, Kind>([
  ["window", "window"],
  ["self", "window"],
  ["top", "window"],
  ["parent", "window"],
  ["globalThis", "window"],
  ["frames", "window"],
  ["opener", "window"],
  ["location", "location"],
  ["document", "document"],
  ["history", "history"],
  ["navigator", "navigator"],
  ["navigation", "navigation"],
  ["fetch", "fn:fetch"],
  ["importScripts", "fn:fetch"],
  ["open", "fn:open"],
  ["eval", "fn:eval"],
  ["Function", "fn:eval"],
  ["execScript", "fn:eval"],
  ["setTimeout", "fn:timer"],
  ["setInterval", "fn:timer"],
  ["postMessage", "fn:postMessage"],
  ["WebSocket", "ctor:ws"],
  ["EventSource", "ctor:url"],
  ["Worker", "ctor:url"],
  ["SharedWorker", "ctor:url"],
  ["Request", "ctor:url"],
  ["Audio", "ctor:url"],
  ["XMLHttpRequest", "ctor:xhr"],
  ["cookieStore", "cookieStore"],
  ["Reflect", "ns:reflect"],
  ["Object", "ns:object"],
]);

const DOCUMENT_PROPS = new Map<string, Kind>([
  ["location", "location"],
  ["defaultView", "window"],
  ["cookie", "cookie"],
  ["write", "fn:docWrite"],
  ["writeln", "fn:docWrite"],
  ["open", "fn:docOpen"],
]);

/** Properties that lead to a window or document whatever the object is. */
const ANY_OBJECT_PROPS = new Map<string, Kind>([
  ["location", "location"],
  ["contentWindow", "window"],
  ["contentDocument", "document"],
  ["ownerDocument", "document"],
  ["defaultView", "window"],
  ["postMessage", "fn:postMessage"],
]);

const OBJECT_KINDS = new Set<Kind>(["window", "location", "document", "history", "navigator", "navigation"]);
const DYNAMIC_CODE_NAMES = new Set(["eval", "Function", "execScript"]);
const RESOURCE_PROPS = new Set(["href", "src", "action", "formAction", "srcset", "poster", "ping"]);
const MARKUP_PROPS = new Set(["innerHTML", "outerHTML", "srcdoc"]);
const URL_ATTRS = new Set([
  "src",
  "href",
  "xlink:href",
  "action",
  "formaction",
  "srcset",
  "poster",
  "ping",
  "data",
  "background",
  "codebase",
  "manifest",
]);
const BLOCKED_ELEMENTS = new Set(["script", "iframe", "frame", "frameset", "object", "embed", "base", "meta", "portal", "link"]);
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

function memberKind(obj: Kind | null, prop: string): Kind | null {
  switch (obj) {
    case "window":
      return GLOBALS.get(prop) ?? null;
    case "document":
      return DOCUMENT_PROPS.get(prop) ?? null;
    case "location":
      if (prop === "assign" || prop === "replace") return "fn:navigate";
      return prop === "reload" ? "fn:reload" : null;
    case "history":
      if (prop === "pushState" || prop === "replaceState") return "fn:pushState";
      return prop === "go" || prop === "back" || prop === "forward" ? "fn:historyNav" : null;
    case "navigator":
      return prop === "sendBeacon" ? "fn:beacon" : null;
    case "navigation":
      if (prop === "navigate") return "fn:navigate";
      return ["back", "forward", "traverseTo", "reload"].includes(prop) ? "fn:historyNav" : null;
    default:
      return ANY_OBJECT_PROPS.get(prop) ?? null;
  }
}

const isFnKind = (k: Kind | null): boolean => typeof k === "string" && k.startsWith("fn:");

class Analyzer {
  private readonly aliases = new Map<string, Kind>();
  private readonly constants: ReadonlyMap<string, string>;
  /** Names only ever bound to object or array literals: records the bot builds, never windows. */
  private readonly plainObjects = new Set<string>();
  private readonly violations: Exclude<GuardDecision, { allow: true }>[] = [];

  constructor(
    private readonly program: Program,
    private readonly allowlist: readonly string[],
  ) {
    this.constants = collectStringConstants(program);
    this.collectAliases();
    this.collectPlainObjects();
  }

  private collectPlainObjects(): void {
    const isLiteral = (n: AnyNode | null | undefined) => n?.type === "ObjectExpression" || n?.type === "ArrayExpression";
    const plain = new Map<string, boolean>();
    const note = (name: string, ok: boolean) => plain.set(name, (plain.get(name) ?? true) && ok);
    visit(this.program, (node, parent, key, ancestors) => {
      if (node.type === "VariableDeclarator" && node.id.type === "Identifier") note(node.id.name, isLiteral(node.init));
      else if (node.type === "AssignmentExpression" && node.left.type === "Identifier") {
        note(node.left.name, node.operator === "=" && isLiteral(node.right));
      } else if (node.type === "UpdateExpression" && node.argument.type === "Identifier") {
        note(node.argument.name, false);
      } else if (
        node.type === "Identifier" &&
        !isReference(parent, key, ancestors[ancestors.length - 2] ?? null) &&
        !(parent?.type === "VariableDeclarator" && key === "id") &&
        parent?.type !== "MemberExpression" &&
        !(parent?.type === "Property" && key === "key")
      ) {
        note(node.name, false); // parameters, catch clauses, patterns, function names
      }
    });
    for (const [name, ok] of plain) if (ok && !this.aliases.has(name)) this.plainObjects.add(name);
  }

  run(): GuardDecision {
    visit(this.program, (node, parent, key, ancestors) => this.check(node, parent, key, ancestors[ancestors.length - 2] ?? null));
    return this.violations[0] ?? { allow: true };
  }

  // ---- kinds -------------------------------------------------------------------------------

  private kindOf(node: AnyNode | null | undefined): Kind | null {
    if (!node) return null;
    switch (node.type) {
      case "Identifier":
        return this.aliases.get(node.name) ?? GLOBALS.get(node.name) ?? null;
      case "ThisExpression":
        return "window";
      case "MemberExpression": {
        const prop = staticPropName(node);
        return prop === null ? null : memberKind(this.kindOf(node.object), prop);
      }
      case "ChainExpression":
        return this.kindOf(node.expression);
      case "AwaitExpression":
        return this.kindOf(node.argument);
      case "ParenthesizedExpression":
        return this.kindOf(node.expression);
      case "SequenceExpression":
        return this.kindOf(node.expressions[node.expressions.length - 1]);
      case "ConditionalExpression":
        return this.kindOf(node.consequent) ?? this.kindOf(node.alternate);
      case "LogicalExpression":
        return this.kindOf(node.left) ?? this.kindOf(node.right);
      case "AssignmentExpression":
        return this.kindOf(node.right);
      case "CallExpression": {
        const callee = node.callee;
        if (callee.type === "MemberExpression" && staticPropName(callee) === "bind") return this.kindOf(callee.object);
        return this.kindOf(callee) === "fn:open" ? "window" : null;
      }
      default:
        return null;
    }
  }

  private bind(pattern: Pattern | null, kind: Kind | null): void {
    if (!pattern) return;
    switch (pattern.type) {
      case "Identifier":
        if (kind && !this.aliases.has(pattern.name)) this.aliases.set(pattern.name, kind);
        return;
      case "ObjectPattern":
        for (const prop of pattern.properties) {
          if (prop.type === "RestElement") {
            this.bind(prop.argument, kind);
            continue;
          }
          const key = prop.computed
            ? prop.key.type === "Literal" && typeof prop.key.value === "string"
              ? prop.key.value
              : null
            : prop.key.type === "Identifier"
              ? prop.key.name
              : prop.key.type === "Literal"
                ? String(prop.key.value)
                : null;
          if (key !== null) this.bind(prop.value, memberKind(kind, key));
        }
        return;
      case "AssignmentPattern":
        this.bind(pattern.left, kind ?? this.kindOf(pattern.right));
        return;
      default:
        return;
    }
  }

  private collectAliases(): void {
    for (let round = 0; round < 8; round++) {
      const before = this.aliases.size;
      visit(this.program, (node) => {
        if (node.type === "VariableDeclarator") this.bind(node.id, this.kindOf(node.init));
        else if (node.type === "AssignmentExpression" && node.operator === "=" && node.left.type !== "MemberExpression") {
          this.bind(node.left, this.kindOf(node.right));
        }
      });
      if (this.aliases.size === before) return;
    }
  }

  // ---- violations --------------------------------------------------------------------------

  private block(rule: string, reason: string, target?: string): void {
    this.violations.push({ allow: false, rule, reason: `Blocked by site guard: ${reason}`, ...(target ? { target } : {}) });
  }

  private value(node: Expression | SpreadElement | null | undefined): StaticValue | null {
    if (!node || node.type === "SpreadElement") return null;
    return staticValue(node, this.constants);
  }

  private url(node: Expression | SpreadElement | null | undefined, what: string, hint = ""): void {
    const decision = checkPageUrlValue(this.value(node), this.allowlist, what);
    if (!decision.allow) {
      this.violations.push(hint ? { ...decision, reason: `${decision.reason} ${hint}` } : decision);
    }
  }

  private host(node: Expression, what: string): void {
    const v = this.value(node);
    if (!v || !("exact" in v)) {
      this.url(null, what);
      return;
    }
    const host = v.exact.trim().replace(/:\d+$/, "");
    if (!hostAllowed(host, this.allowlist)) {
      this.block("js_host", `${what} goes to "${host}", which is outside this task's allowed sites (${describeAllowlist(this.allowlist)}).`, host);
    }
  }

  private markup(node: Expression | SpreadElement | null | undefined, what: string): void {
    const v = this.value(node);
    if (!v || !("exact" in v)) {
      this.block("js_dynamic_markup", `${what} writes markup the guard cannot check. Read the page instead of changing it.`);
      return;
    }
    const html = v.exact;
    if (/http-equiv/i.test(html)) {
      this.block("js_meta_refresh", `${what} adds a meta refresh, which can navigate away from the allowed sites.`);
      return;
    }
    const tag = /<\s*(script|iframe|frame|frameset|object|embed|base|portal)\b/i.exec(html)?.[1];
    if (tag) {
      this.block("js_create_element", `${what} adds a <${tag.toLowerCase()}> element.`);
      return;
    }
    if (/<[^>]*[\s/"']on[a-z]+\s*=/i.test(html)) {
      this.block("js_event_handler", `${what} adds an inline event handler, which runs script.`);
      return;
    }
    const attr = /\b(?:src|href|action|formaction|poster|ping|data|background|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
    for (const m of html.matchAll(attr)) {
      this.urlFromText(m[1] ?? m[2] ?? m[3] ?? "", false, what);
    }
    this.css({ exact: html }, what);
  }

  private urlFromText(text: string, open: boolean, what: string): void {
    const decision = checkPageUrlValue(open ? { prefix: text } : { exact: text }, this.allowlist, what);
    if (!decision.allow) this.violations.push(decision);
  }

  /** url(...) and @import inside CSS text; a dynamic tail leaves the last URL open-ended. */
  private css(v: StaticValue | null, what: string): void {
    if (!v) return; // dynamic CSS without a visible url( is a documented residual risk
    const text = "exact" in v ? v.exact : v.prefix;
    const re = /(?:url\(\s*|@import\s+)(["']?)([^"')\s]*)(["')\s]|$)/gi;
    for (const m of text.matchAll(re)) {
      const reachedEnd = m[3] === "" && "prefix" in v;
      this.urlFromText(m[2] ?? "", reachedEnd, what);
    }
  }

  private attribute(nameNode: Expression | SpreadElement | undefined, valueNode: Expression | SpreadElement | undefined): void {
    const name = this.value(nameNode);
    if (!name || !("exact" in name)) {
      this.block("js_dynamic_attribute", "setAttribute uses an attribute name the guard cannot check.");
      return;
    }
    const lname = name.exact.trim().toLowerCase();
    if (lname.startsWith("on")) {
      this.block("js_event_handler", `setAttribute("${lname}") adds inline script.`);
    } else if (URL_ATTRS.has(lname)) {
      this.url(valueNode, `setAttribute("${lname}")`);
    } else if (lname === "http-equiv") {
      this.block("js_meta_refresh", "setAttribute(\"http-equiv\") can navigate away from the allowed sites.");
    } else if (lname === "style") {
      this.css(this.value(valueNode), "setAttribute(\"style\")");
    } else if (lname === "srcdoc") {
      this.markup(valueNode, "setAttribute(\"srcdoc\")");
    }
  }

  private navigationValue(node: Expression, what: string): void {
    this.url(node, what, "If this is not the page location, use another property name.");
  }

  private checkAssignment(node: Extract<AnyNode, { type: "AssignmentExpression" }>): void {
    const left = node.left;
    const compound = node.operator !== "=";
    if (left.type === "Identifier") {
      if (left.name === "location") {
        if (compound) this.block("js_location_compound", "changing location with a compound assignment cannot be checked.");
        else this.navigationValue(node.right, "assigning location");
      }
      return;
    }
    if (left.type !== "MemberExpression") return;
    const prop = staticPropName(left);
    if (prop === null) return; // dynamic keys are reported by the MemberExpression check
    if (left.object.type === "Identifier" && this.plainObjects.has(left.object.name)) return;
    const objKind = this.kindOf(left.object);

    if (prop === "location" || (objKind === "location" && prop === "href")) {
      if (compound) this.block("js_location_compound", "changing location with a compound assignment cannot be checked.");
      else this.navigationValue(node.right, `assigning ${prop === "location" ? "location" : "location.href"}`);
      return;
    }
    if (objKind === "location") {
      if (prop === "host" || prop === "hostname") this.host(node.right, `assigning location.${prop}`);
      else if (prop === "protocol") this.block("js_location_protocol", "changing location.protocol is not allowed.");
      return; // pathname, search, hash, port stay on the same host
    }
    if (RESOURCE_PROPS.has(prop)) {
      if (compound) this.url(null, `appending to .${prop}`);
      else this.url(node.right, `assigning .${prop}`, "If this is not an element URL, use another property name.");
      return;
    }
    if (MARKUP_PROPS.has(prop)) {
      this.markup(node.right, `assigning .${prop}`);
      return;
    }
    const styleTarget =
      prop === "cssText" ||
      (left.object.type === "MemberExpression" && staticPropName(left.object) === "style");
    if (styleTarget) this.css(this.value(node.right), `assigning style.${prop}`);
  }

  private checkCall(node: Extract<AnyNode, { type: "CallExpression" }>): void {
    const callee = node.callee;
    if (callee.type === "Super") return;
    let kind = this.kindOf(callee);
    let args: Array<Expression | SpreadElement> = node.arguments;
    let viaApply = false;

    if (callee.type === "MemberExpression") {
      const p = staticPropName(callee);
      const inner = this.kindOf(callee.object);
      if ((p === "call" || p === "apply") && isFnKind(inner)) {
        kind = inner;
        if (p === "call") args = args.slice(1);
        else viaApply = true;
      }
    }

    const first = viaApply ? null : args[0];
    switch (kind) {
      case "fn:navigate":
        this.url(first, "navigation from page code");
        break;
      case "fn:open":
        if (!viaApply && args.length === 0) this.block("js_open_blank", "window.open() without a URL can be scripted to any site.");
        else this.url(first, "window.open()");
        break;
      case "fn:fetch":
        this.url(first, "fetch()");
        break;
      case "fn:beacon":
        this.url(first, "navigator.sendBeacon()");
        break;
      case "fn:pushState":
        if (viaApply) this.url(null, "history.pushState()");
        else if (args.length >= 3) this.url(args[2], "history.pushState()");
        break;
      case "fn:eval":
        this.block("js_dynamic_code", "eval/Function run code the guard cannot check.");
        break;
      case "fn:timer": {
        const a = args[0];
        const stringy =
          viaApply ||
          (a !== undefined &&
            (a.type === "TemplateLiteral" ||
              (a.type === "Literal" && typeof a.value === "string") ||
              (a.type === "BinaryExpression" && a.operator === "+") ||
              (a.type === "Identifier" && this.constants.has(a.name))));
        if (stringy) this.block("js_dynamic_code", "a timer with a code string runs code the guard cannot check.");
        break;
      }
      case "fn:docWrite":
        if (viaApply) this.markup(null, "document.write()");
        for (const a of args) this.markup(a, "document.write()");
        break;
      case "fn:docOpen":
        if (args.length >= 3) this.url(first, "document.open()");
        break;
      case "fn:postMessage":
        this.block("js_post_message", "postMessage sends data to other windows.");
        break;
      default:
        break;
    }

    if (callee.type !== "MemberExpression") return;
    const p = staticPropName(callee);
    const objKind = this.kindOf(callee.object);
    if (p === "open" && objKind !== "window" && objKind !== "document" && args.length >= 2) {
      const method = this.value(args[0]);
      if (method && "exact" in method && HTTP_METHODS.has(method.exact.toUpperCase())) this.url(args[1], "XMLHttpRequest.open()");
    } else if (p === "setAttribute") {
      this.attribute(args[0], args[1]);
    } else if (p === "setAttributeNS") {
      this.attribute(args[1], args[2]);
    } else if (p === "insertAdjacentHTML") {
      this.markup(args[1], "insertAdjacentHTML()");
    } else if (p === "createContextualFragment") {
      this.markup(args[0], "createContextualFragment()");
    } else if (p === "submit" || p === "requestSubmit") {
      this.block("js_form_submit", "submitting a form from page code is not allowed; read the page instead.");
    } else if (p === "createElement" || p === "createElementNS") {
      const v = this.value(args[p === "createElement" ? 0 : 1]);
      const tag = v && "exact" in v ? v.exact.trim().toLowerCase() : null;
      if (tag === null) this.block("js_create_element", "createElement with a tag the guard cannot check.");
      else if (BLOCKED_ELEMENTS.has(tag)) this.block("js_create_element", `creating <${tag}> elements is not allowed.`);
    } else if (p !== null && objKind === "ns:reflect" && ["set", "defineProperty", "apply", "construct", "setPrototypeOf"].includes(p)) {
      if (args.some((a) => a.type !== "SpreadElement" && this.isSensitive(a))) {
        this.block("js_reflective_write", `Reflect.${p} on window, location or document cannot be checked.`);
      }
    } else if (p !== null && objKind === "ns:object" && ["assign", "defineProperty", "defineProperties", "setPrototypeOf"].includes(p)) {
      const target = args[0];
      if (target && target.type !== "SpreadElement" && this.isSensitive(target)) {
        this.block("js_reflective_write", `Object.${p} on window, location or document cannot be checked.`);
      }
    }
  }

  private isSensitive(node: Expression): boolean {
    const k = this.kindOf(node);
    return k !== null && (OBJECT_KINDS.has(k) || isFnKind(k));
  }

  private checkNew(node: Extract<AnyNode, { type: "NewExpression" }>): void {
    const kind = this.kindOf(node.callee);
    if (kind === "ctor:url") this.url(node.arguments[0], `new ${node.callee.type === "Identifier" ? node.callee.name : "request"}()`);
    else if (kind === "ctor:ws") {
      const v = this.value(node.arguments[0]);
      // ws:/wss: reach the same hosts as http:/https:
      const mapped = v && ("exact" in v ? { exact: v.exact.replace(/^ws(s?):/i, "http$1:") } : { prefix: v.prefix.replace(/^ws(s?):/i, "http$1:") });
      const decision = checkPageUrlValue(mapped, this.allowlist, "new WebSocket()");
      if (!decision.allow) this.violations.push(decision);
    } else if (kind === "fn:eval") this.block("js_dynamic_code", "new Function runs code the guard cannot check.");
  }

  private check(node: AnyNode, parent: AnyNode | null, key: string | null, grandparent: AnyNode | null): void {
    switch (node.type) {
      case "WithStatement":
        this.block("js_with", "`with` blocks hide which object is changed.");
        return;
      case "Identifier":
        if (!isReference(parent, key, grandparent)) return;
        if (DYNAMIC_CODE_NAMES.has(node.name) && !this.aliases.has(node.name)) {
          this.block("js_dynamic_code", `${node.name} runs code the guard cannot check.`);
        } else if (node.name === "cookieStore") {
          this.block("js_cookies", "bots never read cookies (spec §10.2 rule 6).");
        }
        return;
      case "MemberExpression": {
        const objKind = this.kindOf(node.object);
        const prop = staticPropName(node);
        if (prop === null) {
          if (objKind && OBJECT_KINDS.has(objKind)) {
            this.block("js_dynamic_access", "a computed property on window, location or document cannot be checked.");
          }
          return;
        }
        const k = memberKind(objKind, prop);
        if (k === "cookie" || k === "cookieStore") this.block("js_cookies", "bots never read cookies (spec §10.2 rule 6).");
        else if (k === "fn:eval" && objKind !== null) this.block("js_dynamic_code", `${prop} runs code the guard cannot check.`);
        else if (prop === "constructor" && !(parent?.type === "MemberExpression" && key === "object" && staticPropName(parent) === "name")) {
          // `x.constructor.constructor("…")` is the Function constructor without naming it.
          this.block("js_dynamic_code", "`.constructor` can reach the Function constructor; read `.constructor.name` only.");
        }
        return;
      }
      case "AssignmentExpression":
        this.checkAssignment(node);
        return;
      case "CallExpression":
        this.checkCall(node);
        return;
      case "NewExpression":
        this.checkNew(node);
        return;
      case "ImportExpression":
        this.url(node.source, "import()");
        return;
      case "ImportDeclaration":
        this.url(node.source, "import");
        return;
      case "TaggedTemplateExpression": {
        const kind = this.kindOf(node.tag);
        if (kind === "fn:eval") this.block("js_dynamic_code", "a tagged template runs code the guard cannot check.");
        else if (isFnKind(kind) && kind !== "fn:historyNav" && kind !== "fn:reload") this.url(null, "a tagged template call");
        return;
      }
      default:
        return;
    }
  }
}

/** Checks `javascript_tool` code against the allowlist. */
export function checkPageJavascript(code: unknown, allowlist: readonly string[]): GuardDecision {
  if (typeof code !== "string") {
    return { allow: false, rule: "js_parse", reason: "Blocked by site guard: javascript_tool needs code as text." };
  }
  const parsed = parseJs(code, "script");
  if (!parsed.ok) {
    return {
      allow: false,
      rule: "js_parse",
      reason: `Blocked by site guard: the guard could not parse this code (${parsed.error}). Fix the syntax and try again.`,
    };
  }
  try {
    return new Analyzer(parsed.program, allowlist).run();
  } catch (err) {
    if (err instanceof RangeError) {
      return { allow: false, rule: "js_too_complex", reason: "Blocked by site guard: the code is too deeply nested to check." };
    }
    throw err;
  }
}
