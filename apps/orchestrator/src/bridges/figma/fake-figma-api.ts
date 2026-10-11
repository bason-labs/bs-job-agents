// Test support: a small in-memory stand-in for the Figma Plugin API, enough to run the bridge's
// plugin snippets (and simple bot code) without Figma. Semantics kept from the real API:
// - documentAccess "dynamic-page": a page's children need `await page.loadAsync()` unless it
//   is the current page;
// - `clone()` puts the copy on `figma.currentPage`; `appendChild` moves a node to a new parent;
// - `exportAsync` resolves to bytes; `figma.base64Encode` encodes them.

let nextId = 1000;
const newId = () => `${nextId++}:${nextId++}`;

export interface FakeNodeInit {
  id?: string;
  type?: string;
  name: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  visible?: boolean;
  locked?: boolean;
  characters?: string;
  children?: FakeNodeInit[];
  /** Bytes `exportAsync({format:'PDF'})` returns for this node. */
  pdf?: Uint8Array;
  /** Visual properties set on the node as is (fills, fontName, cornerRadius…; PM2 S9). */
  props?: Record<string, unknown>;
}

type Parent = FakeNode | FakePage;

export class FakeNode {
  id: string;
  type: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  locked: boolean;
  characters?: string;
  pdf?: Uint8Array;
  /** @internal Names of the visual properties set from `init.props`. */
  private props: string[] = [];
  parent: Parent | null = null;
  /** Container nodes only: like Figma, TEXT nodes have no `children` property at all. */
  declare readonly children?: FakeNode[];
  private kids: FakeNode[] | undefined;

  constructor(
    private readonly api: FakeFigmaApi,
    init: FakeNodeInit,
  ) {
    this.id = init.id ?? newId();
    this.type = init.type ?? (init.characters !== undefined ? "TEXT" : "FRAME");
    this.name = init.name;
    this.x = init.x ?? 0;
    this.y = init.y ?? 0;
    this.width = init.width ?? 100;
    this.height = init.height ?? 100;
    this.visible = init.visible ?? true;
    this.locked = init.locked ?? false;
    if (init.characters !== undefined) this.characters = init.characters;
    if (init.pdf) this.pdf = init.pdf;
    if (init.props) {
      this.props = Object.keys(init.props);
      Object.assign(this, init.props);
    }
    if (this.type !== "TEXT") {
      this.kids = [];
      Object.defineProperty(this, "children", { get: () => [...(this.kids ?? [])], enumerable: true });
      for (const child of init.children ?? []) this.appendChild(new FakeNode(api, child));
    }
    api.register(this);
  }

  appendChild(child: FakeNode): void {
    if (!this.kids) throw new Error(`cannot append to a ${this.type} node`);
    child.detach();
    this.kids.push(child);
    child.parent = this;
  }

  /** @internal */
  detach(): void {
    const p = this.parent;
    if (p) p.removeChild(this);
    this.parent = null;
  }

  /** @internal */
  removeChild(child: FakeNode): void {
    if (this.kids) this.kids = this.kids.filter((c) => c !== child);
  }

  clone(): FakeNode {
    const copy = new FakeNode(this.api, this.toInit(false));
    this.api.currentPage.appendChild(copy);
    return copy;
  }

  remove(): void {
    this.detach();
    this.api.unregister(this);
  }

  async exportAsync(settings: { format: string }): Promise<Uint8Array> {
    if (settings.format !== "PDF") throw new Error(`fake export supports PDF only, not ${settings.format}`);
    if (!this.pdf) throw new Error(`no PDF bytes scripted for node ${this.id}`);
    return this.pdf;
  }

  /** @internal Deep copy description; ids are kept only when `keepIds`. */
  toInit(keepIds: boolean): FakeNodeInit {
    return {
      ...(keepIds ? { id: this.id } : {}),
      type: this.type,
      name: this.name,
      x: this.x,
      y: this.y,
      width: this.width,
      height: this.height,
      visible: this.visible,
      locked: this.locked,
      ...(this.characters !== undefined ? { characters: this.characters } : {}),
      ...(this.pdf ? { pdf: this.pdf } : {}),
      ...(this.props.length > 0
        ? { props: Object.fromEntries(this.props.map((p) => [p, (this as unknown as Record<string, unknown>)[p]])) }
        : {}),
      ...(this.kids ? { children: this.kids.map((c) => c.toInit(keepIds)) } : {}),
    };
  }
}

export class FakePage {
  readonly type = "PAGE";
  id: string;
  name: string;
  loaded = false;
  private kids: FakeNode[] = [];

  constructor(
    private readonly api: FakeFigmaApi,
    readonly parent: FakeDocument,
    init: { id?: string; name: string; children?: FakeNodeInit[] },
  ) {
    this.id = init.id ?? newId();
    this.name = init.name;
    for (const child of init.children ?? []) this.appendChild(new FakeNode(api, child));
    api.register(this);
  }

  get children(): FakeNode[] {
    if (!this.loaded && this.api.currentPage !== this) {
      throw new Error(`Cannot access children on a page that has not been explicitly loaded. Remember to call await page.loadAsync().`);
    }
    return [...this.kids];
  }

  async loadAsync(): Promise<void> {
    this.loaded = true;
  }

  appendChild(child: FakeNode): void {
    child.detach();
    this.kids.push(child);
    child.parent = this;
  }

  /** @internal */
  removeChild(child: FakeNode): void {
    this.kids = this.kids.filter((c) => c !== child);
  }

  remove(): void {
    this.parent.removePage(this);
  }
}

export class FakeDocument {
  readonly type = "DOCUMENT";
  readonly id = "0:0";
  private pages: FakePage[] = [];
  constructor(public name: string) {}
  get children(): FakePage[] {
    return [...this.pages];
  }
  /** @internal */
  addPage(page: FakePage): void {
    this.pages.push(page);
  }
  /** @internal */
  removePage(page: FakePage): void {
    this.pages = this.pages.filter((p) => p !== page);
  }
}

export interface FakeFigmaApiInit {
  fileKey?: string;
  fileName?: string;
  pages: Array<{ id?: string; name: string; children?: FakeNodeInit[] }>;
  /** Returned by getLocalPaintStylesAsync and friends, and figma.variables. */
  resources?: {
    paintStyles?: unknown[];
    textStyles?: unknown[];
    effectStyles?: unknown[];
    gridStyles?: unknown[];
    variables?: unknown[];
  };
}

export class FakeFigmaApi {
  readonly root: FakeDocument;
  readonly fileKey: string;
  currentPage!: FakePage;
  resources: NonNullable<FakeFigmaApiInit["resources"]>;
  private readonly nodes = new Map<string, FakeNode | FakePage>();

  constructor(init: FakeFigmaApiInit) {
    this.fileKey = init.fileKey ?? "kJFoXNrTfFOtkQ515c0jHk";
    this.root = new FakeDocument(init.fileName ?? "Resume (Community) V2");
    this.resources = init.resources ?? {};
    for (const p of init.pages) {
      const page = new FakePage(this, this.root, p);
      this.root.addPage(page);
      this.currentPage ??= page;
    }
  }

  /** @internal */
  register(node: FakeNode | FakePage): void {
    this.nodes.set(node.id, node);
  }
  /** @internal */
  unregister(node: FakeNode): void {
    this.nodes.delete(node.id);
  }

  createPage(): FakePage {
    const page = new FakePage(this, this.root, { name: "Page" });
    page.loaded = true;
    this.root.addPage(page);
    return page;
  }

  async getNodeByIdAsync(id: string): Promise<FakeNode | FakePage | FakeDocument | null> {
    if (id === this.root.id) return this.root;
    const node = this.nodes.get(id) ?? null;
    if (node instanceof FakePage) node.loaded = true;
    return node;
  }

  async setCurrentPageAsync(page: FakePage): Promise<void> {
    if (!(page instanceof FakePage)) throw new Error("setCurrentPageAsync expects a page");
    page.loaded = true;
    this.currentPage = page;
  }

  base64Encode(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64");
  }

  async getLocalPaintStylesAsync(): Promise<unknown[]> {
    return this.resources.paintStyles ?? [];
  }
  async getLocalTextStylesAsync(): Promise<unknown[]> {
    return this.resources.textStyles ?? [];
  }
  async getLocalEffectStylesAsync(): Promise<unknown[]> {
    return this.resources.effectStyles ?? [];
  }
  async getLocalGridStylesAsync(): Promise<unknown[]> {
    return this.resources.gridStyles ?? [];
  }
  readonly variables = {
    getLocalVariablesAsync: async (): Promise<unknown[]> => this.resources.variables ?? [],
  };

  // ---- test helpers ----
  page(name: string): FakePage {
    const page = this.root.children.find((p) => p.name === name);
    if (!page) throw new Error(`no page ${name}`);
    return page;
  }
  node(id: string): FakeNode {
    const node = this.nodes.get(id);
    if (!(node instanceof FakeNode)) throw new Error(`no node ${id}`);
    return node;
  }
}

type AsyncFn = (figma: FakeFigmaApi) => Promise<unknown>;
const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (arg: string, body: string) => AsyncFn;

/** Runs plugin code the way the Desktop Bridge does: as the body of an async function. */
export function runPluginCode(api: FakeFigmaApi, code: string): Promise<unknown> {
  return new AsyncFunction("figma", code)(api);
}
