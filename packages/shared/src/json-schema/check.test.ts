import { describe, expect, it } from "vitest";
import { assertStrictJsonSchema, checkStrictJsonSchema } from "./check.js";
import { validateJsonSchemaSubset } from "./validate.js";

const ok = {
  type: "object",
  properties: {
    a: { type: "string" },
    b: { anyOf: [{ type: "object", properties: {}, required: [], additionalProperties: false }, { type: "null" }] },
    c: { type: "array", items: { type: "object", properties: { x: { type: ["integer", "null"] } }, required: ["x"], additionalProperties: false } },
  },
  required: ["a", "b", "c"],
  additionalProperties: false,
};

describe("checkStrictJsonSchema", () => {
  it("accepts a strict schema", () => {
    expect(checkStrictJsonSchema(ok)).toEqual([]);
    expect(() => assertStrictJsonSchema(ok)).not.toThrow();
  });

  it("requires an object root", () => {
    expect(checkStrictJsonSchema({ type: "string" })).toContain("$: root must be type object");
    expect(checkStrictJsonSchema({ anyOf: [ok, { type: "null" }] }).length).toBeGreaterThan(0);
  });

  it("flags missing additionalProperties:false at any depth", () => {
    const bad = structuredClone(ok) as typeof ok;
    (bad.properties.c.items as Record<string, unknown>).additionalProperties = true;
    expect(checkStrictJsonSchema(bad)).toEqual(["$.c[]: additionalProperties must be false"]);
  });

  it("flags properties missing from required", () => {
    const bad = { ...ok, required: ["a", "b"] };
    expect(checkStrictJsonSchema(bad)).toEqual(["$: required must list every property (missing: c)"]);
  });

  it("flags required entries that are not properties", () => {
    const bad = { ...ok, required: ["a", "b", "c", "zzz"] };
    expect(checkStrictJsonSchema(bad)).toEqual(["$: required lists unknown property zzz"]);
  });

  it("flags objects nested in anyOf", () => {
    const bad = structuredClone(ok) as typeof ok;
    delete (bad.properties.b.anyOf[0] as Record<string, unknown>).additionalProperties;
    expect(checkStrictJsonSchema(bad)).toEqual(["$.b|0: additionalProperties must be false"]);
  });

  it("flags $ref, definitions and unsupported combinators", () => {
    const bad = {
      ...ok,
      properties: { ...ok.properties, r: { $ref: "#/$defs/x" }, o: { oneOf: [{ type: "string" }] } },
      required: [...ok.required, "r", "o"],
      $defs: { x: { type: "string" } },
    };
    const issues = checkStrictJsonSchema(bad);
    expect(issues).toContain("$: $defs is not allowed");
    expect(issues).toContain("$.r: $ref is not allowed");
    expect(issues).toContain("$.o: oneOf is not allowed");
  });

  it("flags arrays without items and nodes without a type", () => {
    const bad = {
      type: "object",
      properties: { a: { type: "array" }, b: {} },
      required: ["a", "b"],
      additionalProperties: false,
    };
    expect(checkStrictJsonSchema(bad)).toEqual([
      "$.a: array must declare items",
      "$.b: schema must declare type, enum or anyOf",
    ]);
  });

  it("assertStrictJsonSchema throws with all issues listed", () => {
    expect(() => assertStrictJsonSchema({ type: "string" })).toThrow(/root must be type object/);
  });
});

describe("validateJsonSchemaSubset", () => {
  it("accepts matching values and reports mismatches with paths", () => {
    expect(validateJsonSchemaSubset(ok, { a: "x", b: null, c: [{ x: 1 }, { x: null }] })).toEqual([]);
    expect(validateJsonSchemaSubset(ok, { a: 1, b: {}, c: [{ x: 1.5 }], extra: true })).toEqual([
      "$: unexpected property extra",
      "$.a: expected string",
      "$.c[0].x: expected integer|null",
    ]);
    expect(validateJsonSchemaSubset(ok, { a: "x", c: [] })).toEqual(["$: missing property b"]);
  });

  it("checks enums and anyOf", () => {
    const s = { type: "object", properties: { e: { type: "string", enum: ["a"] }, u: { anyOf: [{ type: "string" }, { type: "null" }] } }, required: ["e", "u"], additionalProperties: false };
    expect(validateJsonSchemaSubset(s, { e: "b", u: 3 })).toEqual(["$.e: not in enum", "$.u: matches no anyOf branch"]);
  });
});
