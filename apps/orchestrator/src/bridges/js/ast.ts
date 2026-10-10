// Small JavaScript AST toolkit (acorn) for the guards: parse, walk, and resolve static strings.
import { parse, type AnyNode, type Expression, type MemberExpression, type Options, type Program } from "acorn";

export type ParseResult = { ok: true; program: Program } | { ok: false; error: string };

const BASE_OPTIONS: Options = {
  ecmaVersion: "latest",
  allowHashBang: true,
  allowAwaitOutsideFunction: true,
  allowReturnOutsideFunction: true,
};

/**
 * `script`: page code with REPL semantics (top-level await/return; module syntax as a fallback).
 * `async-function-body`: Figma plugin code, parsed exactly as the Desktop Bridge runs it,
 * inside `(async function() { … })()`.
 */
export function parseJs(code: string, mode: "script" | "async-function-body"): ParseResult {
  if (mode === "async-function-body") {
    try {
      return { ok: true, program: parse(`(async function() {\n${code}\n})()`, { ...BASE_OPTIONS, sourceType: "script" }) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
  try {
    return { ok: true, program: parse(code, { ...BASE_OPTIONS, sourceType: "script" }) };
  } catch (scriptErr) {
    try {
      return { ok: true, program: parse(code, { ...BASE_OPTIONS, sourceType: "module" }) };
    } catch {
      return { ok: false, error: (scriptErr as Error).message };
    }
  }
}

function isNode(value: unknown): value is AnyNode {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

const SKIP_KEYS = new Set(["type", "start", "end", "loc", "range", "raw", "regex", "value"]);

export type Visitor = (
  node: AnyNode,
  parent: AnyNode | null,
  key: string | null,
  /** Ancestors from the root down to `parent`. */
  ancestors: readonly AnyNode[],
) => void;

/** Depth-first walk over every node; the callback sees a node before its children. */
export function visit(root: AnyNode, enter: Visitor): void {
  const stack: AnyNode[] = [];
  const rec = (node: AnyNode, parent: AnyNode | null, key: string | null) => {
    enter(node, parent, key, stack);
    stack.push(node);
    for (const [k, v] of Object.entries(node)) {
      if (SKIP_KEYS.has(k) && !(k === "value" && isNode(v))) continue;
      if (Array.isArray(v)) {
        for (const item of v) if (isNode(item)) rec(item, node, k);
      } else if (isNode(v)) {
        rec(v, node, k);
      }
    }
    stack.pop();
  };
  rec(root, null, null);
}

/**
 * Whether an Identifier at `parent[key]` reads or writes a variable, rather than being a
 * property name, a label or a new binding. `grandparent` tells object patterns from literals.
 */
export function isReference(parent: AnyNode | null, key: string | null, grandparent: AnyNode | null): boolean {
  if (!parent) return true;
  switch (parent.type) {
    case "MemberExpression":
      return key === "object" || parent.computed;
    case "Property":
      if (key === "key") return parent.computed;
      return grandparent?.type !== "ObjectPattern";
    case "MethodDefinition":
    case "PropertyDefinition":
      return key === "key" ? parent.computed : true;
    case "VariableDeclarator":
      return key === "init";
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      return key === "body";
    case "ClassDeclaration":
    case "ClassExpression":
      return key === "superClass";
    case "LabeledStatement":
    case "BreakStatement":
    case "ContinueStatement":
    case "CatchClause":
    case "ImportSpecifier":
    case "ImportDefaultSpecifier":
    case "ImportNamespaceSpecifier":
    case "ExportSpecifier":
    case "MetaProperty":
    case "ArrayPattern":
    case "ObjectPattern":
    case "RestElement":
      return false;
    case "AssignmentPattern":
      return key === "right";
    default:
      return true;
  }
}

/** Static name of a member access: `a.b`, `a["b"]`, ``a[`b`]``, `a[0]`; null when computed at run time. */
export function staticPropName(member: MemberExpression): string | null {
  const p = member.property;
  if (!member.computed) return p.type === "Identifier" ? p.name : p.type === "PrivateIdentifier" ? `#${p.name}` : null;
  if (p.type === "Literal" && (typeof p.value === "string" || typeof p.value === "number")) return String(p.value);
  if (p.type === "TemplateLiteral" && p.expressions.length === 0) return p.quasis[0]?.value.cooked ?? null;
  return null;
}

/** A string known exactly, or only its leading part (the rest is computed at run time). */
export type StaticValue = { exact: string } | { prefix: string };

/** `const NAME = "literal"` bindings that are never reassigned. */
export function collectStringConstants(program: Program): Map<string, string> {
  const candidates = new Map<string, string>();
  const tainted = new Set<string>();
  visit(program, (node) => {
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier") {
      const name = node.id.name;
      const v = node.init ? staticValue(node.init, new Map()) : null;
      if (v && "exact" in v && !candidates.has(name)) candidates.set(name, v.exact);
      else tainted.add(name);
      if (candidates.has(name) && v && "exact" in v && candidates.get(name) !== v.exact) tainted.add(name);
    } else if (node.type === "AssignmentExpression" && node.left.type === "Identifier") {
      tainted.add(node.left.name);
    } else if (node.type === "UpdateExpression" && node.argument.type === "Identifier") {
      tainted.add(node.argument.name);
    }
  });
  for (const name of tainted) candidates.delete(name);
  return candidates;
}

function concat(left: StaticValue, right: StaticValue | null): StaticValue {
  if ("prefix" in left) return left;
  if (!right) return { prefix: left.exact };
  return "exact" in right ? { exact: left.exact + right.exact } : { prefix: left.exact + right.prefix };
}

/** Resolves an expression to a string where the code makes that possible. */
export function staticValue(expr: AnyNode, constants: ReadonlyMap<string, string>): StaticValue | null {
  switch (expr.type) {
    case "Literal":
      if (typeof expr.value === "string") return { exact: expr.value };
      if (typeof expr.value === "number" || typeof expr.value === "boolean") return { exact: String(expr.value) };
      return null;
    case "TemplateLiteral": {
      let acc: StaticValue = { exact: expr.quasis[0]?.value.cooked ?? "" };
      for (let i = 0; i < expr.expressions.length; i++) {
        const part = staticValue(expr.expressions[i] as Expression, constants);
        acc = concat(acc, part);
        if ("prefix" in acc) return acc;
        acc = concat(acc, { exact: expr.quasis[i + 1]?.value.cooked ?? "" });
      }
      return acc;
    }
    case "BinaryExpression": {
      if (expr.operator !== "+") return null;
      const left = staticValue(expr.left, constants);
      return left ? concat(left, staticValue(expr.right, constants)) : null;
    }
    case "Identifier": {
      const c = constants.get(expr.name);
      return c === undefined ? null : { exact: c };
    }
    case "MemberExpression": {
      // new URL("…").href / .toString
      const name = staticPropName(expr);
      if (name === "href" && expr.object.type === "NewExpression") return staticValue(expr.object, constants);
      return null;
    }
    case "NewExpression":
    case "CallExpression": {
      const callee = expr.callee;
      const first = expr.arguments[0];
      if (callee.type === "Identifier" && first && first.type !== "SpreadElement") {
        if (callee.name === "String" && expr.type === "CallExpression") return staticValue(first, constants);
        if (callee.name === "URL" && expr.type === "NewExpression" && expr.arguments.length === 1) {
          return staticValue(first, constants);
        }
      }
      if (
        expr.type === "CallExpression" &&
        callee.type === "MemberExpression" &&
        staticPropName(callee) === "toString" &&
        callee.object.type === "NewExpression"
      ) {
        return staticValue(callee.object, constants);
      }
      return null;
    }
    case "ParenthesizedExpression":
      return staticValue(expr.expression, constants);
    default:
      return null;
  }
}
