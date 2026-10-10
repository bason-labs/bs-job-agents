import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sha256File } from "../pdf/hash.js";
import { A4, FIGMA_A4, makePdf } from "../pdf/test-pdfs.js";
import { FigmaBridge } from "./bridge.js";
import { DEFAULT_CV_FILE_KEY } from "./constants.js";
import { FigmaBridgeError, isFigmaUnavailable } from "./errors.js";
import { FakeFigmaMcp } from "./fake-bridge.js";
import { FakeFigmaApi } from "./fake-figma-api.js";
import { diffFingerprints } from "./fingerprint.js";

let cvPdf: Uint8Array;
let twoPagePdf: Uint8Array;
beforeAll(async () => {
  cvPdf = await makePdf([{ size: FIGMA_A4, runs: [{ text: "BA HUYNH", x: 40, y: 800 }] }]);
  twoPagePdf = await makePdf([{ size: A4 }, { size: A4 }]);
});

function makeDoc(): FakeFigmaApi {
  return new FakeFigmaApi({
    pages: [
      {
        id: "0:1",
        name: "resume",
        children: [
          {
            id: "10:1",
            type: "SECTION",
            name: "EN",
            width: 2000,
            height: 1000,
            children: [
              {
                id: "459:1767",
                name: "BA HUYNH — Software Engineer Resume | Refreshed",
                width: 595,
                height: 842,
                pdf: cvPdf,
                children: [{ id: "459:1800", name: "Profile", characters: "Senior engineer with performance focus" }],
              },
            ],
          },
        ],
      },
      { id: "1:2", name: "components", children: [{ id: "20:1", type: "COMPONENT", name: "Chip" }] },
      {
        id: "2:3",
        name: "Drafts",
        children: [
          { id: "601:1", name: "SPIKE_TEST_EN_v1", width: 595, height: 842, pdf: cvPdf },
          { id: "601:9", name: "HIDDEN_EN_v1", width: 595, height: 842, pdf: cvPdf, visible: false },
        ],
      },
    ],
    resources: { paintStyles: [{ id: "S:1", name: "Accent", paints: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }] }] },
  });
}

class Clock {
  t = Date.parse("2026-10-11T04:00:00.000Z");
  sleeps: number[] = [];
  now = () => new Date(this.t);
  sleep = async (ms: number) => {
    this.sleeps.push(ms);
    this.t += ms;
  };
}

function setup(opts: { api?: FakeFigmaApi; connected?: boolean } = {}) {
  const api = opts.api ?? makeDoc();
  const mcp = new FakeFigmaMcp({ api, connected: opts.connected ?? true });
  const clock = new Clock();
  let connects = 0;
  const bridge = new FigmaBridge({
    connect: async () => {
      connects++;
      return mcp;
    },
    now: clock.now,
    sleep: clock.sleep,
  });
  return { api, mcp, clock, bridge, connects: () => connects };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof FigmaBridgeError) return err.code;
    throw err;
  }
  throw new Error("expected a FigmaBridgeError");
}

describe("FigmaBridge.status", () => {
  it("is connected when the probe succeeds and the CV file answers a ping", async () => {
    const { bridge, mcp } = setup();
    const s = await bridge.status();
    expect(s).toMatchObject({ state: "connected", connected: true, fileKey: DEFAULT_CV_FILE_KEY, fileName: "Resume (Community) V2" });
    expect(s.checkedAt).toBe("2026-10-11T04:00:00.000Z");
    expect(mcp.calls.map((c) => c.name)).toEqual(["figma_get_status", "figma_execute"]);
    expect(mcp.calls[0]?.args).toEqual({ probe: true });
    expect(mcp.executeCalls()[0]).toMatchObject({ op: "ping", args: { fileKey: DEFAULT_CV_FILE_KEY } });
  });

  it("is not connected when the plugin is closed", async () => {
    const { bridge, mcp } = setup({ connected: false });
    expect(await bridge.status()).toMatchObject({ state: "not_connected", connected: false });
    expect(mcp.executeCalls()).toHaveLength(0);
  });

  it("is wrong_file when the plugin runs only in another file", async () => {
    const { bridge, mcp } = setup();
    mcp.cvFileOpen = false;
    mcp.otherFiles = [{ fileKey: "moodboard", fileName: "Moodboard", active: true }];
    expect(await bridge.status()).toMatchObject({ state: "wrong_file", connected: false });
  });

  it("is not connected when the CV file does not answer the ping", async () => {
    const { bridge, mcp } = setup();
    mcp.onOp("ping", () => {
      throw new Error("plugin hung");
    });
    const s = await bridge.status();
    expect(s).toMatchObject({ state: "not_connected", connected: false });
    expect(s.message).toMatch(/plugin hung/);
  });

  it("reports server_unavailable when figma-console-mcp cannot start, and retries next time", async () => {
    let attempts = 0;
    const mcp = new FakeFigmaMcp({ api: makeDoc() });
    const bridge = new FigmaBridge({
      connect: async () => {
        attempts++;
        if (attempts === 1) throw new Error("spawn node ENOENT");
        return mcp;
      },
    });
    const down = await bridge.status();
    expect(down).toMatchObject({ state: "server_unavailable", connected: false });
    expect(down.message).toMatch(/ENOENT/);
    expect((await bridge.status()).state).toBe("connected");
    expect(attempts).toBe(2);
  });
});

describe("FigmaBridge.execute", () => {
  it("sends code, the time limit and the CV file key, and returns the value", async () => {
    const { bridge, mcp } = setup();
    mcp.onOp("custom", (code, args) => ({ echo: code, timeout: args.timeout }));
    await expect(bridge.execute("return 1", { timeoutMs: 2500 })).resolves.toEqual({ echo: "return 1", timeout: 2500 });
    expect(mcp.calls[0]?.args).toEqual({ code: "return 1", timeout: 2500, fileKey: DEFAULT_CV_FILE_KEY });
    await bridge.execute("return 2");
    expect(mcp.calls[1]?.args.timeout).toBe(10_000);
  });

  it("refuses time limits above the 30 s cap and empty code", async () => {
    const { bridge, mcp } = setup();
    for (const timeoutMs of [30_001, 0, -1, 1.5]) {
      expect(await codeOf(bridge.execute("return 1", { timeoutMs }))).toBe("invalid_argument");
    }
    expect(await codeOf(bridge.execute("   "))).toBe("invalid_argument");
    expect(mcp.calls).toHaveLength(0);
    await expect(bridge.execute("return 3", { timeoutMs: 30_000 })).resolves.toBe(3);
  });

  it("throws typed errors: not connected, plugin error, timeout, transport failure", async () => {
    const { bridge, mcp, connects } = setup();
    mcp.connected = false;
    const notConnected = bridge.execute("return 1");
    await expect(notConnected).rejects.toSatisfy((e: unknown) => isFigmaUnavailable(e));
    mcp.connected = true;

    expect(await codeOf(bridge.execute("throw new Error('kaboom')"))).toBe("plugin_error");
    expect(await codeOf(bridge.execute("return ("))).toBe("plugin_error"); // the fake has no syntax-error path; the real plugin says "Syntax error"

    mcp.failNextCall(Object.assign(new Error("Request timed out"), { code: -32001 }));
    expect(await codeOf(bridge.execute("return 1"))).toBe("timeout");

    mcp.failNextCall(new Error("Connection closed"));
    expect(await codeOf(bridge.execute("return 1"))).toBe("server_unavailable");
    expect(connects()).toBe(1);
    await mcp.close();
    // A closed client is replaced by a fresh connection on the next call.
    const fresh = new FakeFigmaMcp({ api: makeDoc() });
    const b2 = new FigmaBridge({ connect: async () => (mcp.closed ? fresh : mcp) });
    await expect(b2.execute("return 5")).resolves.toBe(5);
  });

  it("refuses a result that came back from another file", async () => {
    const { bridge, mcp } = setup();
    mcp.onTool("figma_execute", () => ({
      content: [{ type: "text", text: JSON.stringify({ success: true, result: 1, fileContext: { fileKey: "moodboard", fileName: "Moodboard" } }) }],
    }));
    expect(await codeOf(bridge.execute("return 1"))).toBe("wrong_file");
  });
});

describe("Drafts page and template copies", () => {
  it("ensureDraftsPage creates the page once", async () => {
    const api = new FakeFigmaApi({ pages: [{ id: "0:1", name: "resume" }] });
    const { bridge } = setup({ api });
    const first = await bridge.ensureDraftsPage();
    expect(first).toMatchObject({ name: "Drafts", created: true });
    expect(await bridge.ensureDraftsPage()).toEqual({ ...first, created: false });
  });

  it("duplicateTemplate copies a template onto Drafts and links to it", async () => {
    const { bridge, api } = setup();
    const copy = await bridge.duplicateTemplate("459:1767", "NOVAPAY_SENIOR-FE_EN_v1");
    expect(copy).toMatchObject({ name: "NOVAPAY_SENIOR-FE_EN_v1", pageId: "2:3", width: 595, height: 842 });
    expect(copy.url).toBe(`https://www.figma.com/design/${DEFAULT_CV_FILE_KEY}/Resume-Community-V2?node-id=${copy.id.replace(":", "-")}`);
    expect(api.page("Drafts").children.map((n) => n.name)).toContain("NOVAPAY_SENIOR-FE_EN_v1");
    expect(await codeOf(bridge.duplicateTemplate("459:1767", "NOVAPAY_SENIOR-FE_EN_v1"))).toBe("name_taken");
    expect(await codeOf(bridge.duplicateTemplate("459:1767", ""))).toBe("invalid_argument");
    expect(await codeOf(bridge.duplicateTemplate("not an id", "X_Y_EN_v1"))).toBe("invalid_argument");
  });

  it("findDraftFrame finds a frame on Drafts by name", async () => {
    const { bridge } = setup();
    expect(await bridge.findDraftFrame("SPIKE_TEST_EN_v1")).toMatchObject({ id: "601:1", pageId: "2:3", visible: true });
    expect(await bridge.findDraftFrame("NOPE")).toBeNull();
  });
});

describe("FigmaBridge.exportFramePdf", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bridges-export-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes the frame's PDF and returns its hash, page count and size", async () => {
    const { bridge, mcp } = setup();
    const out = join(dir, "pdf", "nested", "SPIKE_TEST_EN_v1.pdf");
    const res = await bridge.exportFramePdf("601:1", out);
    expect(res).toMatchObject({
      path: out,
      bytes: cvPdf.length,
      pageCount: 1,
      widthPt: 595,
      heightPt: 842,
      onePageA4: true,
      frameId: "601:1",
      frameName: "SPIKE_TEST_EN_v1",
    });
    expect(res.sha256).toBe(await sha256File(out));
    expect(new Uint8Array(await readFile(out))).toEqual(cvPdf);
    expect(mcp.executeCalls()[0]?.args.timeout).toBe(30_000);
    expect(await readdir(join(dir, "pdf", "nested"))).toEqual(["SPIKE_TEST_EN_v1.pdf"]);
  });

  it("overwrites an earlier export of the same frame", async () => {
    const { bridge } = setup();
    const out = join(dir, "x.pdf");
    await writeFile(out, "stale");
    const res = await bridge.exportFramePdf("601:1", out);
    expect(res.sha256).toBe(await sha256File(out));
  });

  it("reports two pages without refusing them (the CV rule is the caller's)", async () => {
    const api = makeDoc();
    api.node("601:1").pdf = twoPagePdf;
    const { bridge } = setup({ api });
    expect(await bridge.exportFramePdf("601:1", join(dir, "two.pdf"))).toMatchObject({ pageCount: 2, onePageA4: false });
  });

  it("refuses bytes that are not a PDF and leaves no file", async () => {
    const api = makeDoc();
    api.node("601:1").pdf = new TextEncoder().encode("<html>nope</html>");
    const { bridge } = setup({ api });
    const out = join(dir, "bad.pdf");
    expect(await codeOf(bridge.exportFramePdf("601:1", out))).toBe("export_failed");
    expect(existsSync(out)).toBe(false);
    expect(await readdir(dir)).toEqual([]);
  });

  it("refuses hidden frames, frames outside Drafts and bad ids", async () => {
    const { bridge } = setup();
    expect(await codeOf(bridge.exportFramePdf("601:9", join(dir, "h.pdf")))).toBe("frame_hidden");
    expect(await codeOf(bridge.exportFramePdf("459:1767", join(dir, "t.pdf")))).toBe("not_in_drafts");
    expect(await bridge.exportFramePdf("459:1767", join(dir, "t.pdf"), { requireDrafts: false })).toMatchObject({ pageCount: 1 });
    expect(await codeOf(bridge.exportFramePdf("601:1; figma.closePlugin()", join(dir, "x.pdf")))).toBe("invalid_argument");
    expect(await codeOf(bridge.exportFramePdf("777:7", join(dir, "m.pdf")))).toBe("not_found");
  });

  it("works with a scripted reply (no fake document)", async () => {
    const mcp = new FakeFigmaMcp().onOp("export-pdf", () => ({
      base64: Buffer.from(cvPdf).toString("base64"),
      name: "NOVAPAY_SENIOR-FE_EN_v1",
      width: 595,
      height: 842,
      pageName: "Drafts",
    }));
    const bridge = new FigmaBridge({ connect: async () => mcp });
    const res = await bridge.exportFramePdf("601:1", join(dir, "scripted.pdf"));
    expect(res).toMatchObject({ frameName: "NOVAPAY_SENIOR-FE_EN_v1", pageCount: 1 });
  });
});

describe("protected-page fingerprint", () => {
  it("covers every page but Drafts and is stable while nothing changes", async () => {
    const { bridge } = setup();
    const before = await bridge.fingerprintProtectedPages();
    expect(before.pages.map((p) => p.name)).toEqual(["resume", "components"]);
    expect(before.fileKey).toBe(DEFAULT_CV_FILE_KEY);
    expect(before.resourcesError).toBeNull();
    const again = await bridge.fingerprintProtectedPages();
    expect(again.hash).toBe(before.hash);
  });

  it("ignores edits on Drafts and catches any change to a protected page", async () => {
    const { bridge, api } = setup();
    const before = await bridge.fingerprintProtectedPages();

    // A CV task edits its own frame on Drafts.
    api.node("601:1").name = "SPIKE_TEST_EN_v2";
    await bridge.duplicateTemplate("459:1767", "NOVAPAY_SENIOR-FE_EN_v1");
    expect(diffFingerprints(before, await bridge.fingerprintProtectedPages()).changed).toBe(false);

    // …and anything on resume is caught.
    api.node("459:1800").characters = "Senior engineer [SPIKE EDIT]";
    const diff = diffFingerprints(before, await bridge.fingerprintProtectedPages());
    expect(diff.changed).toBe(true);
    expect(diff.changes).toEqual([
      expect.objectContaining({ kind: "node_changed", nodeId: "459:1800", pageName: "resume", fields: ["text"] }),
    ]);
  });

  it("catches a changed local style", async () => {
    const { bridge, api } = setup();
    const before = await bridge.fingerprintProtectedPages();
    api.resources = { paintStyles: [{ id: "S:1", name: "Accent", paints: [{ type: "SOLID", color: { r: 0, g: 0, b: 1 } }] }] };
    expect(diffFingerprints(before, await bridge.fingerprintProtectedPages()).changes).toEqual([
      { kind: "resources_changed", detail: "paintStyles" },
    ]);
  });

  it("records an unreadable resources call instead of failing", async () => {
    const { bridge, mcp } = setup();
    mcp.onOp("file-resources", () => {
      throw new Error("Execution timed out after 30000ms");
    });
    const fp = await bridge.fingerprintProtectedPages();
    expect(fp.resourcesError).toMatch(/timed out/);
    expect(fp.resourcesHash).toBeNull();
  });

  it("fails as needs_figma material when Figma is gone", async () => {
    const { bridge, mcp } = setup();
    mcp.connected = false;
    await expect(bridge.fingerprintProtectedPages()).rejects.toSatisfy((e: unknown) => isFigmaUnavailable(e));
  });

  it("lists templates from the protected pages", async () => {
    const { bridge } = setup();
    expect(await bridge.listTemplates()).toEqual([
      expect.objectContaining({ id: "459:1767", pageName: "resume", sectionName: "EN", width: 595, height: 842 }),
    ]);
  });
});

describe("FigmaBridge.waitForConnection", () => {
  it("polls with exponential backoff until Figma connects", async () => {
    const { bridge, mcp, clock } = setup({ connected: false });
    let polls = 0;
    mcp.onTool("figma_get_status", () => {
      polls++;
      if (polls === 4) mcp.connected = true;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              currentFileKey: mcp.connected ? DEFAULT_CV_FILE_KEY : undefined,
              setup: { probeResult: { success: mcp.connected, latencyMs: 1 } },
            }),
          },
        ],
      };
    });
    const s = await bridge.waitForConnection({ initialDelayMs: 1000, maxDelayMs: 3000, timeoutMs: 60_000 });
    expect(s.state).toBe("connected");
    expect(clock.sleeps).toEqual([1000, 2000, 3000]);
  });

  it("gives up after the timeout with the last status", async () => {
    const { bridge, clock } = setup({ connected: false });
    const s = await bridge.waitForConnection({ initialDelayMs: 1000, maxDelayMs: 4000, timeoutMs: 10_000 });
    expect(s.state).toBe("not_connected");
    expect(clock.sleeps).toEqual([1000, 2000, 4000, 3000]);
  });

  it("stops when aborted", async () => {
    const { bridge, clock } = setup({ connected: false });
    const ctl = new AbortController();
    ctl.abort();
    const s = await bridge.waitForConnection({ signal: ctl.signal });
    expect(s.state).toBe("not_connected");
    expect(clock.sleeps).toEqual([]);
  });
});

describe("FigmaBridge lifecycle", () => {
  it("connects lazily, once, and closes on stop", async () => {
    const { bridge, mcp, connects } = setup();
    expect(connects()).toBe(0);
    await Promise.all([bridge.status(), bridge.execute("return 1")]);
    expect(connects()).toBe(1);
    await bridge.stop();
    expect(mcp.closed).toBe(true);
  });
});
