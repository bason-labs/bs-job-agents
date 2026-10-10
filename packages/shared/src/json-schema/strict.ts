// Zod → strict JSON Schema converter (spec §5.5, spike S4).
//
// One converter feeds both engines:
// - Codex `--output-schema` rejects anything that is not OpenAI "strict":
//   every object has `additionalProperties: false`, every property is listed in
//   `required`, optional values are expressed as nullable, and the root is an object.
// - Claude `--json-schema` accepts the same form.
//
// Design choices:
// - Everything is inlined; `$ref` / `$defs` are never emitted. Recursive (lazy)
//   schemas are rejected instead.
// - Structural keywords (type, properties, required, additionalProperties,
//   items, enum, anyOf) plus `description` / `title`, and the constraint
//   keywords both engines were verified live to accept (QA phase 1):
//   numeric `minimum`/`maximum` (exclusive bounds become `exclusiveMinimum`/
//   `exclusiveMaximum`, or inclusive ±1 for integers), array `minItems`/
//   `maxItems`, and `format: "date-time"` for datetime strings. Without them
//   both models sent empty selfCheck arrays and invalid datetimes.
// - `pattern`, string lengths and other formats stay in Zod only: an
//   unbounded pattern such as `^.+_.+$` made Codex hang in the live check.
//   Zod validates every output after the run (a failure triggers the runner's
//   repair prompt).
// - Shapes strict mode cannot express (record, any, unknown, date, tuple, map,
//   set, bigint, intersection, catchall) throw a StrictSchemaError with the path.
import { ZodFirstPartyTypeKind, type ZodTypeAny } from "zod";

export type JsonSchema = { [key: string]: unknown };

export interface StrictJsonSchemaOptions {
  /** Emitted as the root `title`. */
  name?: string;
}

export class StrictSchemaError extends Error {
  constructor(
    message: string,
    /** JSONPath-like location: `$.a.b[]` for array items, `|n` for union branch n. */
    readonly path: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "StrictSchemaError";
  }
}

interface Unwrapped {
  inner: ZodTypeAny;
  nullable: boolean;
  optional: boolean;
  description: string | undefined;
}

// Zod internals are typed loosely on purpose: we only read `_def`.
type AnyDef = { typeName: ZodFirstPartyTypeKind; description?: string; [k: string]: unknown };
const defOf = (s: ZodTypeAny): AnyDef => s._def as AnyDef;

/** Peel wrappers that do not change the JSON shape the model must produce. */
function unwrap(schema: ZodTypeAny): Unwrapped {
  let node = schema;
  let nullable = false;
  let optional = false;
  let description: string | undefined;
  for (;;) {
    const def = defOf(node);
    description ??= def.description;
    switch (def.typeName) {
      case ZodFirstPartyTypeKind.ZodOptional:
        optional = true;
        node = def.innerType as ZodTypeAny;
        continue;
      case ZodFirstPartyTypeKind.ZodNullable:
        nullable = true;
        node = def.innerType as ZodTypeAny;
        continue;
      case ZodFirstPartyTypeKind.ZodDefault:
      case ZodFirstPartyTypeKind.ZodCatch:
      case ZodFirstPartyTypeKind.ZodReadonly:
        node = def.innerType as ZodTypeAny;
        continue;
      case ZodFirstPartyTypeKind.ZodBranded:
        node = def.type as ZodTypeAny;
        continue;
      case ZodFirstPartyTypeKind.ZodEffects:
        node = def.schema as ZodTypeAny;
        continue;
      case ZodFirstPartyTypeKind.ZodPipeline:
        node = def.in as ZodTypeAny;
        continue;
      default:
        return { inner: node, nullable, optional, description };
    }
  }
}

const PRIMITIVE_TYPES = new Set(["string", "number", "integer", "boolean"]);

function makeNullable(schema: JsonSchema): JsonSchema {
  const { description, ...rest } = schema;
  let out: JsonSchema;
  if (Array.isArray(rest.anyOf)) {
    const branches = rest.anyOf as JsonSchema[];
    out = branches.some((b) => b.type === "null")
      ? rest
      : { ...rest, anyOf: [...branches, { type: "null" }] };
  } else if (rest.type === "null") {
    out = rest;
  } else if (
    typeof rest.type === "string" &&
    PRIMITIVE_TYPES.has(rest.type) &&
    rest.enum === undefined &&
    Object.keys(rest).length === 1
  ) {
    out = { type: [rest.type, "null"] };
  } else {
    out = { anyOf: [rest, { type: "null" }] };
  }
  return description === undefined ? out : { ...out, description };
}

function jsonTypeOf(value: unknown, path: string): "string" | "integer" | "number" | "boolean" {
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return Number.isInteger(value) ? "integer" : "number";
    case "boolean":
      return "boolean";
    default:
      throw new StrictSchemaError(`unsupported literal value ${String(value)}`, path);
  }
}

function enumOf(values: readonly unknown[], path: string): JsonSchema {
  const types = new Set(values.map((v) => jsonTypeOf(v, path)));
  // integer ⊂ number: a mix of 1 and 1.5 is "number"
  if (types.has("integer") && types.has("number")) types.delete("integer");
  if (types.size !== 1) {
    throw new StrictSchemaError("enum mixes value types", path);
  }
  return { type: [...types][0], enum: [...values] };
}

function isLiteralLike(s: ZodTypeAny): boolean {
  const t = defOf(s).typeName;
  return t === ZodFirstPartyTypeKind.ZodLiteral || t === ZodFirstPartyTypeKind.ZodEnum;
}

function literalValues(s: ZodTypeAny): unknown[] {
  const def = defOf(s);
  return def.typeName === ZodFirstPartyTypeKind.ZodLiteral
    ? [def.value]
    : [...(def.values as readonly unknown[])];
}

function convertUnion(options: readonly ZodTypeAny[], path: string): { schema: JsonSchema; nullable: boolean } {
  // Flatten nested unions and pull out null members.
  let nullable = false;
  const members: ZodTypeAny[] = [];
  const visit = (opts: readonly ZodTypeAny[]) => {
    for (const opt of opts) {
      const u = unwrap(opt);
      if (u.nullable || u.optional) nullable = true;
      const t = defOf(u.inner).typeName;
      if (t === ZodFirstPartyTypeKind.ZodNull || t === ZodFirstPartyTypeKind.ZodUndefined) {
        nullable = true;
      } else if (t === ZodFirstPartyTypeKind.ZodUnion || t === ZodFirstPartyTypeKind.ZodDiscriminatedUnion) {
        visit(unionOptions(u.inner));
      } else {
        members.push(u.inner);
      }
    }
  };
  visit(options);

  if (members.length === 0) return { schema: { type: "null" }, nullable: false };
  if (members.every(isLiteralLike)) {
    return { schema: enumOf(members.flatMap(literalValues), path), nullable };
  }
  if (members.length === 1) {
    return { schema: convertNode(members[0] as ZodTypeAny, path), nullable };
  }
  return {
    schema: { anyOf: members.map((m, i) => convertNode(m, `${path}|${i}`)) },
    nullable,
  };
}

function unionOptions(s: ZodTypeAny): readonly ZodTypeAny[] {
  const def = defOf(s);
  if (def.typeName === ZodFirstPartyTypeKind.ZodDiscriminatedUnion) {
    return def.options as readonly ZodTypeAny[];
  }
  return def.options as readonly ZodTypeAny[];
}

/** Convert a schema including its nullable/optional wrappers. */
function convertNode(schema: ZodTypeAny, path: string): JsonSchema {
  const u = unwrap(schema);
  const t = defOf(u.inner).typeName;
  let out: JsonSchema;
  let nullable = u.nullable || u.optional;
  if (t === ZodFirstPartyTypeKind.ZodUnion || t === ZodFirstPartyTypeKind.ZodDiscriminatedUnion) {
    const r = convertUnion(unionOptions(u.inner), path);
    out = r.schema;
    nullable ||= r.nullable;
  } else {
    out = convertBase(u.inner, path);
  }
  if (u.description !== undefined) out = { ...out, description: u.description };
  return nullable ? makeNullable(out) : out;
}

type NumberCheck = { kind: string; value?: number; inclusive?: boolean };
type LengthCheck = { value: number } | null | undefined;

/** `minimum`/`maximum` from Zod number checks; exclusive integer bounds become inclusive. */
function numberBounds(checks: readonly NumberCheck[], integer: boolean): JsonSchema {
  const out: JsonSchema = {};
  for (const c of checks) {
    if ((c.kind !== "min" && c.kind !== "max") || typeof c.value !== "number") continue;
    const isMin = c.kind === "min";
    if (c.inclusive || integer) {
      const value = c.inclusive ? c.value : isMin ? Math.floor(c.value) + 1 : Math.ceil(c.value) - 1;
      const key = isMin ? "minimum" : "maximum";
      const prev = out[key] as number | undefined;
      out[key] = prev === undefined ? value : isMin ? Math.max(prev, value) : Math.min(prev, value);
    } else {
      out[isMin ? "exclusiveMinimum" : "exclusiveMaximum"] = c.value;
    }
  }
  return out;
}

function convertBase(schema: ZodTypeAny, path: string): JsonSchema {
  const def = defOf(schema);
  switch (def.typeName) {
    case ZodFirstPartyTypeKind.ZodString: {
      const checks = (def.checks as Array<{ kind: string }> | undefined) ?? [];
      return checks.some((c) => c.kind === "datetime") ? { type: "string", format: "date-time" } : { type: "string" };
    }
    case ZodFirstPartyTypeKind.ZodNumber: {
      const checks = (def.checks as NumberCheck[] | undefined) ?? [];
      const integer = checks.some((c) => c.kind === "int");
      return { type: integer ? "integer" : "number", ...numberBounds(checks, integer) };
    }
    case ZodFirstPartyTypeKind.ZodBoolean:
      return { type: "boolean" };
    case ZodFirstPartyTypeKind.ZodNull:
      return { type: "null" };
    case ZodFirstPartyTypeKind.ZodLiteral:
      if (def.value === null) return { type: "null" };
      return enumOf([def.value], path);
    case ZodFirstPartyTypeKind.ZodEnum:
      return enumOf(def.values as readonly unknown[], path);
    case ZodFirstPartyTypeKind.ZodNativeEnum: {
      const obj = def.values as Record<string, string | number>;
      // Numeric TS enums carry reverse mappings (value → key); drop those keys.
      const values = Object.keys(obj)
        .filter((k) => typeof obj[obj[k] as string] !== "number")
        .map((k) => obj[k]);
      return enumOf(values, path);
    }
    case ZodFirstPartyTypeKind.ZodArray: {
      const exact = (def.exactLength as LengthCheck)?.value;
      const min = exact ?? (def.minLength as LengthCheck)?.value;
      const max = exact ?? (def.maxLength as LengthCheck)?.value;
      return {
        type: "array",
        items: convertNode(def.type as ZodTypeAny, `${path}[]`),
        ...(min !== undefined && min > 0 ? { minItems: min } : {}),
        ...(max !== undefined ? { maxItems: max } : {}),
      };
    }
    case ZodFirstPartyTypeKind.ZodObject: {
      const catchall = defOf(def.catchall as ZodTypeAny).typeName;
      if (catchall !== ZodFirstPartyTypeKind.ZodNever) {
        throw new StrictSchemaError("objects with catchall cannot be strict", path);
      }
      const shape = (def.shape as () => Record<string, ZodTypeAny>)();
      const properties: Record<string, JsonSchema> = {};
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = convertNode(value, `${path}.${key}`);
      }
      return {
        type: "object",
        properties,
        required: Object.keys(shape),
        additionalProperties: false,
      };
    }
    case ZodFirstPartyTypeKind.ZodUnion:
    case ZodFirstPartyTypeKind.ZodDiscriminatedUnion:
      return convertNode(schema, path);
    case ZodFirstPartyTypeKind.ZodLazy:
      throw new StrictSchemaError("recursive (lazy) schemas would need $ref; inline them", path);
    default:
      throw new StrictSchemaError(
        `${def.typeName} cannot be expressed in strict JSON Schema`,
        path,
      );
  }
}

/**
 * Convert a Zod object schema into a JSON Schema accepted by Codex strict mode
 * (`--output-schema`) and Claude (`--json-schema`).
 *
 * Note: an `.optional()` field becomes required + nullable, so the model sends
 * `null`. Bot output schemas therefore use `.nullable()` instead of
 * `.optional()` (see `findOptionalPaths`), keeping Zod and JSON Schema in step.
 */
export function toStrictJsonSchema(schema: ZodTypeAny, options: StrictJsonSchemaOptions = {}): JsonSchema {
  const root = unwrap(schema);
  if (root.nullable || root.optional) {
    throw new StrictSchemaError("root must be an object (not nullable or optional)", "$");
  }
  if (defOf(root.inner).typeName !== ZodFirstPartyTypeKind.ZodObject) {
    throw new StrictSchemaError(`root must be an object, got ${defOf(root.inner).typeName}`, "$");
  }
  const out = convertBase(root.inner, "$");
  const withDesc = root.description === undefined ? out : { ...out, description: root.description };
  return options.name === undefined ? withDesc : { title: options.name, ...withDesc };
}

/**
 * List every field reachable in `schema` that is `.optional()` or `.default()`.
 * Bot output schemas must have none: the model sends `null` for absent values,
 * which only a `.nullable()` field accepts.
 */
export function findOptionalPaths(schema: ZodTypeAny, path = "$"): string[] {
  const def = defOf(schema);
  switch (def.typeName) {
    case ZodFirstPartyTypeKind.ZodOptional:
    case ZodFirstPartyTypeKind.ZodDefault:
      return [path, ...findOptionalPaths(def.innerType as ZodTypeAny, path).filter((p) => p !== path)];
    case ZodFirstPartyTypeKind.ZodNullable:
    case ZodFirstPartyTypeKind.ZodCatch:
    case ZodFirstPartyTypeKind.ZodReadonly:
      return findOptionalPaths(def.innerType as ZodTypeAny, path);
    case ZodFirstPartyTypeKind.ZodBranded:
      return findOptionalPaths(def.type as ZodTypeAny, path);
    case ZodFirstPartyTypeKind.ZodEffects:
      return findOptionalPaths(def.schema as ZodTypeAny, path);
    case ZodFirstPartyTypeKind.ZodPipeline:
      return findOptionalPaths(def.in as ZodTypeAny, path);
    case ZodFirstPartyTypeKind.ZodArray:
      return findOptionalPaths(def.type as ZodTypeAny, `${path}[]`);
    case ZodFirstPartyTypeKind.ZodObject: {
      const shape = (def.shape as () => Record<string, ZodTypeAny>)();
      return Object.entries(shape).flatMap(([k, v]) => findOptionalPaths(v, `${path}.${k}`));
    }
    case ZodFirstPartyTypeKind.ZodUnion:
    case ZodFirstPartyTypeKind.ZodDiscriminatedUnion:
      return unionOptions(schema).flatMap((o, i) => findOptionalPaths(o, `${path}|${i}`));
    default:
      return [];
  }
}
