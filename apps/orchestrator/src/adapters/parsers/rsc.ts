// The React Server Components payload a Next.js App Router page embeds (2026-10-20 addendum:
// VietnamWorks job pages, no JSON-LD). Each `self.__next_f.push([1, "…"])` script adds a piece of
// one "flight" text; joined in order, it is a list of rows:
//   <hex id>:<one JSON value>\n            a model row (objects, lists, element tuples)
//   <hex id>:T<hex byte length>,<text>     a text row (HTML); the length counts UTF-8 bytes, no newline
// A string "$<hex>" in a model row points at another row (a long text or a shared list), and
// "$<hex>:<key>:<key>…" at a value inside that row; "$$…" is a literal "$…". Other "$" forms ("$L27"
// lazy components, "$undefined", "$D<date>") are left as they are.
// No DOM and no eval: the scripts are found with a regex and their array parsed as JSON.

export type FlightRow = { kind: "text"; text: string } | { kind: "model"; raw: string };

/** The joined flight text of a page: every push([1, string]) in order. Empty when there is none. */
export function flightText(html: string): string {
  let out = "";
  for (const m of html.matchAll(/<script\b[^>]*>\s*self\.__next_f\.push\(([\s\S]*?)\)\s*;?\s*<\/script\s*>/gi)) {
    let chunk: unknown;
    try {
      chunk = JSON.parse(m[1]!);
    } catch {
      continue;
    }
    if (Array.isArray(chunk) && chunk[0] === 1 && typeof chunk[1] === "string") out += chunk[1];
  }
  return out;
}

const COLON = 0x3a;
const NEWLINE = 0x0a;
const COMMA = 0x2c;
const isHex = (b: number) => (b >= 0x30 && b <= 0x39) || (b >= 0x61 && b <= 0x66);

/** The flight text's rows by id. Bytes, not characters, so a text row's length is read exactly. */
export function flightRows(flight: string): Map<string, FlightRow> {
  const buf = Buffer.from(flight, "utf8");
  const rows = new Map<string, FlightRow>();
  const lineEnd = (from: number) => {
    const j = buf.indexOf(NEWLINE, from);
    return j < 0 ? buf.length : j;
  };
  let i = 0;
  while (i < buf.length) {
    let j = i;
    while (j < buf.length && isHex(buf[j]!)) j++;
    if (j === i || buf[j] !== COLON) {
      // Not a row start: skip to the next line.
      i = lineEnd(i) + 1;
      continue;
    }
    const id = buf.toString("latin1", i, j);
    i = j + 1;
    if (buf[i] === 0x54 /* T */) {
      const comma = buf.indexOf(COMMA, i);
      const length = comma < 0 ? NaN : parseInt(buf.toString("latin1", i + 1, comma), 16);
      if (!Number.isFinite(length)) {
        i = lineEnd(i) + 1;
        continue;
      }
      const start = comma + 1;
      rows.set(id, { kind: "text", text: buf.toString("utf8", start, Math.min(buf.length, start + length)) });
      i = start + length;
    } else {
      const end = lineEnd(i);
      rows.set(id, { kind: "model", raw: buf.toString("utf8", i, end) });
      i = end + 1;
    }
  }
  return rows;
}

const REF = /^\$([0-9a-f]+)((?::[^:]+)+)?$/;
const MAX_DEPTH = 32;

/**
 * A model value with every "$<hex>" reference replaced by its row (text rows as strings, model rows
 * parsed and resolved in turn). A missing, unparseable or circular reference stays as its string.
 */
export function resolveFlight(value: unknown, rows: ReadonlyMap<string, FlightRow>, seen: ReadonlySet<string> = new Set(), depth = 0): unknown {
  if (depth > MAX_DEPTH) return value;
  if (typeof value === "string") {
    if (value.startsWith("$$")) return value.slice(1);
    const ref = REF.exec(value);
    if (!ref || seen.has(ref[1]!)) return value;
    const row = rows.get(ref[1]!);
    if (!row) return value;
    if (row.kind === "text") return ref[2] ? value : row.text;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.raw);
    } catch {
      return value;
    }
    let target: unknown = resolveFlight(parsed, rows, new Set([...seen, ref[1]!]), depth + 1);
    // "$3:a:b": the value at keys a, b of row 3; a path that leads nowhere stays as its string.
    for (const key of ref[2] ? ref[2].slice(1).split(":") : []) {
      if (typeof target !== "object" || target === null || !Object.hasOwn(target, key)) return value;
      target = (target as Record<string, unknown>)[key];
    }
    return target;
  }
  if (Array.isArray(value)) return value.map((v) => resolveFlight(v, rows, seen, depth + 1));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveFlight(v, rows, seen, depth + 1)]));
  }
  return value;
}

/** The first `"<key>":"$<hex>"` reference in the model rows (the page row that hands a component its data). */
export function findFlightRef(rows: ReadonlyMap<string, FlightRow>, key: string): string | null {
  const pattern = new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}":"\\$([0-9a-f]+)"`);
  for (const row of rows.values()) {
    if (row.kind !== "model") continue;
    const m = pattern.exec(row.raw);
    if (m) return m[1]!;
  }
  return null;
}

/** The object a page passes as `key` (e.g. "jobDetail"), fully resolved; null when the page has none. */
export function flightObject(html: string, key: string): Record<string, unknown> | null {
  const rows = flightRows(flightText(html));
  const id = findFlightRef(rows, key);
  if (id === null) return null;
  const value = resolveFlight(`$${id}`, rows);
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
