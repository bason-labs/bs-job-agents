// Minimal validator for the JSON Schema subset `toStrictJsonSchema` emits
// (type, properties, required, additionalProperties:false, items, enum, anyOf).
// Used in tests (and by fakes) to prove a value an engine would accept under the
// generated schema also passes the Zod schema, and vice versa.
import type { JsonSchema } from "./strict.js";

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function matchesType(t: string, v: unknown): boolean {
  switch (t) {
    case "null":
      return v === null;
    case "string":
      return typeof v === "string";
    case "boolean":
      return typeof v === "boolean";
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "array":
      return Array.isArray(v);
    case "object":
      return isObj(v);
    default:
      return false;
  }
}

function check(schema: JsonSchema, value: unknown, path: string, out: string[]): void {
  if (Array.isArray(schema.anyOf)) {
    const ok = (schema.anyOf as JsonSchema[]).some((b) => {
      const sub: string[] = [];
      check(b, value, path, sub);
      return sub.length === 0;
    });
    if (!ok) out.push(`${path}: matches no anyOf branch`);
    return;
  }
  const types = typeof schema.type === "string" ? [schema.type] : Array.isArray(schema.type) ? (schema.type as string[]) : [];
  if (types.length > 0 && !types.some((t) => matchesType(t, value))) {
    out.push(`${path}: expected ${types.join("|")}`);
    return;
  }
  if (Array.isArray(schema.enum) && value !== null && !schema.enum.includes(value)) {
    out.push(`${path}: not in enum`);
    return;
  }
  if (Array.isArray(value) && isObj(schema.items)) {
    value.forEach((item, i) => check(schema.items as JsonSchema, item, `${path}[${i}]`, out));
  }
  if (isObj(value) && isObj(schema.properties)) {
    const props = schema.properties as Record<string, JsonSchema>;
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(value)) {
        if (!(k in props)) out.push(`${path}: unexpected property ${k}`);
      }
    }
    for (const r of (schema.required as string[] | undefined) ?? []) {
      if (!(r in value)) out.push(`${path}: missing property ${r}`);
    }
    for (const [k, sub] of Object.entries(props)) {
      if (k in value) check(sub, value[k], `${path}.${k}`, out);
    }
  }
}

/** Validate `value` against a schema in the strict subset; returns issues (empty = valid). */
export function validateJsonSchemaSubset(schema: JsonSchema, value: unknown): string[] {
  const out: string[] = [];
  check(schema, value, "$", out);
  return out;
}
