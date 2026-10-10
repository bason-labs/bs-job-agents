import { describe, expect, it } from "vitest";
import { z } from "zod";
import { checkStrictJsonSchema } from "./check.js";
import { StrictSchemaError, findOptionalPaths, toStrictJsonSchema } from "./strict.js";
import { validateJsonSchemaSubset } from "./validate.js";

describe("toStrictJsonSchema", () => {
  it("converts a flat object: all keys required, additionalProperties false", () => {
    const s = z.object({ a: z.string(), b: z.number(), c: z.boolean() });
    expect(toStrictJsonSchema(s)).toEqual({
      type: "object",
      properties: {
        a: { type: "string" },
        b: { type: "number" },
        c: { type: "boolean" },
      },
      required: ["a", "b", "c"],
      additionalProperties: false,
    });
  });

  it("maps int checks to integer", () => {
    const js = toStrictJsonSchema(z.object({ n: z.number().int() }));
    expect(js.properties).toEqual({ n: { type: "integer" } });
  });

  // QA phase 1 live check (docs/superpowers/build/qa-phase-1.md): Codex strict mode and
  // Claude --json-schema both accept these keywords, and without them both models sent
  // empty selfCheck arrays and invalid datetimes.
  describe("constraint keywords both engines accept", () => {
    it("emits inclusive numeric bounds as minimum / maximum", () => {
      const js = toStrictJsonSchema(z.object({ n: z.number().int().min(0).max(100), x: z.number().nonnegative() }));
      expect(js.properties).toEqual({
        n: { type: "integer", minimum: 0, maximum: 100 },
        x: { type: "number", minimum: 0 },
      });
    });

    it("emits exclusive bounds exactly (integers become inclusive)", () => {
      const js = toStrictJsonSchema(
        z.object({ i: z.number().int().positive().lt(10), f: z.number().gt(0).lt(1) }),
      );
      expect(js.properties).toEqual({
        i: { type: "integer", minimum: 1, maximum: 9 },
        f: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 },
      });
    });

    it("emits array length bounds as minItems / maxItems", () => {
      const js = toStrictJsonSchema(
        z.object({
          a: z.array(z.string()).min(1).max(3),
          b: z.array(z.string()).length(2),
          c: z.array(z.string()).nonempty(),
        }),
      );
      expect(js.properties).toEqual({
        a: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 },
        b: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2 },
        c: { type: "array", items: { type: "string" }, minItems: 1 },
      });
    });

    it("emits format date-time for datetime strings", () => {
      const js = toStrictJsonSchema(z.object({ at: z.string().datetime({ offset: true }) }));
      expect(js.properties).toEqual({ at: { type: "string", format: "date-time" } });
    });

    it("keeps bounds on nullable values (anyOf with null)", () => {
      const js = toStrictJsonSchema(
        z.object({ n: z.number().int().min(0).nullable(), at: z.string().datetime().nullable() }),
      );
      expect(js.properties).toEqual({
        n: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] },
        at: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
      });
      expect(checkStrictJsonSchema(js)).toEqual([]);
    });

    it("never emits pattern, string lengths or other formats (unbounded patterns hang Codex)", () => {
      const js = toStrictJsonSchema(
        z.object({ s: z.string().regex(/^.+_.+_(EN|VI)_v\d+$/).min(1).max(30), u: z.string().url(), e: z.string().email() }),
      );
      expect(js.properties).toEqual({ s: { type: "string" }, u: { type: "string" }, e: { type: "string" } });
    });
  });

  it("turns optional fields into required + nullable", () => {
    const js = toStrictJsonSchema(z.object({ a: z.string().optional() }));
    expect(js.required).toEqual(["a"]);
    expect(js.properties).toEqual({ a: { type: ["string", "null"] } });
  });

  it("keeps nullable fields required + nullable", () => {
    const js = toStrictJsonSchema(z.object({ a: z.number().int().nullable() }));
    expect(js.properties).toEqual({ a: { type: ["integer", "null"] } });
  });

  it("does not double up null for optional + nullable", () => {
    const js = toStrictJsonSchema(z.object({ a: z.string().nullable().optional() }));
    expect(js.properties).toEqual({ a: { type: ["string", "null"] } });
  });

  it("treats defaults as required, non-nullable", () => {
    const js = toStrictJsonSchema(z.object({ a: z.number().default(5) }));
    expect(js.properties).toEqual({ a: { type: "number" } });
    expect(js.required).toEqual(["a"]);
  });

  it("wraps nullable objects and enums in anyOf with null", () => {
    const js = toStrictJsonSchema(
      z.object({
        o: z.object({ x: z.string() }).nullable(),
        e: z.enum(["a", "b"]).nullable(),
      }),
    );
    expect(js.properties).toEqual({
      o: {
        anyOf: [
          {
            type: "object",
            properties: { x: { type: "string" } },
            required: ["x"],
            additionalProperties: false,
          },
          { type: "null" },
        ],
      },
      e: { anyOf: [{ type: "string", enum: ["a", "b"] }, { type: "null" }] },
    });
  });

  it("converts enums, literals and unions of literals to enum", () => {
    const js = toStrictJsonSchema(
      z.object({
        e: z.enum(["x", "y"]),
        l: z.literal("only"),
        n: z.union([z.literal(1), z.literal(2)]),
        b: z.literal(true),
      }),
    );
    expect(js.properties).toEqual({
      e: { type: "string", enum: ["x", "y"] },
      l: { type: "string", enum: ["only"] },
      n: { type: "integer", enum: [1, 2] },
      b: { type: "boolean", enum: [true] },
    });
  });

  it("converts native enums", () => {
    enum Color {
      Red = "red",
      Blue = "blue",
    }
    const js = toStrictJsonSchema(z.object({ c: z.nativeEnum(Color) }));
    expect(js.properties).toEqual({ c: { type: "string", enum: ["red", "blue"] } });
  });

  it("converts arrays and nested objects recursively", () => {
    const js = toStrictJsonSchema(
      z.object({
        items: z.array(z.object({ id: z.string(), tags: z.array(z.string()).optional() })),
      }),
    );
    expect(js.properties).toEqual({
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            tags: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }] },
          },
          required: ["id", "tags"],
          additionalProperties: false,
        },
      },
    });
  });

  it("converts discriminated unions to anyOf of strict objects", () => {
    const u = z.discriminatedUnion("type", [
      z.object({ type: z.literal("a"), x: z.string() }),
      z.object({ type: z.literal("b"), y: z.number().optional() }),
    ]);
    const js = toStrictJsonSchema(z.object({ action: u }));
    expect(js.properties).toEqual({
      action: {
        anyOf: [
          {
            type: "object",
            properties: { type: { type: "string", enum: ["a"] }, x: { type: "string" } },
            required: ["type", "x"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: { type: { type: "string", enum: ["b"] }, y: { type: ["number", "null"] } },
            required: ["type", "y"],
            additionalProperties: false,
          },
        ],
      },
    });
    expect(checkStrictJsonSchema(js)).toEqual([]);
  });

  it("folds null members of a union into nullability", () => {
    const js = toStrictJsonSchema(z.object({ v: z.union([z.string(), z.null()]) }));
    expect(js.properties).toEqual({ v: { type: ["string", "null"] } });
  });

  it("flattens nested unions", () => {
    const js = toStrictJsonSchema(
      z.object({ v: z.union([z.string(), z.union([z.number(), z.boolean()])]) }),
    );
    expect(js.properties).toEqual({
      v: { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }] },
    });
  });

  it("keeps descriptions, including on nullable wrappers", () => {
    const js = toStrictJsonSchema(
      z.object({
        a: z.string().describe("the a"),
        b: z.string().optional().describe("the b"),
        c: z.object({ x: z.string() }).nullable().describe("the c"),
      }),
    );
    const props = js.properties as Record<string, Record<string, unknown>>;
    expect(props.a).toEqual({ type: "string", description: "the a" });
    expect(props.b).toEqual({ type: ["string", "null"], description: "the b" });
    expect(props.c?.description).toBe("the c");
    expect(props.c?.anyOf).toBeDefined();
  });

  it("unwraps refinements, transforms, brands, readonly, catch and pipelines", () => {
    const s = z
      .object({
        r: z.string().refine((v) => v.length > 0),
        t: z.string().transform((v) => v.length),
        br: z.string().brand<"X">(),
        ro: z.array(z.string()).readonly(),
        ca: z.number().catch(0),
        pi: z.string().pipe(z.string().min(1)),
        pre: z.preprocess((v) => v, z.boolean()),
      })
      .superRefine(() => undefined);
    const js = toStrictJsonSchema(s);
    expect(js.properties).toEqual({
      r: { type: "string" },
      t: { type: "string" },
      br: { type: "string" },
      ro: { type: "array", items: { type: "string" } },
      ca: { type: "number" },
      pi: { type: "string" },
      pre: { type: "boolean" },
    });
  });

  it("adds a title when a name is given", () => {
    const js = toStrictJsonSchema(z.object({ a: z.string() }), { name: "Thing" });
    expect(js.title).toBe("Thing");
  });

  it("never emits $ref even when a sub-schema is reused", () => {
    const shared = z.object({ id: z.string() });
    const js = toStrictJsonSchema(z.object({ a: shared, b: shared, list: z.array(shared) }));
    expect(JSON.stringify(js)).not.toContain("$ref");
    const props = js.properties as Record<string, unknown>;
    expect(props.a).toEqual(props.b);
    expect(checkStrictJsonSchema(js)).toEqual([]);
  });

  it("produces a schema the checker accepts for a deep mixed example", () => {
    const s = z.object({
      a: z.array(
        z.discriminatedUnion("k", [
          z.object({ k: z.literal("x"), n: z.object({ deep: z.string().optional() }).optional() }),
          z.object({ k: z.literal("y"), list: z.array(z.object({ v: z.number() })) }),
        ]),
      ),
      e: z.enum(["p", "q"]).optional(),
    });
    expect(checkStrictJsonSchema(toStrictJsonSchema(s))).toEqual([]);
  });

  describe("rejects shapes strict mode cannot express", () => {
    const cases: Array<[string, z.ZodTypeAny, string]> = [
      ["record", z.object({ r: z.record(z.string()) }), "$.r"],
      ["any", z.object({ a: z.any() }), "$.a"],
      ["unknown", z.object({ u: z.unknown() }), "$.u"],
      ["date", z.object({ d: z.date() }), "$.d"],
      ["tuple", z.object({ t: z.tuple([z.string(), z.number()]) }), "$.t"],
      ["map", z.object({ m: z.map(z.string(), z.string()) }), "$.m"],
      ["set", z.object({ s: z.set(z.string()) }), "$.s"],
      ["bigint", z.object({ b: z.bigint() }), "$.b"],
      ["intersection", z.object({ i: z.intersection(z.object({ a: z.string() }), z.object({ b: z.string() })) }), "$.i"],
      ["catchall", z.object({ o: z.object({ a: z.string() }).catchall(z.string()) }), "$.o"],
      ["nested in array", z.object({ list: z.array(z.object({ x: z.any() })) }), "$.list[].x"],
    ];
    it.each(cases)("%s", (_name, schema, path) => {
      expect(() => toStrictJsonSchema(schema)).toThrow(StrictSchemaError);
      try {
        toStrictJsonSchema(schema);
      } catch (err) {
        expect((err as StrictSchemaError).path).toBe(path);
      }
    });

    it("recursive (lazy) schemas", () => {
      type Node = { children: Node[] };
      const node: z.ZodType<Node> = z.lazy(() => z.object({ children: z.array(node) }));
      expect(() => toStrictJsonSchema(z.object({ root: node }))).toThrow(StrictSchemaError);
    });

    it("a non-object root", () => {
      expect(() => toStrictJsonSchema(z.string())).toThrow(/root must be an object/);
      expect(() => toStrictJsonSchema(z.array(z.object({})))).toThrow(StrictSchemaError);
      expect(() =>
        toStrictJsonSchema(z.union([z.object({ a: z.string() }), z.object({ b: z.string() })])),
      ).toThrow(StrictSchemaError);
    });

    it("a nullable or optional root", () => {
      expect(() => toStrictJsonSchema(z.object({}).nullable())).toThrow(StrictSchemaError);
      expect(() => toStrictJsonSchema(z.object({}).optional())).toThrow(StrictSchemaError);
    });
  });

  it("the subset validator enforces the emitted bounds and date-time format", () => {
    const js = toStrictJsonSchema(
      z.object({
        n: z.number().int().min(0).max(40),
        f: z.number().gt(0),
        list: z.array(z.string()).min(1).max(2),
        at: z.string().datetime({ offset: true }),
      }),
    );
    const ok = { n: 40, f: 0.5, list: ["a"], at: "2026-10-10T08:00:00+07:00" };
    expect(validateJsonSchemaSubset(js, ok)).toEqual([]);
    expect(validateJsonSchemaSubset(js, { ...ok, n: 41 })).toEqual(["$.n: above maximum 40"]);
    expect(validateJsonSchemaSubset(js, { ...ok, n: -1 })).toEqual(["$.n: below minimum 0"]);
    expect(validateJsonSchemaSubset(js, { ...ok, f: 0 })).toEqual(["$.f: not above exclusiveMinimum 0"]);
    expect(validateJsonSchemaSubset(js, { ...ok, list: [] })).toEqual(["$.list: fewer than 1 items"]);
    expect(validateJsonSchemaSubset(js, { ...ok, list: ["a", "b", "c"] })).toEqual(["$.list: more than 2 items"]);
    expect(validateJsonSchemaSubset(js, { ...ok, at: "yesterday" })).toEqual(["$.at: not a date-time"]);
  });

  it("round-trips: a value valid for the JSON Schema, with nulls, is valid for a nullable zod schema", () => {
    const s = z.object({
      a: z.string(),
      b: z.number().nullable(),
      c: z.array(z.object({ d: z.enum(["x", "y"]).nullable() })),
    });
    const js = toStrictJsonSchema(s);
    const value = { a: "1", b: null, c: [{ d: null }, { d: "x" }] };
    expect(validateJsonSchemaSubset(js, value)).toEqual([]);
    expect(s.safeParse(value).success).toBe(true);
  });
});

describe("findOptionalPaths", () => {
  it("is empty for schemas that use only nullable", () => {
    expect(
      findOptionalPaths(z.object({ a: z.string().nullable(), b: z.array(z.object({ c: z.number() })) })),
    ).toEqual([]);
  });

  it("lists every optional or default field, recursively", () => {
    const s = z.object({
      a: z.string().optional(),
      b: z.object({ c: z.number().default(1) }),
      d: z.array(z.object({ e: z.boolean().optional() })),
      u: z.discriminatedUnion("t", [z.object({ t: z.literal("x"), f: z.string().optional() })]),
    });
    expect(findOptionalPaths(s).sort()).toEqual(["$.a", "$.b.c", "$.d[].e", "$.u|0.f"].sort());
  });
});
