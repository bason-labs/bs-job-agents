// Plugin code the orchestrator itself runs through figma_execute (no LLM, spec §6.2).
// Each snippet starts with `// bs-bridge:op=<name>` so fakes can route it, embeds its inputs as
// JSON literals only, and reports expected failures as `BRIDGE:<CODE>:<message>`.
// Conservative syntax (no optional chaining) for the plugin sandbox.

export const BRIDGE_OPS = [
  "ping",
  "list-pages",
  "ensure-drafts",
  "find-draft-frame",
  "duplicate-template",
  "export-pdf",
  "fingerprint-page",
  "file-resources",
] as const;
export type BridgeOp = (typeof BRIDGE_OPS)[number];

/** JSON literal safe to embed in JavaScript source (U+2028/2029 escaped for older parsers). */
export function jsLiteral(value: unknown): string {
  return JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

const header = (op: BridgeOp) => `// bs-bridge:op=${op}\n`;

/** The op marker of a snippet, or null for other code. */
export function bridgeOpOf(code: string): string | null {
  return /^\/\/ bs-bridge:op=([a-z-]+)/.exec(code)?.[1] ?? null;
}

export function pingCode(): string {
  return `${header("ping")}return { fileKey: figma.fileKey || null, fileName: figma.root.name };`;
}

export function listPagesCode(): string {
  return `${header("list-pages")}return figma.root.children.map(function (p) { return { id: p.id, name: p.name }; });`;
}

export function ensureDraftsPageCode(draftsName: string): string {
  return `${header("ensure-drafts")}const name = ${jsLiteral(draftsName)};
let page = figma.root.children.find(function (p) { return p.name === name; });
let created = false;
if (!page) { page = figma.createPage(); page.name = name; created = true; }
return { id: page.id, name: page.name, created: created };`;
}

export function findDraftFrameCode(frameName: string, draftsName: string): string {
  return `${header("find-draft-frame")}const name = ${jsLiteral(frameName)};
const draftsName = ${jsLiteral(draftsName)};
const drafts = figma.root.children.find(function (p) { return p.name === draftsName; });
if (!drafts) return null;
await drafts.loadAsync();
const frame = drafts.children.find(function (n) { return n.name === name; });
if (!frame) return null;
return { id: frame.id, name: frame.name, type: frame.type, pageId: drafts.id, width: frame.width, height: frame.height, visible: frame.visible };`;
}

export function duplicateTemplateCode(templateId: string, newName: string, draftsName: string): string {
  return `${header("duplicate-template")}const templateId = ${jsLiteral(templateId)};
const newName = ${jsLiteral(newName)};
const draftsName = ${jsLiteral(draftsName)};
const drafts = figma.root.children.find(function (p) { return p.name === draftsName; });
if (!drafts) throw new Error("BRIDGE:NO_DRAFTS_PAGE:there is no page named " + draftsName);
await drafts.loadAsync();
if (drafts.children.some(function (n) { return n.name === newName; })) throw new Error("BRIDGE:NAME_TAKEN:" + newName + " already exists on " + draftsName);
const template = await figma.getNodeByIdAsync(templateId);
if (!template) throw new Error("BRIDGE:NOT_FOUND:node " + templateId + " not found");
if (template.type !== "FRAME" && template.type !== "COMPONENT" && template.type !== "INSTANCE") throw new Error("BRIDGE:NOT_A_FRAME:node " + templateId + " is a " + template.type);
let right = 0;
const existing = drafts.children;
for (let i = 0; i < existing.length; i++) { right = Math.max(right, existing[i].x + existing[i].width); }
const copy = template.clone();
try {
  drafts.appendChild(copy);
  copy.name = newName;
  copy.x = existing.length > 0 ? right + 100 : 0;
  copy.y = 0;
} catch (e) {
  copy.remove();
  throw e;
}
return { id: copy.id, name: copy.name, pageId: drafts.id, width: copy.width, height: copy.height };`;
}

export function exportPdfCode(frameId: string, draftsName: string, requireDrafts: boolean): string {
  return `${header("export-pdf")}const id = ${jsLiteral(frameId)};
const draftsName = ${jsLiteral(draftsName)};
const requireDrafts = ${requireDrafts ? "true" : "false"};
const node = await figma.getNodeByIdAsync(id);
if (!node) throw new Error("BRIDGE:NOT_FOUND:node " + id + " not found");
if (node.type === "PAGE" || node.type === "DOCUMENT" || typeof node.exportAsync !== "function") throw new Error("BRIDGE:NOT_A_FRAME:node " + id + " is a " + node.type);
let page = node.parent;
while (page && page.type !== "PAGE") page = page.parent;
if (requireDrafts && (!page || page.name !== draftsName)) throw new Error("BRIDGE:NOT_IN_DRAFTS:node " + id + " is on page " + (page ? page.name : "(none)"));
if (node.visible === false) throw new Error("BRIDGE:FRAME_HIDDEN:frame " + node.name + " is hidden");
const bytes = await node.exportAsync({ format: "PDF" });
return { base64: figma.base64Encode(bytes), name: node.name, width: node.width, height: node.height, pageName: page ? page.name : null };`;
}

export function fingerprintPageCode(pageId: string): string {
  return `${header("fingerprint-page")}const pageId = ${jsLiteral(pageId)};
const page = await figma.getNodeByIdAsync(pageId);
if (!page || page.type !== "PAGE") throw new Error("BRIDGE:NOT_FOUND:page " + pageId + " not found");
await page.loadAsync();
const r = function (v) { return Math.round(v * 100) / 100; };
const nodes = [];
const walk = function (node, parentId, index) {
  const e = { id: node.id, type: node.type, name: node.name, parentId: parentId, index: index };
  if (typeof node.visible === "boolean") e.visible = node.visible;
  if (typeof node.locked === "boolean") e.locked = node.locked;
  if (typeof node.x === "number") { e.x = r(node.x); e.y = r(node.y); }
  if (typeof node.width === "number") { e.w = r(node.width); e.h = r(node.height); }
  if (node.type === "TEXT") e.text = node.characters;
  nodes.push(e);
  if ("children" in node) {
    const kids = node.children;
    for (let i = 0; i < kids.length; i++) walk(kids[i], node.id, i);
  }
};
const top = page.children;
for (let i = 0; i < top.length; i++) walk(top[i], page.id, i);
return { id: page.id, name: page.name, nodes: nodes };`;
}

export function fileResourcesCode(): string {
  return `${header("file-resources")}const read = async function (fn) {
  try { return await fn(); } catch (e) { return { error: String((e && e.message) || e) }; }
};
const pick = function (list, fields) {
  return list.map(function (s) {
    const o = {};
    for (let i = 0; i < fields.length; i++) { const v = s[fields[i]]; o[fields[i]] = typeof v === "symbol" ? "mixed" : v; }
    return o;
  });
};
return {
  paintStyles: await read(async function () { return pick(await figma.getLocalPaintStylesAsync(), ["id", "name", "paints"]); }),
  textStyles: await read(async function () { return pick(await figma.getLocalTextStylesAsync(), ["id", "name", "fontName", "fontSize", "lineHeight", "letterSpacing", "paragraphSpacing", "textCase", "textDecoration"]); }),
  effectStyles: await read(async function () { return pick(await figma.getLocalEffectStylesAsync(), ["id", "name", "effects"]); }),
  gridStyles: await read(async function () { return pick(await figma.getLocalGridStylesAsync(), ["id", "name", "layoutGrids"]); }),
  variables: await read(async function () { return pick(await figma.variables.getLocalVariablesAsync(), ["id", "name", "resolvedType", "valuesByMode"]); })
};`;
}
