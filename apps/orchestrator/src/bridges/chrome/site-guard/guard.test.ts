import { describe, expect, it } from "vitest";
import { evaluateChromeToolCall, SITE_GUARD_TOOLS } from "./guard.js";

const policy = { allowedSites: ["topcv.vn", "itviec.com"] };
const call = (tool: string, toolInput: Record<string, unknown>) => ({ toolName: `mcp__claude-in-chrome__${tool}`, toolInput });

describe("evaluateChromeToolCall", () => {
  it("checks navigate URLs", () => {
    expect(evaluateChromeToolCall(call("navigate", { url: "https://www.topcv.vn/viec-lam", tabId: 1 }), policy)).toEqual({ allow: true });
    expect(evaluateChromeToolCall(call("navigate", { url: "https://example.com", tabId: 1 }), policy)).toMatchObject({
      allow: false,
      rule: "navigate_host",
      target: "example.com",
    });
    expect(evaluateChromeToolCall(call("navigate", { tabId: 1 }), policy)).toMatchObject({ allow: false, rule: "navigate_url" });
  });

  it("checks javascript_tool code", () => {
    expect(evaluateChromeToolCall(call("javascript_tool", { action: "javascript_exec", text: "document.title", tabId: 1 }), policy)).toEqual({
      allow: true,
    });
    expect(
      evaluateChromeToolCall(call("javascript_tool", { action: "javascript_exec", text: "location.href='https://evil.example'", tabId: 1 }), policy),
    ).toMatchObject({ allow: false, rule: "js_host" });
  });

  it("checks every item of a browser_batch, by short or full tool name", () => {
    const ok = call("browser_batch", {
      actions: [
        { name: "navigate", input: { url: "https://topcv.vn/", tabId: 1 } },
        { name: "computer", input: { action: "screenshot", tabId: 1 } },
        { name: "javascript_tool", input: { action: "javascript_exec", text: "document.title", tabId: 1 } },
      ],
    });
    expect(evaluateChromeToolCall(ok, policy)).toEqual({ allow: true });

    const sneaky = call("browser_batch", {
      actions: [
        { name: "computer", input: { action: "screenshot", tabId: 1 } },
        { name: "mcp__claude-in-chrome__navigate", input: { url: "https://mail.google.com", tabId: 1 } },
      ],
    });
    const decision = evaluateChromeToolCall(sneaky, policy);
    expect(decision).toMatchObject({ allow: false, rule: "navigate_host", target: "mail.google.com" });
    if (!decision.allow) expect(decision.reason).toMatch(/browser_batch action 2/);

    const js = call("browser_batch", { actions: [{ name: "javascript_tool", input: { text: "fetch('https://evil.example')" } }] });
    expect(evaluateChromeToolCall(js, policy)).toMatchObject({ allow: false, rule: "js_host" });
  });

  it("blocks malformed and nested batches", () => {
    expect(evaluateChromeToolCall(call("browser_batch", {}), policy)).toMatchObject({ allow: false, rule: "batch_malformed" });
    expect(evaluateChromeToolCall(call("browser_batch", { actions: [42] }), policy)).toMatchObject({ allow: false, rule: "batch_malformed" });
    expect(
      evaluateChromeToolCall(call("browser_batch", { actions: [{ name: "browser_batch", input: { actions: [] } }] }), policy),
    ).toMatchObject({ allow: false, rule: "batch_nested" });
  });

  it("blocks tools that leave the guarded browser or run unchecked workflows", () => {
    expect(evaluateChromeToolCall(call("shortcuts_execute", { tabId: 1, command: "summarize" }), policy)).toMatchObject({
      allow: false,
      rule: "chrome_shortcut",
    });
    expect(evaluateChromeToolCall(call("switch_browser", {}), policy)).toMatchObject({ allow: false, rule: "chrome_switch_browser" });
    expect(evaluateChromeToolCall(call("select_browser", { deviceId: "x" }), policy)).toMatchObject({
      allow: false,
      rule: "chrome_switch_browser",
    });
  });

  it("live 2026-10-20: select_browser only for the deviceId Ba chose; never another id, never inside a batch; switch_browser never", () => {
    const chosen = { ...policy, browserId: "3e83d913-aaaa-4bbb-8ccc-1234567890ab" };
    expect(evaluateChromeToolCall(call("select_browser", { deviceId: "3e83d913-aaaa-4bbb-8ccc-1234567890ab" }), chosen)).toEqual({ allow: true });
    expect(evaluateChromeToolCall(call("select_browser", { deviceId: "9f00aa11-bbbb-4ccc-8ddd-0987654321ff" }), chosen)).toMatchObject({ allow: false, rule: "chrome_switch_browser", reason: expect.stringContaining("3e83d913") });
    expect(evaluateChromeToolCall(call("select_browser", {}), chosen)).toMatchObject({ allow: false });
    expect(evaluateChromeToolCall(call("switch_browser", { deviceId: "3e83d913-aaaa-4bbb-8ccc-1234567890ab" }), chosen)).toMatchObject({ allow: false, rule: "chrome_switch_browser" });
    const batch = { actions: [{ name: "select_browser", input: { deviceId: "3e83d913-aaaa-4bbb-8ccc-1234567890ab" } }] };
    expect(evaluateChromeToolCall(call("browser_batch", batch), chosen)).toMatchObject({ allow: false });
  });

  it("lets other Chrome tools and other servers through", () => {
    expect(evaluateChromeToolCall(call("tabs_create_mcp", {}), policy)).toEqual({ allow: true });
    expect(evaluateChromeToolCall(call("computer", { action: "left_click", coordinate: [1, 2], tabId: 1 }), policy)).toEqual({ allow: true });
    expect(evaluateChromeToolCall({ toolName: "Read", toolInput: { file_path: "/x" } }, policy)).toEqual({ allow: true });
  });

  it("blocks everything when the allowlist is empty or invalid", () => {
    expect(evaluateChromeToolCall(call("navigate", { url: "https://topcv.vn" }), { allowedSites: [] })).toMatchObject({ allow: false });
    expect(evaluateChromeToolCall(call("navigate", { url: "https://topcv.vn" }), { allowedSites: ["https://topcv.vn/x"] })).toMatchObject({
      allow: false,
      rule: "guard_config",
    });
  });

  it("PM2 S7: refuses a screenshot saved to disk (the runner keeps screenshots); plain screenshots and clicks pass", () => {
    for (const v of [true, "true", 1]) {
      expect(evaluateChromeToolCall(call("computer", { action: "screenshot", tabId: 1, save_to_disk: v }), policy)).toMatchObject({
        allow: false,
        rule: "screenshot_save_to_disk",
      });
    }
    expect(evaluateChromeToolCall(call("computer", { action: "screenshot", tabId: 1 }), policy)).toEqual({ allow: true });
    expect(evaluateChromeToolCall(call("computer", { action: "screenshot", tabId: 1, save_to_disk: false }), policy)).toEqual({ allow: true });
    expect(
      evaluateChromeToolCall(call("browser_batch", { actions: [{ name: "computer", input: { action: "screenshot", save_to_disk: true } }] }), policy),
    ).toMatchObject({ allow: false, rule: "screenshot_save_to_disk" });
  });

  it("lists the tools the settings must route to the hook, never tabs_create_mcp", () => {
    expect(SITE_GUARD_TOOLS).toEqual(["navigate", "javascript_tool", "browser_batch", "shortcuts_execute", "switch_browser", "select_browser", "computer"]);
  });
});
