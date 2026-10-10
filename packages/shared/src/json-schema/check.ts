// Recursive strictness checker for JSON Schemas sent to the engines (spike S4).
// The runner can call `assertStrictJsonSchema` at startup for every bot schema.
import type { JsonSchema } from "./strict.js";

const FORBIDDEN_KEYS = [
  "$ref",
  "$defs",
  "definitions",
  "oneOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "patternProperties",
  "dependentSchemas",
  "prefixItems",
] as const;

const KNOWN_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

const isObj = (v: unknown): v is JsonSchema => typeof v === "object" && v !== null && !Array.isArray(v);

function typesOf(node: JsonSchema): string[] {
  if (typeof node.type === "string") return [node.type];
  if (Array.isArray(node.type)) return node.type.filter((t): t is string => typeof t === "string");
  return [];
}

function walk(node: unknown, path: string, issues: string[]): void {
  if (!isObj(node)) {
    issues.push(`${path}: schema must be an object`);
    return;
  }
  for (const key of FORBIDDEN_KEYS) {
    if (key in node) issues.push(`${path}: ${key} is not allowed`);
  }
  const types = typesOf(node);
  for (const t of types) {
    if (!KNOWN_TYPES.has(t)) issues.push(`${path}: unknown type ${t}`);
  }
  if (types.length === 0 && node.enum === undefined && node.anyOf === undefined && node.$ref === undefined) {
    issues.push(`${path}: schema must declare type, enum or anyOf`);
  }

  if (types.includes("object") || "properties" in node) {
    if (node.additionalProperties !== false) {
      issues.push(`${path}: additionalProperties must be false`);
    }
    const props = isObj(node.properties) ? node.properties : undefined;
    if (!props) {
      issues.push(`${path}: object must declare properties`);
    } else {
      const keys = Object.keys(props);
      const required = Array.isArray(node.required) ? (node.required as unknown[]) : [];
      const missing = keys.filter((k) => !required.includes(k));
      if (missing.length > 0) {
        issues.push(`${path}: required must list every property (missing: ${missing.join(", ")})`);
      }
      for (const r of required) {
        if (typeof r !== "string" || !keys.includes(r)) {
          issues.push(`${path}: required lists unknown property ${String(r)}`);
        }
      }
      for (const k of keys) walk(props[k], `${path}.${k}`, issues);
    }
  }

  if (types.includes("array")) {
    if (node.items === undefined) issues.push(`${path}: array must declare items`);
    else walk(node.items, `${path}[]`, issues);
  }

  if (node.anyOf !== undefined) {
    if (!Array.isArray(node.anyOf) || node.anyOf.length === 0) {
      issues.push(`${path}: anyOf must be a non-empty array`);
    } else {
      node.anyOf.forEach((branch, i) => walk(branch, `${path}|${i}`, issues));
    }
  }
}

/** Return every strictness violation in `schema` (empty array = strict). */
export function checkStrictJsonSchema(schema: unknown): string[] {
  const issues: string[] = [];
  if (!isObj(schema) || schema.type !== "object") {
    issues.push("$: root must be type object");
    if (!isObj(schema)) return issues;
  }
  walk(schema, "$", issues);
  return issues;
}

/** Throw if `schema` is not strict; the message lists every violation. */
export function assertStrictJsonSchema(schema: unknown, name = "schema"): void {
  const issues = checkStrictJsonSchema(schema);
  if (issues.length > 0) {
    throw new Error(`${name} is not a strict JSON Schema:\n- ${issues.join("\n- ")}`);
  }
}
