import { describe, expect, it } from "vitest";
import { navigateLines } from "./__fixtures__/screenshots.js";
import { PageUrlCollector } from "./page-urls.js";

const CHROME = "mcp__claude-in-chrome__";
const use = (id: string, name: string, input: unknown) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
const result = (id: string, text: string, isError = false) =>
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: [{ type: "text", text }] }] } });

function collect(lines: string[]): string[] {
  const c = new PageUrlCollector();
  for (const l of lines) c.push(l);
  return c.urls;
}

describe("PageUrlCollector (PM2 S10)", () => {
  it("collects the page a navigate reached, including a redirect", () => {
    expect(collect(navigateLines("t1", "https://itviec.com/jobs/1", "https://acme.wd3.myworkdayjobs.com/apply"))).toEqual(["https://acme.wd3.myworkdayjobs.com/apply"]);
  });

  it("falls back to the navigate target when the reply names no URL", () => {
    expect(collect([use("t1", `${CHROME}navigate`, { url: "itviec.com/jobs/1" }), result("t1", "Navigation complete")])).toEqual(["https://itviec.com/jobs/1"]);
  });

  it("collects every tab URL the tab tools report (a click that left the site shows up here), not chrome:// pages", () => {
    const tabs = JSON.stringify({ availableTabs: [{ tabId: 1, title: "Apply", url: "https://itviec.com/apply" }, { tabId: 2, title: "Bank", url: "https://vietcombank.com.vn/" }, { tabId: 3, title: "New Tab", url: "chrome://newtab/" }] });
    expect(collect([use("t2", `${CHROME}tabs_context_mcp`, {}), result("t2", tabs)])).toEqual(["https://itviec.com/apply", "https://vietcombank.com.vn/"]);
  });

  it("takes only the labelled page URL from other Chrome tools, never links inside the page text", () => {
    const text = "Title: Senior FE\nURL: https://itviec.com/jobs/1\n\nApply via https://evil.example.org/form or see URL: https://other.example.net";
    expect(collect([use("t3", `${CHROME}get_page_text`, { tabId: 1 }), result("t3", text)])).toEqual(["https://itviec.com/jobs/1"]);
  });

  it("ignores a blocked or failed call, and other tools' results", () => {
    expect(
      collect([
        use("t4", `${CHROME}navigate`, { url: "https://vietcombank.com.vn" }),
        result("t4", "Blocked by site guard: vietcombank.com.vn is not an approved site", true),
        use("t5", "WebSearch", { query: "x" }),
        result("t5", "https://anything.example.com"),
      ]),
    ).toEqual([]);
  });

  it("lists each URL once, in order", () => {
    expect(collect([...navigateLines("a", "https://itviec.com/1"), ...navigateLines("b", "https://itviec.com/1"), ...navigateLines("c", "https://itviec.com/2")])).toEqual([
      "https://itviec.com/1",
      "https://itviec.com/2",
    ]);
  });
});
