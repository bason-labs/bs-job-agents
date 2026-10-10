// Figma code guard (spec §6.2 write boundary): a PreToolUse check on the CV bot's figma_execute
// code. figma_execute runs arbitrary plugin code, so "Drafts only" is enforced three ways: the
// prompt, this guard, and the orchestrator's before/after fingerprint of the protected pages.
//
// The code is parsed exactly as the Desktop Bridge runs it (the body of an async function), and
// every value is tracked as one of: the figma API, the document root, the page list, a page that
// is not provably Drafts, the Drafts page, a node on Drafts, a protected node (on another page,
// a main component, a style or variable), or a fresh node (clone/create). Simple aliases,
// destructuring, `for…of`, array callbacks, `.then`, objects/arrays holding values and
// `push`/`set` into containers are followed.
//
// Caught (blocked):
// - other pages by name (any string literal equal to a protected page name) or id (literal or
//   constant), by position (`children[0]`, `.at()`, destructuring), by a lookup that is not
//   `name === "Drafts"` / the Drafts id, and cross-page search (`root.findAll…`, `loadAllPagesAsync`)
// - `setCurrentPageAsync` / `figma.currentPage =` to anything but Drafts; `createPage`
// - writes (assignment, delete, ++, non-read methods such as remove/appendChild/resize/setPluginData)
//   to pages, the root, protected nodes (template ids from the fingerprint), main components,
//   local styles and variables; renaming or deleting the Drafts page
// - moving a protected node anywhere (`appendChild(template)`, `figma.group([...])`): clone instead
// - passing protected nodes to helper functions the guard cannot follow
// - new nodes (`clone`, `create*`, `createInstance`) that are neither appended to a parent nor
//   created after a top-level `await figma.setCurrentPageAsync(drafts)`; writes to `figma.currentPage`
//   before that switch
// - the bridge itself and escapes: `figma.ui`, `closePlugin`, `showUI`, `figma.on`, `triggerUndo`,
//   `openExternal`, new styles/variables, eval/Function/string timers, network (fetch, WebSocket, …),
//   `with`, dynamic keys on figma/root, unparsable code
// - figma_execute without the CV file's key (another open file would run the code), and every
//   Figma tool other than figma_get_status, figma_execute and figma_capture_screenshot
// Not caught (the fingerprint is the backstop): node ids built at run time (e.g. `parts.join(":")`),
// `.parent` chains upwards from nodes the guard cannot place, template ids missing from the
// fingerprint the policy was built from, values passed through closures or function returns, Ba
// switching pages in the UI while the code awaits, and changes in other Figma files.
import type { AnyNode, CallExpression, Expression, MemberExpression, Pattern, Program, SpreadElement } from "acorn";
import { isRecord, type GuardDecision, type PreToolUseCall } from "../hooks/protocol.js";
import { collectStringConstants, isReference, parseJs, staticPropName, staticValue, visit } from "../js/ast.js";
import { DRAFTS_PAGE_NAME, KNOWN_PROTECTED_PAGES } from "./constants.js";
import type { ProtectedPagesFingerprint } from "./fingerprint.js";

export interface FigmaGuardPolicy {
  draftsPageName: string;
  draftsPageId?: string | null;
  /** Every page name except Drafts (from the fingerprint) plus the known template pages. */
  protectedPageNames: readonly string[];
  protectedPageIds: readonly string[];
  /** Every node id on the protected pages (from the fingerprint): the templates the bot may only clone or read. */
  protectedNodeIds: readonly string[];
  /** figma_execute must target this file (its `fileKey` argument). */
  fileKey?: string | null;
}

export const DEFAULT_FIGMA_GUARD_POLICY: FigmaGuardPolicy = {
  draftsPageName: DRAFTS_PAGE_NAME,
  draftsPageId: null,
  protectedPageNames: [...KNOWN_PROTECTED_PAGES],
  protectedPageIds: [],
  protectedNodeIds: [],
  fileKey: null,
};

/** Tools the CV bot may call on the Figma server (spec §5.2). */
export const FIGMA_GUARD_ALLOWED_TOOLS = ["figma_get_status", "figma_execute", "figma_capture_screenshot"] as const;

export function figmaGuardPolicyFromFingerprint(fp: ProtectedPagesFingerprint, opts: { draftsPageId?: string | null } = {}): FigmaGuardPolicy {
  const names = [...fp.pages.map((p) => p.name), ...KNOWN_PROTECTED_PAGES].filter((n) => n !== fp.draftsPageName);
  return {
    draftsPageName: fp.draftsPageName,
    draftsPageId: opts.draftsPageId ?? null,
    protectedPageNames: [...new Set(names)],
    protectedPageIds: fp.pages.map((p) => p.id),
    protectedNodeIds: fp.pages.flatMap((p) => p.nodes.map((n) => n.id)),
    fileKey: fp.fileKey,
  };
}

type Kind = "figma" | "root" | "pages" | "page" | "drafts" | "draftNode" | "protected" | "fresh" | "variables" | "ui" | null;

const RANK: Record<Exclude<Kind, null>, number> = {
  protected: 9,
  root: 8,
  pages: 7,
  page: 6,
  drafts: 5,
  draftNode: 4,
  fresh: 3,
  figma: 2,
  variables: 2,
  ui: 2,
};
const join = (a: Kind, b: Kind): Kind => (a === null ? b : b === null ? a : RANK[a] >= RANK[b] ? a : b);
const GUARDED = new Set<Kind>(["protected", "page", "root", "pages"]);
const isGuarded = (k: Kind) => GUARDED.has(k);

const elementOf = (k: Kind): Kind => {
  switch (k) {
    case "pages":
      return "page";
    case "drafts":
      return "draftNode";
    case "page":
    case "root":
      return "protected";
    default:
      return k;
  }
};

const PRIMITIVE_PROPS = new Set(
  (
    "id name type removed characters x y width height minWidth maxWidth minHeight maxHeight rotation opacity visible locked " +
    "blendMode isMask fills strokes strokeWeight strokeAlign effects cornerRadius topLeftRadius topRightRadius " +
    "bottomLeftRadius bottomRightRadius fontName fontSize fontWeight letterSpacing lineHeight paragraphSpacing " +
    "paragraphIndent textCase textDecoration textAlignHorizontal textAlignVertical textAutoResize textTruncation " +
    "hasMissingFont layoutMode layoutWrap primaryAxisSizingMode counterAxisSizingMode primaryAxisAlignItems " +
    "counterAxisAlignItems itemSpacing counterAxisSpacing paddingLeft paddingRight paddingTop paddingBottom layoutAlign " +
    "layoutGrow layoutPositioning layoutSizingHorizontal layoutSizingVertical constraints absoluteTransform " +
    "relativeTransform absoluteBoundingBox absoluteRenderBounds clipsContent componentProperties variantProperties key " +
    "description length exportSettings boundVariables fillStyleId strokeStyleId textStyleId effectStyleId gridStyleId " +
    "backgroundStyleId paints resolvedType valuesByMode remote isPageDivider backgrounds"
  ).split(" "),
);
const PAGE_PRIMITIVES = new Set(["id", "name", "type", "removed", "isPageDivider", "backgrounds"]);
const NODE_LIST_PROPS = new Set(["children", "selection"]);
const FIND_METHODS = new Set(["findOne", "findAll", "findChild", "findChildren", "findAllWithCriteria", "findWidgetNodesByWidgetId"]);
const SAME_KIND_METHODS = new Set(["filter", "find", "findLast", "slice", "at", "concat", "flat", "reverse", "sort", "values", "toReversed", "toSorted", "reduce", "reduceRight"]);
const ITERATION_METHODS = new Set(["forEach", "map", "filter", "find", "findIndex", "findLast", "findLastIndex", "some", "every", "flatMap", "reduce", "reduceRight"]);
const VALUE_LOOKUPS = new Set(["find", "filter", "findLast"]);
const CROSS_PAGE = new Set(["findAll", "findOne", "findAllWithCriteria", "findWidgetNodesByWidgetId"]);
const CONTAINER_METHODS = new Set(["push", "unshift", "splice", "set", "add", "concat", "fill", "with", "toSpliced"]);
const EXTRA_READ_METHODS = new Set(
  (
    "clone exportAsync loadAsync toString valueOf hasOwnProperty propertyIsEnumerable isPrototypeOf toJSON map forEach " +
    "filter some every reduce reduceRight slice concat includes indexOf lastIndexOf entries keys values flatMap flat join " +
    "then catch finally at"
  ).split(" "),
);
const isReadMethod = (m: string) => m.startsWith("get") || m.startsWith("find") || EXTRA_READ_METHODS.has(m);
const CREATE_NODE = new Set(
  (
    "createFrame createComponent createComponentFromNode createRectangle createLine createEllipse createPolygon createStar " +
    "createVector createText createBooleanOperation createSlice createSection createTable createSticky createShapeWithText " +
    "createConnector createCodeBlock createNodeFromSvg createNodeFromJSXAsync createTextPath createLinkPreviewAsync createMediaAsync"
  ).split(" "),
);
const NODE_OPS = new Set(["group", "flatten", "union", "subtract", "intersect", "exclude"]);
const SAFE_FUNCTIONS = new Set(
  (
    "String Number Boolean parseInt parseFloat isNaN isFinite Array Object Promise Date encodeURIComponent decodeURIComponent " +
    "encodeURI decodeURI setTimeout setInterval clearTimeout clearInterval Set Map WeakMap WeakSet Symbol BigInt Error TypeError RangeError"
  ).split(" "),
);
const SAFE_NAMESPACES = new Set(["console", "JSON", "Math", "Array", "Promise", "Number", "String", "Date", "Object"]);
const NETWORK = new Set(["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "Worker", "SharedWorker", "Request"]);
const DYNAMIC_CODE = new Set(["eval", "Function"]);
const REFERENCE_RULES = new Set(["figma_page_name", "figma_page_id", "figma_page_index", "figma_page_lookup", "figma_cross_page_search"]);

/** The Desktop Bridge runs code as `(async function() {\n<code>\n})()`. */
const WRAPPER_OFFSET = "(async function() {\n".length;

const ADVICE = {
  page: `Bots may only use the Drafts page: find it with figma.root.children.find(p => p.name === "Drafts") and clone templates by node id.`,
  write: "Templates and other pages are read-only for bots: clone the template into Drafts and edit the copy.",
  create: "New nodes land on the current page: call `await figma.setCurrentPageAsync(drafts)` first, or append them to a frame on Drafts.",
  current: "The current page may not be Drafts: call `await figma.setCurrentPageAsync(drafts)` at the start first.",
} as const;

interface Violation {
  rule: string;
  message: string;
  start: number;
}

type Fn = Extract<AnyNode, { type: "ArrowFunctionExpression" | "FunctionExpression" }>;

function patternNames(p: Pattern | null): string[] {
  if (!p) return [];
  switch (p.type) {
    case "Identifier":
      return [p.name];
    case "ObjectPattern":
      return p.properties.flatMap((prop) => patternNames(prop.type === "RestElement" ? prop.argument : prop.value));
    case "ArrayPattern":
      return p.elements.flatMap((el) => patternNames(el));
    case "AssignmentPattern":
      return patternNames(p.left);
    case "RestElement":
      return patternNames(p.argument);
    default:
      return [];
  }
}
const isFn = (n: AnyNode | null | undefined): n is Fn => n?.type === "ArrowFunctionExpression" || n?.type === "FunctionExpression";

class FigmaAnalyzer {
  private readonly env = new Map<string, Kind>();
  /** Bindings of function parameters and `for…of` variables, per scope node. */
  private readonly scoped = new Map<AnyNode, Map<string, Kind>>();
  /** Identifier reference → the function or loop whose binding it refers to. */
  private readonly refScope = new WeakMap<AnyNode, AnyNode>();
  private readonly constants: ReadonlyMap<string, string>;
  private readonly pageNames: Set<string>;
  private readonly pageIds: Set<string>;
  private readonly nodeIds: Set<string>;
  private readonly userFunctions = new Set<string>();
  private readonly appendedNames = new Set<string>();
  private readonly appendedNodes = new Set<AnyNode>();
  private hasProtectedLiteral = false;
  /** End of the top-level `await figma.setCurrentPageAsync(drafts)`; later code runs on Drafts. */
  private switchPoint: number | null = null;
  private readonly violations: Violation[] = [];

  constructor(
    private readonly program: Program,
    private readonly code: string,
    private readonly policy: FigmaGuardPolicy,
  ) {
    this.constants = collectStringConstants(program);
    this.pageNames = new Set(policy.protectedPageNames.filter((n) => n !== policy.draftsPageName));
    this.pageIds = new Set(policy.protectedPageIds.filter((id) => id !== policy.draftsPageId));
    this.nodeIds = new Set(policy.protectedNodeIds);
  }

  run(): GuardDecision {
    this.prepare();
    visit(this.program, (node, parent, key, ancestors) => this.check(node, parent, key, ancestors[ancestors.length - 2] ?? null));
    this.checkCreations();
    if (this.violations.length === 0) return { allow: true };
    const sorted = [...this.violations].sort(
      (a, b) => a.start - b.start || Number(REFERENCE_RULES.has(b.rule)) - Number(REFERENCE_RULES.has(a.rule)),
    );
    const first = sorted[0] as Violation;
    const more = sorted.length > 1 ? ` (${sorted.length - 1} more problem${sorted.length > 2 ? "s" : ""} in this code.)` : "";
    return { allow: false, rule: first.rule, reason: `Blocked by Figma guard: ${first.message}${more}` };
  }

  // ---- preparation --------------------------------------------------------------------------

  private computeRefScopes(): void {
    visit(this.program, (node, parent, key, ancestors) => {
      if (node.type !== "Identifier" || !isReference(parent, key, ancestors[ancestors.length - 2] ?? null)) return;
      for (let i = ancestors.length - 1; i >= 0; i--) {
        const a = ancestors[i] as AnyNode;
        const binds =
          (isFn(a) || a.type === "FunctionDeclaration") ? a.params.some((p) => patternNames(p).includes(node.name))
          : a.type === "ForOfStatement" && a.left.type === "VariableDeclaration"
            ? a.left.declarations.some((d) => patternNames(d.id).includes(node.name))
            : false;
        if (binds) {
          this.refScope.set(node, a);
          return;
        }
      }
    });
  }

  private prepare(): void {
    this.computeRefScopes();
    visit(this.program, (node) => {
      if ((node.type === "Literal" && typeof node.value === "string") || node.type === "TemplateElement") {
        const v = (node.type === "Literal" ? String(node.value) : (node.value.cooked ?? "")).trim();
        if (this.nodeIds.has(v) || this.pageIds.has(v)) this.hasProtectedLiteral = true;
      }
      if (node.type === "FunctionDeclaration" && node.id) this.userFunctions.add(node.id.name);
      if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && isFn(node.init)) this.userFunctions.add(node.id.name);
    });
    for (let round = 0; round < 10; round++) {
      const before = `${[...this.env].join("|")}#${this.switchPoint}`;
      this.collectEnv();
      this.computeSwitchPoint();
      if (`${[...this.env].join("|")}#${this.switchPoint}` === before) break;
    }
    visit(this.program, (node) => {
      if (node.type !== "CallExpression" || node.callee.type !== "MemberExpression") return;
      const prop = staticPropName(node.callee);
      const arg = prop === "appendChild" ? node.arguments[0] : prop === "insertChild" ? node.arguments[1] : undefined;
      if (!arg || arg.type === "SpreadElement") return;
      const inner = arg.type === "AwaitExpression" ? arg.argument : arg;
      this.appendedNodes.add(inner);
      if (inner.type === "Identifier") this.appendedNames.add(inner.name);
    });
  }

  private topLevelStatements(): AnyNode[] {
    const stmt = this.program.body[0];
    if (stmt?.type === "ExpressionStatement" && stmt.expression.type === "CallExpression") {
      const fn = stmt.expression.callee;
      if (fn.type === "FunctionExpression") return fn.body.body;
    }
    return [];
  }

  private computeSwitchPoint(): void {
    this.switchPoint = null;
    for (const stmt of this.topLevelStatements()) {
      if (stmt.type !== "ExpressionStatement") continue;
      let e: AnyNode = stmt.expression;
      if (e.type === "AwaitExpression") e = e.argument;
      const toDrafts =
        (e.type === "CallExpression" &&
          e.callee.type === "MemberExpression" &&
          this.isFigma(e.callee.object) &&
          staticPropName(e.callee) === "setCurrentPageAsync" &&
          this.kindOf(e.arguments[0]) === "drafts") ||
        (e.type === "AssignmentExpression" &&
          e.left.type === "MemberExpression" &&
          this.isFigma(e.left.object) &&
          staticPropName(e.left) === "currentPage" &&
          this.kindOf(e.right) === "drafts");
      if (toDrafts) {
        this.switchPoint = stmt.end;
        return;
      }
    }
  }

  private scopeOf(node: AnyNode): Map<string, Kind> {
    let m = this.scoped.get(node);
    if (!m) {
      m = new Map();
      this.scoped.set(node, m);
    }
    return m;
  }

  private bind(pattern: Pattern | null | undefined, kind: Kind, at: number, target: Map<string, Kind> = this.env): void {
    if (!pattern) return;
    switch (pattern.type) {
      case "Identifier":
        if (kind !== null) target.set(pattern.name, join(target.get(pattern.name) ?? null, kind));
        return;
      case "ObjectPattern":
        for (const prop of pattern.properties) {
          if (prop.type === "RestElement") this.bind(prop.argument, kind, at, target);
          else {
            const key = prop.computed ? null : prop.key.type === "Identifier" ? prop.key.name : prop.key.type === "Literal" ? String(prop.key.value) : null;
            this.bind(prop.value, key === null ? (isGuarded(kind) ? "protected" : null) : this.memberKind(kind, key, at), at, target);
          }
        }
        return;
      case "ArrayPattern":
        for (const el of pattern.elements) this.bind(el, elementOf(kind), at, target);
        return;
      case "AssignmentPattern":
        this.bind(pattern.left, join(kind, this.kindOf(pattern.right)), at, target);
        return;
      case "RestElement":
        this.bind(pattern.argument, kind, at, target);
        return;
      default:
        return;
    }
  }

  private bindCallbackParam(cb: AnyNode | undefined, index: number, kind: Kind): void {
    if (isFn(cb)) this.bind(cb.params[index] ?? null, kind, cb.start, this.scopeOf(cb));
  }

  private collectEnv(): void {
    visit(this.program, (node) => {
      switch (node.type) {
        case "VariableDeclarator":
          this.bind(node.id, this.kindOf(node.init), node.start);
          return;
        case "AssignmentExpression":
          if (node.left.type !== "MemberExpression") this.bind(node.left, this.kindOf(node.right), node.start);
          return;
        case "ForOfStatement": {
          const k = elementOf(this.kindOf(node.right));
          if (node.left.type === "VariableDeclaration") for (const d of node.left.declarations) this.bind(d.id, k, node.start, this.scopeOf(node));
          else this.bind(node.left, k, node.start);
          return;
        }
        case "CallExpression": {
          const callee = node.callee;
          if (callee.type !== "MemberExpression") return;
          const prop = staticPropName(callee);
          if (prop === null) return;
          const recv = this.kindOf(callee.object);
          const args = node.arguments;
          if (prop === "then") this.bindCallbackParam(args[0], 0, recv);
          else if (prop === "reduce" || prop === "reduceRight") this.bindCallbackParam(args[0], 1, elementOf(recv));
          else if (ITERATION_METHODS.has(prop) || FIND_METHODS.has(prop)) this.bindCallbackParam(args[0], 0, elementOf(recv));
          if (CONTAINER_METHODS.has(prop) && callee.object.type === "Identifier") {
            const k = args.reduce<Kind>((acc, a) => join(acc, this.kindOf(a.type === "SpreadElement" ? a.argument : a)), null);
            if (isGuarded(k)) this.env.set(callee.object.name, join(this.env.get(callee.object.name) ?? null, "protected"));
          }
          return;
        }
        default:
          return;
      }
    });
  }

  // ---- kinds ----------------------------------------------------------------------------------

  private isFigma(node: AnyNode): boolean {
    return this.kindOf(node) === "figma";
  }

  private currentPageKind(at: number): Kind {
    return this.switchPoint !== null && at > this.switchPoint ? "drafts" : "page";
  }

  private memberKind(obj: Kind, prop: string, at: number): Kind {
    switch (obj) {
      case "figma":
        if (prop === "root") return "root";
        if (prop === "currentPage") return this.currentPageKind(at);
        if (prop === "variables") return "variables";
        return prop === "ui" ? "ui" : null;
      case "root":
        return prop === "children" ? "pages" : null;
      case "pages":
        return /^\d+$/.test(prop) ? "page" : null;
      case "page":
        if (prop === "parent") return "root";
        return PAGE_PRIMITIVES.has(prop) ? null : "protected";
      case "drafts":
        if (prop === "parent") return "root";
        return NODE_LIST_PROPS.has(prop) ? "draftNode" : null;
      case "draftNode":
        if (prop === "parent") return "drafts";
        if (prop === "mainComponent") return "protected";
        return NODE_LIST_PROPS.has(prop) || /^\d+$/.test(prop) ? "draftNode" : null;
      case "fresh":
        if (prop === "mainComponent") return "protected";
        return NODE_LIST_PROPS.has(prop) || /^\d+$/.test(prop) ? "fresh" : null;
      case "protected":
        return PRIMITIVE_PROPS.has(prop) ? null : "protected";
      default:
        return prop === "mainComponent" ? "protected" : null;
    }
  }

  private idKind(arg: Expression | SpreadElement | undefined): Kind {
    if (!arg || arg.type === "SpreadElement") return this.hasProtectedLiteral ? "protected" : null;
    const v = staticValue(arg, this.constants);
    if (v && "exact" in v) {
      const id = v.exact.trim();
      if (this.policy.draftsPageId && id === this.policy.draftsPageId) return "drafts";
      if (this.pageIds.has(id)) return "page";
      return this.nodeIds.has(id) ? "protected" : null;
    }
    return this.hasProtectedLiteral ? "protected" : null;
  }

  /** A page lookup callback: provably Drafts, or a problem to report. */
  private analyzeLookup(cb: AnyNode | undefined): { kind: Kind; problem: string | null } {
    const page = (problem: string) => ({ kind: "page" as Kind, problem });
    if (!isFn(cb)) return page("looks up a page with a function the guard cannot read");
    const param = cb.params[0];
    const field = (e: AnyNode): "name" | "id" | null => {
      if (e.type === "MemberExpression" && param?.type === "Identifier" && e.object.type === "Identifier" && e.object.name === param.name) {
        const p = staticPropName(e);
        return p === "name" || p === "id" ? p : null;
      }
      if (e.type === "Identifier" && param?.type === "ObjectPattern") return e.name === "name" || e.name === "id" ? e.name : null;
      return null;
    };
    const names: string[] = [];
    const ids: string[] = [];
    let negated = false;
    let alternative = false;
    visit(cb.body, (node) => {
      if (node.type === "LogicalExpression" && node.operator !== "&&") alternative = true;
      if (node.type !== "BinaryExpression" || !["===", "==", "!==", "!="].includes(node.operator)) return;
      for (const [a, b] of [
        [node.left, node.right],
        [node.right, node.left],
      ] as const) {
        const f = field(a);
        const v = f ? staticValue(b, this.constants) : null;
        if (f && v && "exact" in v) {
          (f === "name" ? names : ids).push(v.exact);
          if (node.operator.startsWith("!")) negated = true;
        }
      }
    });
    if (negated) return page("selects pages other than Drafts");
    if (alternative) return page("looks up a page with an `||` condition; test only the Drafts name or id");
    const other = names.find((n) => n !== this.policy.draftsPageName) ?? ids.find((i) => i !== this.policy.draftsPageId);
    if (other !== undefined) {
      // A protected page name or id is reported more precisely by the literal check.
      if (this.pageNames.has(other) || this.pageIds.has(other)) return { kind: "page", problem: null };
      return page(`looks up the page "${other}"`);
    }
    if (names.length === 0 && ids.length === 0) return page("looks up a page without testing its name or id");
    return { kind: "drafts", problem: null };
  }

  private callbackReturnKind(cb: AnyNode | undefined): Kind {
    if (!isFn(cb)) return null;
    if (cb.body.type !== "BlockStatement") return this.kindOf(cb.body);
    let k: Kind = null;
    visit(cb.body, (node) => {
      if (node.type === "ReturnStatement" && node.argument) k = join(k, this.kindOf(node.argument));
    });
    return k;
  }

  private callKind(call: CallExpression): Kind {
    const callee = call.callee;
    if (callee.type !== "MemberExpression") return null;
    const prop = staticPropName(callee);
    if (prop === null) return null;
    const obj = this.kindOf(callee.object);
    const args = call.arguments;
    if (obj === "figma") {
      if (prop === "getNodeByIdAsync" || prop === "getNodeById") return this.idKind(args[0]);
      if (prop === "createPage") return "page";
      if (CREATE_NODE.has(prop) || NODE_OPS.has(prop)) return "fresh";
      if (prop.startsWith("getLocal") || prop.startsWith("getStyleBy") || prop.startsWith("import")) return "protected";
      return null;
    }
    if (obj === "variables") return prop.startsWith("get") ? "protected" : null;
    if (obj === "root") return prop === "findChild" || prop === "findChildren" ? this.analyzeLookup(args[0]).kind : null;
    if (obj === "pages") {
      if (VALUE_LOOKUPS.has(prop)) return this.analyzeLookup(args[0]).kind;
      if (prop === "at") return "page";
      if (prop === "map" || prop === "flatMap") return this.callbackReturnKind(args[0]);
      return SAME_KIND_METHODS.has(prop) ? "pages" : null;
    }
    if (prop === "clone" || prop === "createInstance") return "fresh";
    if (prop === "getMainComponentAsync") return "protected";
    if (FIND_METHODS.has(prop)) return elementOf(obj);
    if (prop === "map" || prop === "flatMap") return join(this.callbackReturnKind(args[0]), obj === "protected" ? "protected" : null);
    if (SAME_KIND_METHODS.has(prop)) return obj;
    if (obj === "protected") return prop.startsWith("get") && prop !== "getMainComponentAsync" ? null : "protected";
    return null;
  }

  private kindOf(node: AnyNode | null | undefined): Kind {
    if (!node) return null;
    switch (node.type) {
      case "Identifier":
      {
        const scope = this.refScope.get(node);
        if (scope) return this.scoped.get(scope)?.get(node.name) ?? null;
        return this.env.get(node.name) ?? (node.name === "figma" ? "figma" : null);
      }
      case "MemberExpression": {
        const prop = staticPropName(node);
        const obj = this.kindOf(node.object);
        if (prop === null) return obj === "pages" ? "page" : isGuarded(obj) || obj === "draftNode" || obj === "fresh" ? obj : null;
        return this.memberKind(obj, prop, node.start);
      }
      case "CallExpression":
        return this.callKind(node);
      case "ChainExpression":
        return this.kindOf(node.expression);
      case "AwaitExpression":
        return this.kindOf(node.argument);
      case "ParenthesizedExpression":
        return this.kindOf(node.expression);
      case "SequenceExpression":
        return this.kindOf(node.expressions[node.expressions.length - 1]);
      case "ConditionalExpression":
        return join(this.kindOf(node.consequent), this.kindOf(node.alternate));
      case "LogicalExpression":
        return join(this.kindOf(node.left), this.kindOf(node.right));
      case "AssignmentExpression":
        return this.kindOf(node.right);
      case "ArrayExpression":
        return node.elements.reduce<Kind>((k, el) => join(k, el ? this.kindOf(el.type === "SpreadElement" ? el.argument : el) : null), null);
      case "ObjectExpression": {
        let k: Kind = null;
        for (const p of node.properties) k = join(k, this.kindOf(p.type === "SpreadElement" ? p.argument : p.value));
        return isGuarded(k) ? "protected" : null;
      }
      default:
        return null;
    }
  }

  // ---- checks ---------------------------------------------------------------------------------

  private excerpt(node: AnyNode): string {
    const raw = this.code.slice(Math.max(0, node.start - WRAPPER_OFFSET), Math.max(0, node.end - WRAPPER_OFFSET));
    const flat = raw.replace(/\s+/g, " ").trim();
    return flat.length > 70 ? `${flat.slice(0, 67)}...` : flat;
  }

  private report(rule: string, node: AnyNode, what: string, advice = ""): void {
    this.violations.push({ rule, start: node.start, message: `\`${this.excerpt(node)}\` ${what}.${advice ? ` ${advice}` : ""}` });
  }

  private viaCurrentPage(node: AnyNode): boolean {
    return node.type === "MemberExpression" && staticPropName(node) === "currentPage" && this.isFigma(node.object);
  }

  private checkWrite(target: MemberExpression, at: AnyNode): void {
    const objKind = this.kindOf(target.object);
    const prop = staticPropName(target);
    if (objKind === "figma") {
      if (prop === "currentPage") this.report("figma_switch_page", at, "switches to a page that is not provably Drafts", ADVICE.page);
      return;
    }
    if (objKind === "drafts") {
      if (prop === "name") this.report("figma_drafts_rename", at, "renames the Drafts page", ADVICE.page);
      return;
    }
    if (!isGuarded(objKind)) return;
    if (this.viaCurrentPage(target.object)) this.report("figma_current_page", at, "changes the current page", ADVICE.current);
    else if (objKind === "root") this.report("figma_root_write", at, "changes the document root", ADVICE.page);
    else this.report("figma_protected_write", at, "changes a node outside the Drafts page", ADVICE.write);
  }

  private checkLiteral(value: string, node: AnyNode): void {
    const v = value.trim();
    if (this.pageNames.has(v)) this.report("figma_page_name", node, `names the protected page "${v}"`, ADVICE.page);
    else if (this.pageIds.has(v)) this.report("figma_page_id", node, `is the id of a protected page`, ADVICE.page);
  }

  private checkCall(node: CallExpression): void {
    const callee = node.callee;
    const args = node.arguments;
    const argKind = (a: Expression | SpreadElement | undefined) => (a ? this.kindOf(a.type === "SpreadElement" ? a.argument : a) : null);

    if (callee.type === "Identifier") {
      const name = callee.name;
      const first = args[0];
      if (
        (name === "setTimeout" || name === "setInterval") &&
        first &&
        (first.type === "TemplateLiteral" || (first.type === "Literal" && typeof first.value === "string") || first.type === "BinaryExpression")
      ) {
        this.report("figma_dynamic_code", node, "runs a code string", "Pass a function instead.");
      }
      if ((this.userFunctions.has(name) || !SAFE_FUNCTIONS.has(name)) && args.some((a) => isGuarded(argKind(a)))) {
        this.report("figma_protected_escape", node, "passes a node from outside Drafts to a function the guard cannot follow", ADVICE.write);
      }
      return;
    }
    if (callee.type !== "MemberExpression") return;
    const prop = staticPropName(callee);
    if (prop === null) return; // reported as dynamic access
    const obj = this.kindOf(callee.object);

    if (obj === "figma") {
      switch (prop) {
        case "createPage":
          return this.report("figma_create_page", node, "creates a page", ADVICE.page);
        case "setCurrentPageAsync":
          if (argKind(args[0]) !== "drafts") this.report("figma_switch_page", node, "switches to a page that is not provably Drafts", ADVICE.page);
          return;
        case "loadAllPagesAsync":
          return this.report("figma_cross_page_search", node, "loads every page", ADVICE.page);
        case "closePlugin":
        case "showUI":
          return this.report("figma_bridge_control", node, "controls the Desktop Bridge plugin itself");
        case "on":
        case "once":
        case "off":
          return this.report("figma_event_handler", node, "registers an event handler that outlives this call");
        case "triggerUndo":
          return this.report("figma_undo", node, "triggers undo, which can revert work on other pages");
        case "openExternal":
          return this.report("figma_external", node, "opens a URL outside Figma");
        default:
          break;
      }
      if (/^create(Paint|Text|Effect|Grid)Style$/.test(prop)) {
        return this.report("figma_file_resource", node, "creates a file-wide style", ADVICE.write);
      }
      if (NODE_OPS.has(prop) || CREATE_NODE.has(prop)) {
        const [nodesArg, parentArg] = args;
        if (isGuarded(argKind(nodesArg))) this.report("figma_move_protected", node, "moves nodes from outside Drafts", ADVICE.write);
        else if (NODE_OPS.has(prop) && isGuarded(argKind(parentArg))) {
          if (parentArg && parentArg.type !== "SpreadElement" && this.viaCurrentPage(parentArg)) {
            this.report("figma_current_page", node, "puts nodes on the current page", ADVICE.current);
          } else this.report("figma_move_protected", node, "puts nodes on a page or node outside Drafts", ADVICE.write);
        }
      }
      return;
    }
    if (obj === "variables") {
      if (!prop.startsWith("get") && !prop.startsWith("setBoundVariableFor")) {
        this.report("figma_file_resource", node, "changes file-wide variables", ADVICE.write);
      }
      return;
    }
    if (obj === "ui") return; // reported on the member access
    if (obj === "root") {
      if (CROSS_PAGE.has(prop)) this.report("figma_cross_page_search", node, "searches every page", ADVICE.page);
      else if (prop === "findChild" || prop === "findChildren") {
        const r = this.analyzeLookup(args[0]);
        if (r.problem) this.report("figma_page_lookup", node, r.problem, ADVICE.page);
      } else if (!isReadMethod(prop)) this.report("figma_root_write", node, "changes the document root", ADVICE.page);
      return;
    }
    if (obj === "pages") {
      if (VALUE_LOOKUPS.has(prop)) {
        const r = this.analyzeLookup(args[0]);
        if (r.problem) this.report("figma_page_lookup", node, r.problem, ADVICE.page);
      } else if (prop === "at") this.report("figma_page_index", node, "picks a page by position", ADVICE.page);
      return;
    }

    if (prop === "appendChild" || prop === "insertChild") {
      if (isGuarded(argKind(prop === "appendChild" ? args[0] : args[1]))) {
        this.report("figma_move_protected", node, "moves a node from outside Drafts", ADVICE.write);
      }
    }
    if (obj === "drafts" && prop === "remove") {
      this.report("figma_drafts_delete", node, "deletes the Drafts page", ADVICE.page);
    } else if (isGuarded(obj) && !isReadMethod(prop)) {
      if (this.viaCurrentPage(callee.object)) this.report("figma_current_page", node, "changes the current page", ADVICE.current);
      else this.report("figma_protected_write", node, "changes a node outside the Drafts page", ADVICE.write);
    } else if (!isGuarded(obj) && args.some((a) => isGuarded(argKind(a)))) {
      const ns = callee.object.type === "Identifier" ? callee.object.name : null;
      if (ns === "Object" && ["assign", "defineProperty", "defineProperties", "setPrototypeOf"].includes(prop)) {
        if (isGuarded(argKind(args[0]))) this.report("figma_protected_write", node, "changes a node outside the Drafts page", ADVICE.write);
      } else if (ns === "Reflect") {
        this.report("figma_protected_write", node, "changes a node outside the Drafts page", ADVICE.write);
      } else if (!(ns && SAFE_NAMESPACES.has(ns)) && !CONTAINER_METHODS.has(prop) && !isReadMethod(prop)) {
        this.report("figma_protected_escape", node, "passes a node from outside Drafts to a function the guard cannot follow", ADVICE.write);
      }
    }
  }

  private check(node: AnyNode, parent: AnyNode | null, key: string | null, grandparent: AnyNode | null): void {
    switch (node.type) {
      case "Literal":
        if (typeof node.value === "string") this.checkLiteral(node.value, node);
        return;
      case "TemplateElement":
        this.checkLiteral(node.value.cooked ?? "", node);
        return;
      case "WithStatement":
        return this.report("figma_with", node, "uses `with`, which hides what it changes");
      case "Identifier":
        if (!isReference(parent, key, grandparent) || this.env.has(node.name)) return;
        if (DYNAMIC_CODE.has(node.name)) this.report("figma_dynamic_code", node, "runs code the guard cannot check");
        else if (NETWORK.has(node.name)) this.report("figma_network", node, "uses the network from plugin code");
        return;
      case "ImportExpression":
        return this.report("figma_network", node, "loads code from the network");
      case "MemberExpression": {
        const obj = this.kindOf(node.object);
        const prop = staticPropName(node);
        if (prop === null) {
          if (obj === "pages") this.report("figma_page_index", node, "picks a page by position", ADVICE.page);
          else if (obj === "figma" || obj === "root" || obj === "variables" || obj === "ui") {
            this.report("figma_dynamic_access", node, "uses a computed property the guard cannot check");
          }
        } else if (obj === "pages" && /^\d+$/.test(prop)) {
          this.report("figma_page_index", node, "picks a page by position", ADVICE.page);
        } else if (obj === "figma" && prop === "ui") {
          this.report("figma_bridge_control", node, "talks to the Desktop Bridge plugin's UI");
        }
        return;
      }
      case "VariableDeclarator":
        if (node.id.type === "ArrayPattern" && this.kindOf(node.init) === "pages") {
          this.report("figma_page_index", node.id, "picks pages by position", ADVICE.page);
        }
        return;
      case "AssignmentExpression":
        if (node.left.type === "MemberExpression") {
          if (staticPropName(node.left) === "currentPage" && this.isFigma(node.left.object)) {
            if (this.kindOf(node.right) !== "drafts") this.report("figma_switch_page", node, "switches to a page that is not provably Drafts", ADVICE.page);
          } else this.checkWrite(node.left, node);
        } else if (node.left.type === "ArrayPattern" && this.kindOf(node.right) === "pages") {
          this.report("figma_page_index", node.left, "picks pages by position", ADVICE.page);
        }
        return;
      case "UpdateExpression":
        if (node.argument.type === "MemberExpression") this.checkWrite(node.argument, node);
        return;
      case "UnaryExpression":
        if (node.operator === "delete" && node.argument.type === "MemberExpression") this.checkWrite(node.argument, node);
        return;
      case "CallExpression":
        this.checkCall(node);
        return;
      default:
        return;
    }
  }

  /** New nodes appear on the current page unless appended elsewhere. */
  private checkCreations(): void {
    const declaredAs = new Map<AnyNode, string>();
    visit(this.program, (node) => {
      if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && node.init) {
        declaredAs.set(node.init.type === "AwaitExpression" ? node.init.argument : node.init, node.id.name);
      } else if (node.type === "AssignmentExpression" && node.left.type === "Identifier") {
        declaredAs.set(node.right.type === "AwaitExpression" ? node.right.argument : node.right, node.left.name);
      }
    });
    visit(this.program, (node) => {
      if (node.type !== "CallExpression" || node.callee.type !== "MemberExpression") return;
      const prop = staticPropName(node.callee);
      if (prop === null) return;
      const creates =
        prop === "clone" || prop === "createInstance" || (CREATE_NODE.has(prop) && this.isFigma(node.callee.object));
      if (!creates) return;
      if (this.switchPoint !== null && node.start > this.switchPoint) return;
      if (this.appendedNodes.has(node)) return;
      const name = declaredAs.get(node);
      if (name && this.appendedNames.has(name)) return;
      this.report("figma_create_outside_drafts", node, "creates a node on whatever page is current", ADVICE.create);
    });
  }
}

/** Checks `figma_execute` code against the Drafts-only write boundary. */
export function checkFigmaCode(code: unknown, policy: FigmaGuardPolicy = DEFAULT_FIGMA_GUARD_POLICY): GuardDecision {
  if (typeof code !== "string" || code.trim() === "") {
    return { allow: false, rule: "figma_parse", reason: "Blocked by Figma guard: figma_execute needs code as text." };
  }
  const parsed = parseJs(code, "async-function-body");
  if (!parsed.ok) {
    return {
      allow: false,
      rule: "figma_parse",
      reason: `Blocked by Figma guard: the guard could not parse this code (${parsed.error}). Fix the syntax and try again.`,
    };
  }
  try {
    return new FigmaAnalyzer(parsed.program, code, policy).run();
  } catch (err) {
    if (err instanceof RangeError) {
      return { allow: false, rule: "figma_too_complex", reason: "Blocked by Figma guard: the code is too deeply nested to check." };
    }
    throw err;
  }
}

export interface FigmaToolGuardOptions {
  /** MCP server name of figma-console-mcp in the bot's mcp.json (default "figma"). */
  serverName?: string;
  allowedTools?: readonly string[];
}

/** PreToolUse decision for any tool of the Figma MCP server. */
export function evaluateFigmaToolCall(
  call: Pick<PreToolUseCall, "toolName" | "toolInput">,
  policy: FigmaGuardPolicy,
  opts: FigmaToolGuardOptions = {},
): GuardDecision {
  const prefix = `mcp__${opts.serverName ?? "figma"}__`;
  if (!call.toolName.startsWith(prefix)) return { allow: true };
  const tool = call.toolName.slice(prefix.length);
  const allowed = opts.allowedTools ?? FIGMA_GUARD_ALLOWED_TOOLS;
  if (!allowed.includes(tool)) {
    return {
      allow: false,
      rule: "figma_tool_not_allowed",
      reason: `Blocked by Figma guard: ${tool} is not available to this bot. Use ${allowed.join(", ")}.`,
    };
  }
  if (tool !== "figma_execute") return { allow: true };
  const input = isRecord(call.toolInput) ? call.toolInput : {};
  if (policy.fileKey && input.fileKey !== policy.fileKey) {
    return {
      allow: false,
      rule: "figma_file_key",
      reason: `Blocked by Figma guard: pass fileKey: "${policy.fileKey}" so the code runs in the CV file, not whichever file is active.`,
    };
  }
  return checkFigmaCode(input.code, policy);
}
