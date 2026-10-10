// Protected-page fingerprint (spec §6.2 write boundary): before and after each CV task the
// orchestrator records every protected page (all pages except Drafts): node ids, names, text,
// structure and geometry, plus the file's local styles and variables. Any difference fails
// the task and alerts Ba. This is the backstop for whatever the code guard cannot see.
import { sha256Bytes } from "../pdf/hash.js";

export interface FingerprintNode {
  id: string;
  type: string;
  name: string;
  parentId: string;
  /** Position among the parent's children. */
  index: number;
  visible?: boolean;
  locked?: boolean;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  /** TEXT nodes: the characters. */
  text?: string;
}

export interface PageSnapshot {
  id: string;
  name: string;
  nodes: FingerprintNode[];
}

export interface PageFingerprint extends PageSnapshot {
  hash: string;
  nodeCount: number;
}

export interface ProtectedPagesFingerprint {
  fileKey: string | null;
  draftsPageName: string;
  takenAt: string;
  /** SHA-256 over the page list, every page hash and the resources hash. */
  hash: string;
  /** Every page except Drafts, in document order. */
  pages: PageFingerprint[];
  /** Local paint/text/effect/grid styles and variables, as read from the file. */
  resources: unknown;
  resourcesHash: string | null;
  resourcesError: string | null;
}

/** JSON with object keys sorted at every level, so equal content always hashes the same. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, (v as Record<string, unknown>)[k]]));
    }
    return v;
  });
}

const hashOf = (value: unknown) => sha256Bytes(canonicalJson(value));

export interface BuildFingerprintInput {
  fileKey: string | null;
  draftsPageName: string;
  pages: PageSnapshot[];
  resources: unknown;
  resourcesError?: string | null;
  takenAt: string;
}

export function buildFingerprint(input: BuildFingerprintInput): ProtectedPagesFingerprint {
  const pages = input.pages.map((p) => ({ ...p, hash: hashOf({ id: p.id, name: p.name, nodes: p.nodes }), nodeCount: p.nodes.length }));
  const resourcesHash = input.resources === null || input.resources === undefined ? null : hashOf(input.resources);
  return {
    fileKey: input.fileKey,
    draftsPageName: input.draftsPageName,
    takenAt: input.takenAt,
    hash: hashOf({ pages: pages.map((p) => ({ id: p.id, name: p.name, hash: p.hash })), resourcesHash }),
    pages,
    resources: input.resources ?? null,
    resourcesHash,
    resourcesError: input.resourcesError ?? null,
  };
}

export type FingerprintChangeKind =
  | "page_added"
  | "page_removed"
  | "page_renamed"
  | "page_moved"
  | "node_added"
  | "node_removed"
  | "node_changed"
  | "resources_changed"
  | "resources_unknown";

export interface FingerprintChange {
  kind: FingerprintChangeKind;
  pageId?: string;
  pageName?: string;
  nodeId?: string;
  nodeName?: string;
  fields?: string[];
  detail?: string;
}

export interface FingerprintDiff {
  changed: boolean;
  /** At most `maxChanges` entries; `truncated` says more were found. */
  changes: FingerprintChange[];
  truncated: boolean;
  /** One paragraph for Ba's alert and the task error. */
  summary: string;
}

const NODE_FIELDS = ["type", "name", "parentId", "index", "visible", "locked", "x", "y", "w", "h", "text"] as const;

function resourceCategories(resources: unknown): Record<string, string> {
  if (!resources || typeof resources !== "object") return {};
  return Object.fromEntries(Object.entries(resources as Record<string, unknown>).map(([k, v]) => [k, hashOf(v)]));
}

function describe(c: FingerprintChange): string {
  const where = c.pageName ? ` on "${c.pageName}"` : "";
  switch (c.kind) {
    case "node_changed":
      return `"${c.nodeName}" (${c.nodeId})${where}: ${c.fields?.join(", ")}`;
    case "node_added":
      return `new node "${c.nodeName}" (${c.nodeId})${where}`;
    case "node_removed":
      return `removed node "${c.nodeName}" (${c.nodeId})${where}`;
    case "page_added":
      return `new page "${c.pageName}"`;
    case "page_removed":
      return `page "${c.pageName}" deleted`;
    case "page_renamed":
      return `page renamed ${c.detail}`;
    case "page_moved":
      return `page "${c.pageName}" moved`;
    case "resources_changed":
      return `local styles or variables changed (${c.detail})`;
    case "resources_unknown":
      return `styles and variables could not be compared (${c.detail})`;
  }
}

export function diffFingerprints(
  before: ProtectedPagesFingerprint,
  after: ProtectedPagesFingerprint,
  opts: { maxChanges?: number } = {},
): FingerprintDiff {
  const all: FingerprintChange[] = [];
  const afterById = new Map(after.pages.map((p, i) => [p.id, { page: p, index: i }]));
  const beforeById = new Map(before.pages.map((p, i) => [p.id, { page: p, index: i }]));

  for (const [i, page] of before.pages.entries()) {
    const match = afterById.get(page.id);
    if (!match) {
      all.push({ kind: "page_removed", pageId: page.id, pageName: page.name });
      continue;
    }
    if (match.page.name !== page.name) {
      all.push({ kind: "page_renamed", pageId: page.id, pageName: match.page.name, detail: `"${page.name}" → "${match.page.name}"` });
    }
    if (match.index !== i) all.push({ kind: "page_moved", pageId: page.id, pageName: match.page.name });
    if (match.page.hash === page.hash) continue;

    const afterNodes = new Map(match.page.nodes.map((n) => [n.id, n]));
    const beforeIds = new Set(page.nodes.map((n) => n.id));
    for (const n of page.nodes) {
      const m = afterNodes.get(n.id);
      if (!m) {
        all.push({ kind: "node_removed", pageId: page.id, pageName: page.name, nodeId: n.id, nodeName: n.name });
        continue;
      }
      const fields = NODE_FIELDS.filter((f) => n[f] !== m[f]);
      if (fields.length > 0) {
        all.push({ kind: "node_changed", pageId: page.id, pageName: page.name, nodeId: n.id, nodeName: m.name, fields: [...fields] });
      }
    }
    for (const m of match.page.nodes) {
      if (!beforeIds.has(m.id)) all.push({ kind: "node_added", pageId: page.id, pageName: page.name, nodeId: m.id, nodeName: m.name });
    }
  }
  for (const page of after.pages) {
    if (!beforeById.has(page.id)) all.push({ kind: "page_added", pageId: page.id, pageName: page.name });
  }

  if (before.resourcesHash !== after.resourcesHash) {
    if (before.resourcesHash === null || after.resourcesHash === null) {
      const which = after.resourcesHash === null ? `after: ${after.resourcesError ?? "unreadable"}` : `before: ${before.resourcesError ?? "unreadable"}`;
      all.push({ kind: "resources_unknown", detail: which });
    } else {
      const b = resourceCategories(before.resources);
      const a = resourceCategories(after.resources);
      const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((k) => b[k] !== a[k]).sort();
      all.push({ kind: "resources_changed", detail: keys.join(", ") || "unknown" });
    }
  }

  const max = opts.maxChanges ?? 50;
  const changes = all.slice(0, max);
  const summary =
    all.length === 0
      ? "Protected pages unchanged."
      : `${all.length} change${all.length === 1 ? "" : "s"} on protected pages: ${changes
          .slice(0, 5)
          .map(describe)
          .join("; ")}${all.length > 5 ? "; …" : ""}.`;
  return { changed: all.length > 0, changes, truncated: all.length > max, summary };
}

export interface FigmaTemplate {
  id: string;
  name: string;
  pageId: string;
  pageName: string;
  /** The section a template sits in, if any (e.g. "EN"). */
  sectionName: string | null;
  width: number;
  height: number;
}

const near = (a: number | undefined, b: number) => a !== undefined && Math.abs(a - b) <= 2;

/** CV templates: frames at page level or directly inside a top-level section; A4 only by default. */
export function templatesFromFingerprint(fp: ProtectedPagesFingerprint, opts: { a4Only?: boolean } = {}): FigmaTemplate[] {
  const a4Only = opts.a4Only ?? true;
  const out: FigmaTemplate[] = [];
  for (const page of fp.pages) {
    const sections = new Map(page.nodes.filter((n) => n.type === "SECTION" && n.parentId === page.id).map((n) => [n.id, n]));
    for (const n of page.nodes) {
      if (n.type !== "FRAME" && n.type !== "COMPONENT") continue;
      const section = sections.get(n.parentId);
      if (n.parentId !== page.id && !section) continue;
      if (a4Only && !(near(n.w, 595) && near(n.h, 842))) continue;
      out.push({
        id: n.id,
        name: n.name,
        pageId: page.id,
        pageName: page.name,
        sectionName: section?.name ?? null,
        width: n.w ?? 0,
        height: n.h ?? 0,
      });
    }
  }
  return out;
}
