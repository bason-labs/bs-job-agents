import { describe, expect, it } from "vitest";
import {
  buildFingerprint,
  canonicalJson,
  diffFingerprints,
  templatesFromFingerprint,
  type FingerprintNode,
  type PageSnapshot,
} from "./fingerprint.js";

const node = (id: string, parentId: string, index: number, extra: Partial<FingerprintNode> = {}): FingerprintNode => ({
  id,
  type: "FRAME",
  name: `n${id}`,
  parentId,
  index,
  visible: true,
  x: 0,
  y: 0,
  w: 10,
  h: 10,
  ...extra,
});

function resumePage(text = "Senior engineer with performance focus"): PageSnapshot {
  return {
    id: "0:1",
    name: "resume",
    nodes: [
      node("10:1", "0:1", 0, { type: "SECTION", name: "EN", w: 2000, h: 1000 }),
      node("459:1767", "10:1", 0, { name: "BA HUYNH — Software Engineer Resume | Refreshed", w: 595, h: 842 }),
      node("459:1800", "459:1767", 0, { type: "TEXT", name: "Profile", text }),
      node("459:1801", "459:1767", 1, { name: "Inner layout", w: 500, h: 200 }),
      node("12:5", "0:1", 1, { name: "VI CV", w: 595, h: 842, x: 700 }),
      node("12:6", "0:1", 2, { name: "Cover image", w: 1200, h: 600, x: 1400 }),
    ],
  };
}
const componentsPage: PageSnapshot = { id: "1:2", name: "components", nodes: [node("20:1", "1:2", 0, { type: "COMPONENT", name: "Chip" })] };
const resources = { paintStyles: [{ id: "S:1", name: "Accent", paints: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }] }], variables: [] };

const fp = (pages: PageSnapshot[], res: unknown = resources, resourcesError: string | null = null) =>
  buildFingerprint({ fileKey: "kJFo", draftsPageName: "Drafts", pages, resources: res, resourcesError, takenAt: "2026-10-11T03:00:00.000Z" });

describe("canonicalJson", () => {
  it("sorts object keys at every level and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"x":2,"y":1}]},"b":1}');
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
});

describe("buildFingerprint", () => {
  it("is stable for the same content whatever the key order", () => {
    const a = fp([resumePage(), componentsPage]);
    const shuffled: PageSnapshot = {
      ...resumePage(),
      nodes: resumePage().nodes.map((n) => Object.fromEntries(Object.entries(n).reverse()) as unknown as FingerprintNode),
    };
    const b = fp([shuffled, componentsPage], { variables: [], paintStyles: resources.paintStyles });
    expect(b.hash).toBe(a.hash);
    expect(a.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(a.pages.map((p) => [p.name, p.nodeCount])).toEqual([
      ["resume", 6],
      ["components", 1],
    ]);
  });

  it("changes when any text changes", () => {
    expect(fp([resumePage("edited"), componentsPage]).hash).not.toBe(fp([resumePage(), componentsPage]).hash);
  });
});

describe("diffFingerprints", () => {
  it("reports no change", () => {
    const d = diffFingerprints(fp([resumePage(), componentsPage]), fp([resumePage(), componentsPage]));
    expect(d).toEqual({ changed: false, changes: [], truncated: false, summary: "Protected pages unchanged." });
  });

  it("names the node, page and fields that changed", () => {
    const d = diffFingerprints(fp([resumePage(), componentsPage]), fp([resumePage("Senior engineer [SPIKE EDIT]"), componentsPage]));
    expect(d.changed).toBe(true);
    expect(d.changes).toEqual([
      {
        kind: "node_changed",
        pageId: "0:1",
        pageName: "resume",
        nodeId: "459:1800",
        nodeName: "Profile",
        fields: ["text"],
      },
    ]);
    expect(d.summary).toMatch(/1 change on protected pages/);
    expect(d.summary).toMatch(/"Profile" \(459:1800\) on "resume": text/);
  });

  it("reports added, removed and moved nodes", () => {
    const after = resumePage();
    after.nodes = after.nodes.filter((n) => n.id !== "12:6");
    after.nodes.push(node("99:1", "0:1", 2, { name: "Stray clone" }));
    const moved = after.nodes.find((n) => n.id === "12:5");
    if (moved) moved.x = 900;
    const d = diffFingerprints(fp([resumePage(), componentsPage]), fp([after, componentsPage]));
    // Document order of the "before" page, then new nodes.
    expect(d.changes.map((c) => [c.kind, c.nodeId, c.fields])).toEqual([
      ["node_changed", "12:5", ["x"]],
      ["node_removed", "12:6", undefined],
      ["node_added", "99:1", undefined],
    ]);
  });

  it("reports page changes, including a new page", () => {
    const renamed: PageSnapshot = { ...componentsPage, name: "components (old)" };
    const extra: PageSnapshot = { id: "5:5", name: "Scratch", nodes: [] };
    const d = diffFingerprints(fp([resumePage(), componentsPage]), fp([resumePage(), renamed, extra]));
    expect(d.changes.map((c) => c.kind)).toEqual(["page_renamed", "page_added"]);
    expect(d.changes[0]?.detail).toBe('"components" → "components (old)"');

    const gone = diffFingerprints(fp([resumePage(), componentsPage]), fp([resumePage()]));
    expect(gone.changes).toEqual([{ kind: "page_removed", pageId: "1:2", pageName: "components" }]);

    const reordered = diffFingerprints(fp([resumePage(), componentsPage]), fp([componentsPage, resumePage()]));
    expect(reordered.changes.map((c) => c.kind)).toEqual(["page_moved", "page_moved"]);
  });

  it("reports changed styles or variables, and unreadable ones", () => {
    const recolored = { paintStyles: [{ id: "S:1", name: "Accent", paints: [{ type: "SOLID", color: { r: 0, g: 0, b: 1 } }] }], variables: [] };
    const d = diffFingerprints(fp([resumePage()]), fp([resumePage()], recolored));
    expect(d.changes).toEqual([{ kind: "resources_changed", detail: "paintStyles" }]);

    const unknown = diffFingerprints(fp([resumePage()]), fp([resumePage()], null, "timed out"));
    expect(unknown.changes).toEqual([{ kind: "resources_unknown", detail: "after: timed out" }]);
    expect(unknown.changed).toBe(true);

    const bothUnknown = diffFingerprints(fp([resumePage()], null, "no access"), fp([resumePage()], null, "no access"));
    expect(bothUnknown.changed).toBe(false);
  });

  it("caps the list of changes and says so", () => {
    const after = resumePage();
    for (let i = 0; i < 80; i++) after.nodes.push(node(`70:${i}`, "0:1", 10 + i));
    const d = diffFingerprints(fp([resumePage()]), fp([after]), { maxChanges: 20 });
    expect(d.changes).toHaveLength(20);
    expect(d.truncated).toBe(true);
    expect(d.summary).toMatch(/80 changes on protected pages/);
  });
});

describe("templatesFromFingerprint", () => {
  it("lists A4 frames at page level or directly inside a section", () => {
    expect(templatesFromFingerprint(fp([resumePage(), componentsPage]))).toEqual([
      {
        id: "459:1767",
        name: "BA HUYNH — Software Engineer Resume | Refreshed",
        pageId: "0:1",
        pageName: "resume",
        sectionName: "EN",
        width: 595,
        height: 842,
      },
      { id: "12:5", name: "VI CV", pageId: "0:1", pageName: "resume", sectionName: null, width: 595, height: 842 },
    ]);
    expect(templatesFromFingerprint(fp([resumePage()]), { a4Only: false }).map((t) => t.id)).toEqual(["459:1767", "12:5", "12:6"]);
  });
});
