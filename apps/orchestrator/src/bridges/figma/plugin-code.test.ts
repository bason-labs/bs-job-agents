import { beforeAll, describe, expect, it } from "vitest";
import { parseJs } from "../js/ast.js";
import { FIGMA_A4, makePdf } from "../pdf/test-pdfs.js";
import { FakeFigmaApi, runPluginCode, type FakeNodeInit } from "./fake-figma-api.js";
import {
  bridgeOpOf,
  BRIDGE_OPS,
  duplicateTemplateCode,
  ensureDraftsPageCode,
  exportPdfCode,
  fileResourcesCode,
  findDraftFrameCode,
  fingerprintPageCode,
  jsLiteral,
  listPagesCode,
  pingCode,
} from "./plugin-code.js";

let pdf: Uint8Array;
beforeAll(async () => {
  pdf = await makePdf([{ size: FIGMA_A4, runs: [{ text: "BA HUYNH", x: 40, y: 800 }] }]);
});

function template(): FakeNodeInit {
  return {
    id: "459:1767",
    name: "BA HUYNH — Software Engineer Resume | Refreshed",
    width: 595,
    height: 842,
    pdf,
    children: [{ id: "459:1800", name: "Profile", characters: "Senior engineer with performance focus", x: 1.23456, y: 2 }],
  };
}

function doc(withDrafts: boolean, draftChildren: FakeNodeInit[] = []): FakeFigmaApi {
  return new FakeFigmaApi({
    pages: [
      { id: "0:1", name: "resume", children: [{ id: "10:1", type: "SECTION", name: "EN", width: 2000, height: 1000, children: [template()] }] },
      { id: "1:2", name: "components", children: [{ id: "20:1", type: "COMPONENT", name: "Chip" }] },
      ...(withDrafts ? [{ id: "2:3", name: "Drafts", children: draftChildren }] : []),
    ],
  });
}

const run = (api: FakeFigmaApi, code: string) => runPluginCode(api, code);

describe("snippets", () => {
  it("parse exactly as the Desktop Bridge wraps them, and carry their op marker", () => {
    const all: Array<[string, string]> = [
      ["ping", pingCode()],
      ["list-pages", listPagesCode()],
      ["ensure-drafts", ensureDraftsPageCode("Drafts")],
      ["find-draft-frame", findDraftFrameCode("X", "Drafts")],
      ["duplicate-template", duplicateTemplateCode("1:2", "X", "Drafts")],
      ["export-pdf", exportPdfCode("1:2", "Drafts", true)],
      ["fingerprint-page", fingerprintPageCode("0:1")],
      ["file-resources", fileResourcesCode()],
    ];
    expect(all.map(([op]) => op).sort()).toEqual([...BRIDGE_OPS].sort());
    for (const [op, code] of all) {
      expect(parseJs(code, "async-function-body").ok, op).toBe(true);
      expect(bridgeOpOf(code)).toBe(op);
    }
    expect(bridgeOpOf("return 1")).toBeNull();
  });

  it("embed inputs as literals, whatever characters they contain", async () => {
    expect(jsLiteral("a\u2028b")).toBe('"a\\u2028b"');
    const api = doc(true);
    const evil = `O'Brien "quoted" \n ${"$"}{figma.closePlugin()} \u2028 </script>`;
    const made = (await run(api, duplicateTemplateCode("459:1767", evil, "Drafts"))) as { name: string };
    expect(made.name).toBe(evil);
  });
});

describe("ping and list-pages", () => {
  it("report the file and its pages", async () => {
    const api = doc(true);
    expect(await run(api, pingCode())).toEqual({ fileKey: "kJFoXNrTfFOtkQ515c0jHk", fileName: "Resume (Community) V2" });
    expect(await run(api, listPagesCode())).toEqual([
      { id: "0:1", name: "resume" },
      { id: "1:2", name: "components" },
      { id: "2:3", name: "Drafts" },
    ]);
  });
});

describe("ensure-drafts", () => {
  it("creates the Drafts page once", async () => {
    const api = doc(false);
    const first = (await run(api, ensureDraftsPageCode("Drafts"))) as { id: string; created: boolean };
    expect(first).toMatchObject({ name: "Drafts", created: true });
    expect(api.root.children.map((p) => p.name)).toEqual(["resume", "components", "Drafts"]);
    expect(await run(api, ensureDraftsPageCode("Drafts"))).toEqual({ id: first.id, name: "Drafts", created: false });
  });
});

describe("find-draft-frame", () => {
  it("finds a frame on Drafts by name", async () => {
    expect(await run(doc(false), findDraftFrameCode("SPIKE_TEST_EN_v1", "Drafts"))).toBeNull();
    const api = doc(true, [{ id: "601:1", name: "SPIKE_TEST_EN_v1", width: 595, height: 842 }]);
    expect(await run(api, findDraftFrameCode("missing", "Drafts"))).toBeNull();
    expect(await run(api, findDraftFrameCode("SPIKE_TEST_EN_v1", "Drafts"))).toEqual({
      id: "601:1",
      name: "SPIKE_TEST_EN_v1",
      type: "FRAME",
      pageId: "2:3",
      width: 595,
      height: 842,
      visible: true,
    });
  });
});

describe("duplicate-template", () => {
  it("copies the template onto Drafts, to the right of existing drafts, and leaves the template alone", async () => {
    const api = doc(true, [{ id: "601:1", name: "OLD_EN_v1", x: 0, width: 595, height: 842 }]);
    const copy = (await run(api, duplicateTemplateCode("459:1767", "NOVAPAY_SENIOR-FE_EN_v1", "Drafts"))) as { id: string };
    expect(copy).toMatchObject({ name: "NOVAPAY_SENIOR-FE_EN_v1", pageId: "2:3", width: 595, height: 842 });
    const drafts = api.page("Drafts");
    expect(drafts.children.map((n) => n.name)).toEqual(["OLD_EN_v1", "NOVAPAY_SENIOR-FE_EN_v1"]);
    expect(api.node(copy.id).x).toBe(695);
    expect(api.node(copy.id).children?.[0]?.characters).toBe("Senior engineer with performance focus");
    // The clone first lands on the current page (resume); nothing is left behind there.
    expect(api.node("10:1").children?.map((n) => n.id)).toEqual(["459:1767"]);
    expect(api.page("resume").children.map((n) => n.id)).toEqual(["10:1"]);
  });

  it("puts the first draft at x = 0", async () => {
    const api = doc(true);
    const copy = (await run(api, duplicateTemplateCode("459:1767", "A_B_EN_v1", "Drafts"))) as { id: string };
    expect(api.node(copy.id).x).toBe(0);
  });

  it("refuses a missing Drafts page, a taken name, a missing node and a non-frame", async () => {
    await expect(run(doc(false), duplicateTemplateCode("459:1767", "X", "Drafts"))).rejects.toThrow(/^BRIDGE:NO_DRAFTS_PAGE:/);
    const api = doc(true, [{ name: "X" }]);
    await expect(run(api, duplicateTemplateCode("459:1767", "X", "Drafts"))).rejects.toThrow(/^BRIDGE:NAME_TAKEN:/);
    await expect(run(api, duplicateTemplateCode("9:9", "Y", "Drafts"))).rejects.toThrow(/^BRIDGE:NOT_FOUND:/);
    await expect(run(api, duplicateTemplateCode("459:1800", "Y", "Drafts"))).rejects.toThrow(/^BRIDGE:NOT_A_FRAME:node 459:1800 is a TEXT/);
  });
});

describe("export-pdf", () => {
  it("returns the frame's PDF as base64 with its size", async () => {
    const api = doc(true, [{ id: "601:1", name: "SPIKE_TEST_EN_v1", width: 595, height: 842, pdf: new Uint8Array([37, 80, 68, 70]) }]);
    expect(await run(api, exportPdfCode("601:1", "Drafts", true))).toEqual({
      base64: "JVBERg==",
      name: "SPIKE_TEST_EN_v1",
      width: 595,
      height: 842,
      pageName: "Drafts",
    });
  });

  it("refuses frames outside Drafts unless allowed, hidden frames, pages and missing nodes", async () => {
    const api = doc(true, [{ id: "601:2", name: "HIDDEN_EN_v1", visible: false, pdf }]);
    await expect(run(api, exportPdfCode("459:1767", "Drafts", true))).rejects.toThrow(/^BRIDGE:NOT_IN_DRAFTS:node 459:1767 is on page resume/);
    expect(await run(api, exportPdfCode("459:1767", "Drafts", false))).toMatchObject({ pageName: "resume" });
    await expect(run(api, exportPdfCode("601:2", "Drafts", true))).rejects.toThrow(/^BRIDGE:FRAME_HIDDEN:/);
    await expect(run(api, exportPdfCode("0:1", "Drafts", false))).rejects.toThrow(/^BRIDGE:NOT_A_FRAME:/);
    await expect(run(api, exportPdfCode("7:7", "Drafts", true))).rejects.toThrow(/^BRIDGE:NOT_FOUND:/);
  });
});

describe("fingerprint-page", () => {
  it("loads the page and lists every node with structure, geometry and text", async () => {
    const api = doc(true);
    const snap = (await run(api, fingerprintPageCode("1:2"))) as { nodes: unknown[] };
    expect(snap).toEqual({
      id: "1:2",
      name: "components",
      nodes: [{ id: "20:1", type: "COMPONENT", name: "Chip", parentId: "1:2", index: 0, visible: true, locked: false, x: 0, y: 0, w: 100, h: 100 }],
    });
    const resume = (await run(api, fingerprintPageCode("0:1"))) as { nodes: Array<{ id: string; parentId: string; text?: string; x?: number }> };
    expect(resume.nodes.map((n) => [n.id, n.parentId])).toEqual([
      ["10:1", "0:1"],
      ["459:1767", "10:1"],
      ["459:1800", "459:1767"],
    ]);
    expect(resume.nodes[2]).toMatchObject({ text: "Senior engineer with performance focus", x: 1.23 });
  });

  it("refuses an id that is not a page", async () => {
    await expect(run(doc(true), fingerprintPageCode("459:1767"))).rejects.toThrow(/^BRIDGE:NOT_FOUND:page/);
  });
});

describe("file-resources", () => {
  it("reads local styles and variables, and reports an API that fails", async () => {
    const api = doc(true);
    api.resources = { paintStyles: [{ id: "S:1", name: "Accent", paints: [{ type: "SOLID" }], extra: "ignored" }] };
    const res = (await run(api, fileResourcesCode())) as Record<string, unknown>;
    expect(res.paintStyles).toEqual([{ id: "S:1", name: "Accent", paints: [{ type: "SOLID" }] }]);
    expect(res.variables).toEqual([]);

    api.variables.getLocalVariablesAsync = () => Promise.reject(new Error("no access"));
    expect(((await run(api, fileResourcesCode())) as Record<string, unknown>).variables).toEqual({ error: "no access" });
  });
});
