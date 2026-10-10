import { describe, expect, it } from "vitest";
import { checkFigmaCode, evaluateFigmaToolCall, figmaGuardPolicyFromFingerprint, type FigmaGuardPolicy } from "./guard.js";
import { buildFingerprint } from "./fingerprint.js";

const KEY = "kJFoXNrTfFOtkQ515c0jHk";
const policy: FigmaGuardPolicy = {
  draftsPageName: "Drafts",
  draftsPageId: "2:3",
  protectedPageNames: ["resume", "components"],
  protectedPageIds: ["0:1", "1:2"],
  protectedNodeIds: ["10:1", "459:1767", "459:1800", "20:1"],
  fileKey: KEY,
};

describe("checkFigmaCode: CV work on Drafts is allowed", () => {
  const allowed: Array<[string, string]> = [
    [
      "edit text in its own draft by id",
      `const t = await figma.getNodeByIdAsync("601:23"); await figma.loadFontAsync(t.fontName); t.characters = "Senior Frontend Engineer"; return { ok: true };`,
    ],
    [
      "clone a template by id into Drafts after switching to Drafts",
      `const drafts = figma.root.children.find(p => p.name === "Drafts");
       await figma.setCurrentPageAsync(drafts);
       const tpl = await figma.getNodeByIdAsync("459:1767");
       const copy = tpl.clone();
       drafts.appendChild(copy);
       copy.name = "NOVAPAY_SENIOR-FE_EN_v1";
       return { id: copy.id };`,
    ],
    [
      "clone straight into Drafts without switching page",
      `const drafts = figma.root.findChild(n => n.type === "PAGE" && n.name === "Drafts");
       const tpl = await figma.getNodeByIdAsync("459:1767");
       drafts.appendChild(tpl.clone());`,
    ],
    [
      "read a template's texts",
      `const tpl = await figma.getNodeByIdAsync("459:1767"); return tpl.findAll(n => n.type === "TEXT").map(n => ({ id: n.id, text: n.characters }));`,
    ],
    [
      "edit nodes found inside its draft",
      `const f = await figma.getNodeByIdAsync("601:1"); const title = f.findOne(n => n.name === "Professional title"); await figma.loadFontAsync(title.fontName); title.characters = "Lead"; title.fontSize = 12;`,
    ],
    ["list page names", `return figma.root.children.map(p => p.name);`],
    [
      "add a text node to its draft frame",
      `const f = await figma.getNodeByIdAsync("601:1"); const t = figma.createText(); f.appendChild(t); await figma.loadFontAsync({ family: "Inter", style: "Regular" }); t.characters = "x";`,
    ],
    [
      "use the Drafts page by id",
      `const d = await figma.getNodeByIdAsync("2:3"); await figma.setCurrentPageAsync(d); const r = figma.createRectangle(); r.resize(10, 10);`,
    ],
    ["remove its own draft node", `const n = await figma.getNodeByIdAsync("601:7"); n.remove();`],
    [
      "clean up old drafts",
      `const drafts = figma.root.children.find(p => p.name === "Drafts"); await drafts.loadAsync(); drafts.children.filter(n => n.name.startsWith("SPIKE")).forEach(n => n.remove());`,
    ],
    ["export a draft as PNG", `const f = await figma.getNodeByIdAsync("601:1"); const b = await f.exportAsync({ format: "PNG" }); return b.length;`],
    ["promise style on its own node", `figma.getNodeByIdAsync("601:1").then(n => { n.name = "x"; });`],
    ["read the current page name", `return figma.currentPage.name;`],
    ["notify and zoom", `const f = await figma.getNodeByIdAsync("601:1"); figma.viewport.scrollAndZoomIntoView([f]); figma.notify("done");`],
    ["layer names that are ordinary words", `const f = await figma.getNodeByIdAsync("601:1"); return f.findOne(n => n.name === "Experience");`],
    ["summarise a template", `const tpl = await figma.getNodeByIdAsync("459:1767"); return JSON.stringify({ name: tpl.name, w: tpl.width });`],
    ["check Drafts exists", `return figma.root.children.some(p => p.name === "Drafts");`],
    [
      "build a draft from scratch on Drafts",
      `const drafts = figma.root.children.find(p => p.name === "Drafts");
       await figma.setCurrentPageAsync(drafts);
       const frame = figma.createFrame(); frame.name = "ACME_FE_EN_v1"; frame.resize(595, 842);
       figma.currentPage.appendChild(frame);
       figma.currentPage.selection = [frame];`,
    ],
    ["global plugin settings", `figma.skipInvisibleInstanceChildren = true; return 1;`],
    [
      "a variable named like the lookup's parameter",
      `const p = figma.root.children.find(p => p.name === "Drafts"); p.appendChild(figma.createFrame());`,
    ],
    [
      "a loop variable reused later",
      `for (const p of figma.root.children) { console.log(p.name); } const p = figma.root.children.find(p => p.name === "Drafts"); p.appendChild(figma.createFrame());`,
    ],
    ["a parameter shadowing a template variable", `const tpl = await figma.getNodeByIdAsync("459:1767"); [1, 2].forEach(tpl => tpl.toFixed(1)); return tpl.name;`],
  ];
  it.each(allowed)("%s", (_name, code) => {
    expect(checkFigmaCode(code, policy)).toEqual({ allow: true });
  });
});

describe("checkFigmaCode: references to other pages", () => {
  const blocked: Array<[string, string, string]> = [
    ["page by name", `figma.root.children.find(p => p.name === "resume")`, "figma_page_name"],
    ["page by name in a template literal", "const n = `components`; return n;", "figma_page_name"],
    ["page by id", `await figma.getNodeByIdAsync("0:1")`, "figma_page_id"],
    ["page by position", `figma.root.children[0].name`, "figma_page_index"],
    ["page by destructuring", `const [first] = figma.root.children; return first.name;`, "figma_page_index"],
    ["page by at()", `return figma.root.children.at(1).name`, "figma_page_index"],
    ["lookup that excludes Drafts", `const p = figma.root.children.find(p => p.name !== "Drafts"); return p.name;`, "figma_page_lookup"],
    ["lookup by another test", `return figma.root.children.find(p => p.children.length > 3).name`, "figma_page_lookup"],
    ["lookup by an unknown name", `return figma.root.findChild(p => p.name === "Scratch")`, "figma_page_lookup"],
    ["search across pages", `return figma.root.findAll(n => n.name === "Profile")`, "figma_cross_page_search"],
    ["load every page", `await figma.loadAllPagesAsync()`, "figma_cross_page_search"],
    ["switch to another page", `await figma.setCurrentPageAsync(figma.root.children.find(p => p.name === "Drafts").parent.children[1])`, "figma_switch_page"],
    ["assign another current page", `figma.currentPage = figma.root.children[1]`, "figma_switch_page"],
    ["create a page", `const p = figma.createPage(); p.name = "Scratch";`, "figma_create_page"],
    ["delete every page", `figma.root.children.forEach(p => p.remove())`, "figma_protected_write"],
    ["rename every page", `figma.root.children.forEach(p => { p.name = p.name + "!"; })`, "figma_protected_write"],
    ["delete the Drafts page", `const p = figma.root.children.find(p => p.name === "Drafts"); p.remove();`, "figma_drafts_delete"],
    ["rename the Drafts page", `const d = figma.root.children.find(p => p.name === "Drafts"); d.name = "Old drafts";`, "figma_drafts_rename"],
    ["reach other pages from Drafts", `const d = figma.root.children.find(p => p.name === "Drafts"); d.parent.children[0].remove();`, "figma_page_index"],
    ["write to the document root", `figma.root.setPluginData("x", "y")`, "figma_root_write"],
    ["dynamic key on figma", `figma[name]()`, "figma_dynamic_access"],
    ["dynamic key on the root", `return figma.root[k]`, "figma_dynamic_access"],
  ];
  it.each(blocked)("%s", (_name, code, rule) => {
    const d = checkFigmaCode(code, policy);
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.rule).toBe(rule);
      expect(d.reason).toMatch(/^Blocked by Figma guard: /);
    }
  });
});

describe("checkFigmaCode: writes to protected nodes", () => {
  const blocked: Array<[string, string, string]> = [
    ["remove a template", `const tpl = await figma.getNodeByIdAsync("459:1767"); tpl.remove();`, "figma_protected_write"],
    ["edit template text", `(await figma.getNodeByIdAsync("459:1800")).characters = "hacked";`, "figma_protected_write"],
    ["remove a template child", `const tpl = await figma.getNodeByIdAsync("459:1767"); tpl.children[0].remove();`, "figma_protected_write"],
    [
      "edit every template text",
      `const tpl = await figma.getNodeByIdAsync("459:1767"); tpl.findAll(n => n.type === "TEXT").forEach(n => { n.characters = "x"; });`,
      "figma_protected_write",
    ],
    ["template id through a constant", `const id = "459:1767"; (await figma.getNodeByIdAsync(id)).remove();`, "figma_protected_write"],
    [
      "dynamic ids next to a template id",
      `const tpl = await figma.getNodeByIdAsync("459:1767"); for (const i of ["601:1"]) { const n = await figma.getNodeByIdAsync(i); n.remove(); }`,
      "figma_protected_write",
    ],
    [
      "move a template into Drafts",
      `const tpl = await figma.getNodeByIdAsync("459:1767"); const drafts = figma.root.children.find(p => p.name === "Drafts"); drafts.appendChild(tpl);`,
      "figma_move_protected",
    ],
    ["group template nodes", `figma.group([await figma.getNodeByIdAsync("459:1800")], figma.currentPage)`, "figma_move_protected"],
    [
      "change a main component through a draft instance",
      `const inst = await figma.getNodeByIdAsync("601:5"); (await inst.getMainComponentAsync()).remove();`,
      "figma_protected_write",
    ],
    ["main component property", `const inst = await figma.getNodeByIdAsync("601:5"); inst.mainComponent.name = "x";`, "figma_protected_write"],
    ["edit a local style", `const s = await figma.getLocalPaintStylesAsync(); s[0].name = "x";`, "figma_protected_write"],
    ["template through a helper", `function zap(n) { n.remove(); } zap(await figma.getNodeByIdAsync("459:1767"));`, "figma_protected_escape"],
    ["template through an array", `const keep = []; keep.push(await figma.getNodeByIdAsync("459:1767")); keep[0].remove();`, "figma_protected_write"],
    ["template through an object", `const o = { t: await figma.getNodeByIdAsync("459:1767") }; o.t.remove();`, "figma_protected_write"],
    ["delete a template property", `const tpl = await figma.getNodeByIdAsync("459:1767"); delete tpl.name;`, "figma_protected_write"],
    ["a closure over a template", `const tpl = await figma.getNodeByIdAsync("459:1767"); [1].forEach(() => tpl.remove());`, "figma_protected_write"],
    ["a loop over template children", `const tpl = await figma.getNodeByIdAsync("459:1767"); for (const n of tpl.children) n.visible = false;`, "figma_protected_write"],
    [
      "a protected node from a promise",
      `figma.getNodeByIdAsync("459:1767").then(t => t.remove());`,
      "figma_protected_write",
    ],
  ];
  it.each(blocked)("%s", (_name, code, rule) => {
    const d = checkFigmaCode(code, policy);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.rule).toBe(rule);
  });
});

describe("checkFigmaCode: new nodes must land on Drafts", () => {
  const blocked: Array<[string, string, string]> = [
    ["a clone left on the current page", `const tpl = await figma.getNodeByIdAsync("459:1767"); const copy = tpl.clone(); copy.name = "x";`, "figma_create_outside_drafts"],
    ["a new shape left on the current page", `const r = figma.createRectangle(); r.resize(10, 10);`, "figma_create_outside_drafts"],
    ["append to an unknown current page", `figma.currentPage.appendChild(figma.createFrame())`, "figma_current_page"],
    ["select on an unknown current page", `figma.currentPage.selection = []`, "figma_current_page"],
    [
      "switch to Drafts only after creating",
      `const drafts = figma.root.children.find(p => p.name === "Drafts"); const r = figma.createRectangle(); await figma.setCurrentPageAsync(drafts); r.resize(1, 1);`,
      "figma_create_outside_drafts",
    ],
    [
      "switch to Drafts only on one branch",
      `const drafts = figma.root.children.find(p => p.name === "Drafts"); if (x) { await figma.setCurrentPageAsync(drafts); } figma.createEllipse();`,
      "figma_create_outside_drafts",
    ],
  ];
  it.each(blocked)("%s", (_name, code, rule) => {
    const d = checkFigmaCode(code, policy);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.rule).toBe(rule);
  });
});

describe("checkFigmaCode: the bridge itself and code the guard cannot follow", () => {
  const blocked: Array<[string, string, string]> = [
    ["close the plugin", `figma.closePlugin()`, "figma_bridge_control"],
    ["talk to the bridge UI", `figma.ui.postMessage({})`, "figma_bridge_control"],
    ["replace the bridge handler", `figma.ui.onmessage = null`, "figma_bridge_control"],
    ["persistent event handler", `figma.on("selectionchange", () => {})`, "figma_event_handler"],
    ["undo Ba's work", `figma.triggerUndo()`, "figma_undo"],
    ["open a browser", `figma.openExternal("https://evil.example")`, "figma_external"],
    ["create a style", `figma.createPaintStyle()`, "figma_file_resource"],
    ["create a variable", `figma.variables.createVariable("x", c, "COLOR")`, "figma_file_resource"],
    ["eval", `eval("figma.root.children[0].remove()")`, "figma_dynamic_code"],
    ["Function", `new Function("return figma")()`, "figma_dynamic_code"],
    ["string timer", `setTimeout("figma.closePlugin()", 0)`, "figma_dynamic_code"],
    ["network", `await fetch("https://figma-console-mcp.southleft.com/x", { method: "POST", body: "cv" })`, "figma_network"],
    ["websocket", `new WebSocket("ws://localhost:9223")`, "figma_network"],
    ["with", `with (figma.root) { children[0].remove(); }`, "figma_with"],
    ["syntax error", `const = 1`, "figma_parse"],
  ];
  it.each(blocked)("%s", (_name, code, rule) => {
    const d = checkFigmaCode(code, policy);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.rule).toBe(rule);
  });

  it("blocks code that is not a string", () => {
    expect(checkFigmaCode(42, policy)).toMatchObject({ allow: false, rule: "figma_parse" });
  });

  it("quotes the offending code in the message", () => {
    const d = checkFigmaCode(`const tpl = await figma.getNodeByIdAsync("459:1767");\ntpl.remove();`, policy);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toContain("`tpl.remove()`");
  });
});

describe("checkFigmaCode: known limits (the protected-page fingerprint is the backstop)", () => {
  it("does not follow ids built at run time (literal concatenation is still resolved)", () => {
    expect(checkFigmaCode(`const parts = ["459", "1767"]; (await figma.getNodeByIdAsync(parts.join(":"))).remove();`, policy).allow).toBe(true);
    expect(checkFigmaCode(`(await figma.getNodeByIdAsync("459:" + "1767")).remove();`, policy).allow).toBe(false);
  });

  it("does not follow .parent upwards from nodes it cannot place", () => {
    expect(checkFigmaCode(`const n = await figma.getNodeByIdAsync("601:1"); n.parent.parent.children[0].name = "x";`, policy).allow).toBe(true);
  });

  it("knows template ids only from the fingerprint it was given", () => {
    const noIds: FigmaGuardPolicy = { ...policy, protectedNodeIds: [] };
    expect(checkFigmaCode(`(await figma.getNodeByIdAsync("459:1767")).remove();`, noIds).allow).toBe(true);
    // Page names are still blocked without a fingerprint.
    expect(checkFigmaCode(`figma.root.children.find(p => p.name === "resume")`, noIds).allow).toBe(false);
  });
});

describe("evaluateFigmaToolCall", () => {
  const call = (tool: string, toolInput: Record<string, unknown>) => ({ toolName: `mcp__figma__${tool}`, toolInput });

  it("checks figma_execute code and requires the CV file key", () => {
    expect(evaluateFigmaToolCall(call("figma_execute", { code: "return figma.currentPage.name", fileKey: KEY }), policy)).toEqual({ allow: true });
    expect(evaluateFigmaToolCall(call("figma_execute", { code: "return 1" }), policy)).toMatchObject({ allow: false, rule: "figma_file_key" });
    expect(evaluateFigmaToolCall(call("figma_execute", { code: "return 1", fileKey: "other" }), policy)).toMatchObject({
      allow: false,
      rule: "figma_file_key",
    });
    expect(evaluateFigmaToolCall(call("figma_execute", { code: "figma.closePlugin()", fileKey: KEY }), policy)).toMatchObject({
      allow: false,
      rule: "figma_bridge_control",
    });
  });

  it("allows only the CV bot's tools on the Figma server", () => {
    expect(evaluateFigmaToolCall(call("figma_get_status", { probe: true }), policy)).toEqual({ allow: true });
    expect(evaluateFigmaToolCall(call("figma_capture_screenshot", { nodeId: "601:1" }), policy)).toEqual({ allow: true });
    expect(evaluateFigmaToolCall(call("figma_execute_across_files", { code: "1" }), policy)).toMatchObject({
      allow: false,
      rule: "figma_tool_not_allowed",
    });
    expect(evaluateFigmaToolCall(call("figma_delete_node", { nodeId: "459:1767" }), policy)).toMatchObject({ allow: false });
    expect(evaluateFigmaToolCall({ toolName: "Read", toolInput: {} }, policy)).toEqual({ allow: true });
  });

  it("accepts any file when no file key is configured", () => {
    expect(evaluateFigmaToolCall(call("figma_execute", { code: "return 1" }), { ...policy, fileKey: null })).toEqual({ allow: true });
  });
});

describe("figmaGuardPolicyFromFingerprint", () => {
  it("protects every page and node the fingerprint saw", () => {
    const fp = buildFingerprint({
      fileKey: KEY,
      draftsPageName: "Drafts",
      takenAt: "2026-10-11T00:00:00.000Z",
      resources: null,
      pages: [
        { id: "0:1", name: "resume", nodes: [{ id: "459:1767", type: "FRAME", name: "T", parentId: "0:1", index: 0 }] },
        { id: "5:5", name: "Cover", nodes: [] },
      ],
    });
    expect(figmaGuardPolicyFromFingerprint(fp, { draftsPageId: "2:3" })).toEqual({
      draftsPageName: "Drafts",
      draftsPageId: "2:3",
      protectedPageNames: ["resume", "Cover", "components"],
      protectedPageIds: ["0:1", "5:5"],
      protectedNodeIds: ["459:1767"],
      fileKey: KEY,
    });
  });
});
