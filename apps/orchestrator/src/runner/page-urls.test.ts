import { describe, expect, it } from "vitest";
import { navigateLines } from "./__fixtures__/screenshots.js";
import { PageUrlCollector, tabIdsIn } from "./page-urls.js";

const CHROME = "mcp__claude-in-chrome__";
const use = (id: string, name: string, input: unknown) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
const result = (id: string, text: string, isError = false) =>
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: [{ type: "text", text }] }] } });

function collect(lines: string[]): string[] {
  const c = new PageUrlCollector();
  for (const l of lines) c.push(l);
  return c.urls;
}

describe("PageUrlCollector page visits (W4a handoff: LinkedIn's 3–8 s pauses)", () => {
  it("records each successful navigate with the time the bot asked for it, repeats included; blocked ones are left out", () => {
    let t = Date.parse("2026-10-11T02:00:00.000Z");
    const c = new PageUrlCollector(() => t);
    c.push(use("n1", `${CHROME}navigate`, { url: "https://www.linkedin.com/jobs/search?keywords=react" }));
    t += 1500;
    c.push(result("n1", "Navigated to https://www.linkedin.com/jobs/search?keywords=react"));
    t += 3500;
    c.push(use("n2", `${CHROME}navigate`, { url: "https://www.linkedin.com/jobs/view/1" }));
    c.push(result("n2", "Navigation complete"));
    t += 4000;
    c.push(use("n3", `${CHROME}navigate`, { url: "https://evil.example.org" }));
    c.push(result("n3", "Blocked by site guard", true));
    t += 1000;
    c.push(use("n4", `${CHROME}navigate`, { url: "https://www.linkedin.com/jobs/search?keywords=react" }));
    c.push(result("n4", "Navigated to https://www.linkedin.com/jobs/search?keywords=react"));
    expect(c.visits).toEqual([
      { url: "https://www.linkedin.com/jobs/search?keywords=react", at: "2026-10-11T02:00:00.000Z" },
      { url: "https://www.linkedin.com/jobs/view/1", at: "2026-10-11T02:00:05.000Z" },
      { url: "https://www.linkedin.com/jobs/search?keywords=react", at: "2026-10-11T02:00:10.000Z" },
    ]);
  });
});

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

describe("PageUrlCollector opened pages (skill self-repair, QA M-b)", () => {
  function run(lines: string[]): PageUrlCollector {
    const c = new PageUrlCollector();
    for (const l of lines) c.push(l);
    return c;
  }

  it("counts a navigate in a tab the bot created, at the URL the reply confirms", () => {
    const c = run([
      use("c1", `${CHROME}tabs_create_mcp`, {}),
      result("c1", 'Created new tab. {"tabId": 7, "url": "chrome://newtab/"}'),
      use("n1", `${CHROME}navigate`, { url: "https://www.topcv.vn/viec-lam/x/1.html", tabId: 7 }),
      result("n1", "Navigated to https://www.topcv.vn/viec-lam/x/1.html?ta_source=y"),
    ]);
    expect(c.opened).toEqual(["https://www.topcv.vn/viec-lam/x/1.html?ta_source=y"]);
  });

  it("never counts Ba's own tabs from a tab listing, a navigate in a tab the bot did not create, or a target the reply did not confirm", () => {
    const tabs = JSON.stringify({ availableTabs: [{ tabId: 1, title: "Job", url: "https://www.topcv.vn/viec-lam/x/2.html" }] });
    const c = run([
      use("t1", `${CHROME}tabs_context_mcp`, {}),
      result("t1", tabs),
      use("n1", `${CHROME}navigate`, { url: "https://www.topcv.vn/viec-lam/x/3.html", tabId: 1 }),
      result("n1", "Navigated to https://www.topcv.vn/viec-lam/x/3.html"),
      use("c1", `${CHROME}tabs_create_mcp`, {}),
      result("c1", "Created tab 9"),
      use("n2", `${CHROME}navigate`, { url: "https://www.topcv.vn/viec-lam/x/4.html", tabId: 9 }),
      result("n2", "Navigation complete"),
      use("n3", `${CHROME}navigate`, { url: "https://www.topcv.vn/viec-lam/x/5.html", tabId: 9 }),
      result("n3", "Blocked by the site guard: https://www.topcv.vn/viec-lam/x/5.html", true),
    ]);
    expect(c.opened).toEqual([]);
    expect(c.urls).toContain("https://www.topcv.vn/viec-lam/x/2.html");
  });
});

describe("tab attribution is tolerant of the reply format (QA M-b follow-up)", () => {
  const nav = (id: string, url: string, tabId: unknown, reply = `Navigated to ${url}`) => [use(id, `${CHROME}navigate`, { url, tabId }), result(id, reply)];
  const JOB = "https://www.topcv.vn/viec-lam/x/1.html";

  it.each([
    ['JSON {"tabId": 7}', '{"tabId": 7, "url": "chrome://newtab/"}'],
    ['JSON {"tab_id": 7}', '{"tab_id": 7}'],
    ["Tab ID: 7", "Created a new tab. Tab ID: 7"],
    ["tabId 7", "Opened tabId 7 in the group"],
    ["id=7", "tab created (id=7)"],
  ])("reads the created tab from %s", (_shape, reply) => {
    expect(tabIdsIn(reply)).toContain("7");
    const c = run([use("c", `${CHROME}tabs_create_mcp`, {}), result("c", reply), ...nav("n", JOB, 7), ...nav("m", JOB, 3)]);
    expect(c.opened).toEqual([JOB]);
    expect(c.unattributed).toBe(1);
  });

  it("fallback: with no id in the create reply, a navigate in a tab not listed by the first tabs_context_mcp (Ba's tabs) counts", () => {
    const listing = "Tabs:\n- Tab ID: 1 · Gmail · https://mail.google.com/\n- Tab ID: 2 · TopCV · https://www.topcv.vn/viec-lam/x/2.html";
    const c = run([
      use("t", `${CHROME}tabs_context_mcp`, {}),
      result("t", listing),
      use("c", `${CHROME}tabs_create_mcp`, {}),
      result("c", "Created a new tab."),
      ...nav("n1", JOB, 5),
      ...nav("n2", "https://www.topcv.vn/viec-lam/x/3.html", 2),
    ]);
    expect(c.opened).toEqual([JOB]);
    expect(c.unattributed).toBe(1);
    // The job only listed in Ba's tab never counts.
    expect(c.opened).not.toContain("https://www.topcv.vn/viec-lam/x/2.html");
  });

  it("with no parsable id anywhere, confirmed navigates count, a listing alone never does, an unconfirmed target never does", () => {
    const c = run([
      use("t", `${CHROME}tabs_context_mcp`, {}),
      result("t", "One tab: TopCV https://www.topcv.vn/viec-lam/x/2.html"),
      use("c", `${CHROME}tabs_create_mcp`, {}),
      result("c", "Created a new tab."),
      ...nav("n1", JOB, "abc"),
      ...nav("n2", "https://www.topcv.vn/viec-lam/x/4.html", "abc", "Navigation complete"),
    ]);
    expect(c.opened).toEqual([JOB]);
  });

  it("QA final round: a 404 or not-found page (in the navigate reply or the page's text) is not opened", () => {
    const create = [use("c", `${CHROME}tabs_create_mcp`, {}), result("c", '{"tabId": 7}')];
    expect(run([...create, ...nav("n", JOB, 7, `Navigated to ${JOB} — 404 Not Found`)]).opened).toEqual([]);
    const c = run([
      ...create,
      ...nav("n1", JOB, 7),
      use("g", `${CHROME}get_page_text`, { tabId: 7 }),
      result("g", "Không tìm thấy trang. Trang bạn tìm kiếm không tồn tại."),
      ...nav("n2", "https://www.topcv.vn/viec-lam/x/9.html", 7),
      use("h", `${CHROME}get_page_text`, { tabId: 7 }),
      result("h", "Frontend Engineer · NovaPay · Mô tả công việc …"),
    ]);
    expect(c.opened).toEqual(["https://www.topcv.vn/viec-lam/x/9.html"]);
  });

  function run(lines: string[]): PageUrlCollector {
    const c = new PageUrlCollector();
    for (const l of lines) c.push(l);
    return c;
  }
});
