import { describe, expect, it } from "vitest";
import { hostAllowed, InvalidAllowlistError, normalizeAllowlist } from "./allowlist.js";
import { checkNavigateUrl, checkPageUrlValue } from "./url.js";

const ALLOW = normalizeAllowlist(["topcv.vn", "itviec.com", "jobs.lever.co"]);

describe("normalizeAllowlist", () => {
  it("lowercases, trims, drops wildcards, dots and duplicates", () => {
    expect(normalizeAllowlist([" TopCV.vn ", "*.itviec.com", ".linkedin.com", "topcv.vn.", "topcv.vn"])).toEqual([
      "topcv.vn",
      "itviec.com",
      "linkedin.com",
    ]);
  });

  it("converts international names to their ASCII form", () => {
    expect(normalizeAllowlist(["bücher.de"])).toEqual(["xn--bcher-kva.de"]);
  });

  it("refuses public suffixes, IP addresses, localhost and local names: an entry may only widen to its own subdomains (PM2 M2)", () => {
    for (const bad of ["com", "vn", "com.vn", "github.io", "127.0.0.1", "192.168.1.1", "localhost", "printer.local", "nas.home.arpa", "*.vn", ".com.vn", "2130706433", "bücher.example"]) {
      expect(() => normalizeAllowlist([bad]), bad).toThrow(InvalidAllowlistError);
    }
    expect(() => normalizeAllowlist(["topcv.vn", "vn"])).toThrow(/vn/);
    expect(normalizeAllowlist(["topcv.vn", "itviec.com", "acme.wd3.myworkdayjobs.com"])).toEqual(["topcv.vn", "itviec.com", "acme.wd3.myworkdayjobs.com"]);
  });

  it("rejects entries that are not plain host names", () => {
    for (const bad of ["https://topcv.vn", "topcv.vn/jobs", "topcv.vn:443", "user@topcv.vn", "", "  ", "a b.com", "*"]) {
      expect(() => normalizeAllowlist([bad]), bad).toThrow(InvalidAllowlistError);
    }
  });
});

describe("hostAllowed", () => {
  it("matches the domain and its subdomains, never its parents or look-alikes", () => {
    expect(hostAllowed("topcv.vn", ALLOW)).toBe(true);
    expect(hostAllowed("www.topcv.vn", ALLOW)).toBe(true);
    expect(hostAllowed("a.b.topcv.vn", ALLOW)).toBe(true);
    expect(hostAllowed("TOPCV.VN.", ALLOW)).toBe(true);
    expect(hostAllowed("vn", ALLOW)).toBe(false);
    expect(hostAllowed("faketopcv.vn", ALLOW)).toBe(false);
    expect(hostAllowed("topcv.vn.evil.example", ALLOW)).toBe(false);
  });

  it("never allows an IP address or a parent of a listed site (PM2 M2)", () => {
    expect(hostAllowed("127.0.0.1", ALLOW)).toBe(false);
    expect(hostAllowed("192.168.1.1", ALLOW)).toBe(false);
    expect(hostAllowed("lever.co", ALLOW)).toBe(false);
    expect(hostAllowed("acme.jobs.lever.co", ALLOW)).toBe(true);
  });

  it("allows nothing with an empty list", () => {
    expect(hostAllowed("topcv.vn", [])).toBe(false);
  });
});

describe("checkNavigateUrl (the navigate tool)", () => {
  const allowed = [
    "https://topcv.vn/viec-lam",
    "https://www.topcv.vn/x?y=1#z",
    "http://topcv.vn",
    "HTTPS://TOPCV.VN/",
    "https://topcv.vn./",
    "https://topcv.vn:8443/x",
    "https://user:pw@topcv.vn/",
    "topcv.vn/viec-lam",
    "www.itviec.com",
    "//topcv.vn/x",
    "http://jobs.lever.co:3000/test",
    "back",
    "forward",
    " Back ",
  ];
  it.each(allowed)("allows %s", (url) => {
    expect(checkNavigateUrl(url, ALLOW)).toEqual({ allow: true });
  });

  const blocked: Array<[string, string]> = [
    ["https://example.com", "navigate_host"],
    ["https://topcv.vn.evil.example/", "navigate_host"],
    ["https://faketopcv.vn/", "navigate_host"],
    ["https://vn/", "navigate_host"],
    ["https://topcv.vn@evil.example/", "navigate_host"],
    ["https://evil.example\\@topcv.vn", "navigate_host"],
    ["https://evil.example#@topcv.vn", "navigate_host"],
    ["https://evil.example?topcv.vn", "navigate_host"],
    ["https://tоpcv.vn/", "navigate_host"], // Cyrillic "о"
    ["https://127.0.0.2/", "navigate_host"],
    ["http://localhost:3000/", "navigate_host"],
    ["evil.example/topcv.vn", "navigate_host"],
    ["javascript:alert(1)", "navigate_scheme"],
    ["JavaScript:alert(1)", "navigate_scheme"],
    ["java\tscript:alert(1)", "navigate_scheme"],
    ["  javascript:alert(1)", "navigate_scheme"],
    ["data:text/html,<script>alert(1)</script>", "navigate_scheme"],
    ["file:///etc/passwd", "navigate_scheme"],
    ["chrome://settings", "navigate_scheme"],
    ["chrome-extension://abc/page.html", "navigate_scheme"],
    ["about:blank", "navigate_scheme"],
    ["view-source:https://topcv.vn/", "navigate_scheme"],
    ["blob:https://topcv.vn/0f7b", "navigate_scheme"],
    ["ftp://topcv.vn/", "navigate_scheme"],
    ["ws://topcv.vn/", "navigate_scheme"],
    ["mailto:hr@topcv.vn", "navigate_scheme"],
    ["topcv.vn:443/jobs", "navigate_scheme"],
    ["", "navigate_url"],
    ["   ", "navigate_url"],
    ["https://", "navigate_url"],
  ];
  it.each(blocked)("blocks %s", (url, rule) => {
    const decision = checkNavigateUrl(url, ALLOW);
    expect(decision.allow).toBe(false);
    if (!decision.allow) {
      expect(decision.rule).toBe(rule);
      expect(decision.reason).toMatch(/^Blocked by site guard: /);
    }
  });

  it("names the host and the allowed sites in the message", () => {
    const decision = checkNavigateUrl("https://mail.google.com/mail/u/0", ALLOW);
    expect(decision).toMatchObject({ allow: false, target: "mail.google.com" });
    if (!decision.allow) expect(decision.reason).toContain("topcv.vn, itviec.com, jobs.lever.co");
  });

  it("blocks everything when the allowlist is empty", () => {
    expect(checkNavigateUrl("https://topcv.vn/", []).allow).toBe(false);
  });
});

describe("checkPageUrlValue (URLs used by page JavaScript)", () => {
  it("allows same-origin relative URLs", () => {
    for (const exact of ["/api/jobs", "?page=2", "#reviews", "./x", "../y", "jobs/1", ""]) {
      expect(checkPageUrlValue({ exact }, ALLOW).allow, exact).toBe(true);
    }
  });

  it("checks absolute and protocol-relative URLs against the allowlist", () => {
    expect(checkPageUrlValue({ exact: "https://www.topcv.vn/api" }, ALLOW).allow).toBe(true);
    expect(checkPageUrlValue({ exact: "https://evil.example/x" }, ALLOW).allow).toBe(false);
    expect(checkPageUrlValue({ exact: "//evil.example/x" }, ALLOW).allow).toBe(false);
    expect(checkPageUrlValue({ exact: "/\\evil.example/x" }, ALLOW).allow).toBe(false);
    expect(checkPageUrlValue({ exact: "javascript:alert(1)" }, ALLOW).allow).toBe(false);
    expect(checkPageUrlValue({ exact: "data:text/plain,hi" }, ALLOW).allow).toBe(false);
  });

  it("decides from a known prefix only when the prefix fixes the origin", () => {
    const ok = ["/api/jobs?page=", "?q=", "#", "./", "https://topcv.vn/", "https://topcv.vn?", "//topcv.vn/x", "jobs/"];
    for (const prefix of ok) expect(checkPageUrlValue({ prefix }, ALLOW).allow, prefix).toBe(true);
    const bad = ["", "/", "https://topcv.vn", "https://topcv.vn:", "https://to", "jav", "https://evil.example/?d=", "//evil.example/", "javascript:"];
    for (const prefix of bad) expect(checkPageUrlValue({ prefix }, ALLOW).allow, prefix).toBe(false);
  });

  it("blocks values it cannot know", () => {
    const decision = checkPageUrlValue(null, ALLOW);
    expect(decision).toMatchObject({ allow: false, rule: "js_unverifiable_url" });
  });
});
