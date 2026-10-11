// PM2 M2: one public-host rule for every allowlist and approval domain (§10.2 rules 2 and 7).
import { describe, expect, it } from "vitest";
import { ResearchSingleInputSchema } from "../bots/inputs.js";
import { BotDefinitionSchema } from "../bots/definition.js";
import { botDefinitionFixtures } from "../fixtures/bot-definitions.js";
import { ApplyToLinkParamsSchema } from "../workflow/params.js";
import { isPublicHost, normalizeHostName, publicHostProblem } from "./host.js";
import { DomainSchema, PublicUrlSchema } from "./primitives.js";

/** The PM's list, plus other ways to reach Ba's own machine or LAN. */
const REFUSED = [
  "com",
  "vn",
  "com.vn",
  "github.io",
  "127.0.0.1",
  "192.168.1.1",
  "localhost",
  "10.0.0.8",
  "169.254.169.254",
  "printer.local",
  "router.lan",
  "nas.home.arpa",
  "app.internal",
  "foo.test",
  "intranet",
  "co.uk",
  "s3.amazonaws.com",
  "2130706433",
  "0x7f.0.0.1",
  "[::1]",
  "::1",
  "",
  "a..b.com",
  "-bad.com",
  "bad-.com",
  `${"a".repeat(64)}.com`,
  "topcv.vn/jobs",
  "user@topcv.vn",
  // Public names that resolve to Ba's machine or LAN (wildcard IP DNS, router admin pages).
  "127.0.0.1.nip.io",
  "192.168.1.1.nip.io",
  "1-1-1-1.sslip.io",
  "localtest.me",
  "app.lvh.me",
  "fritz.box",
  "router.asus.com",
  "routerlogin.net",
];
const ACCEPTED = ["topcv.vn", "itviec.com", "acme.wd3.myworkdayjobs.com", "novapay.breezy.hr", "linkedin.com", "figma.com", "bbc.co.uk", "ba.github.io", "jobs.lever.co"];

describe("public host rule (PM2 M2)", () => {
  it.each(REFUSED)("refuses %j", (host) => {
    expect(isPublicHost(host)).toBe(false);
    expect(publicHostProblem(host)).toEqual(expect.any(String));
    expect(DomainSchema.safeParse(host).success).toBe(false);
  });

  it.each(ACCEPTED)("accepts %s", (host) => {
    expect(publicHostProblem(host)).toBeNull();
    expect(isPublicHost(host)).toBe(true);
    expect(DomainSchema.safeParse(host).success).toBe(true);
  });

  it("says why, so Ba sees a reason and not just a refusal", () => {
    expect(publicHostProblem("com.vn")).toMatch(/public suffix/);
    expect(publicHostProblem("github.io")).toMatch(/public suffix/);
    expect(publicHostProblem("192.168.1.1")).toMatch(/IP address/);
    expect(publicHostProblem("localhost")).toMatch(/local/);
    expect(publicHostProblem("router.lan")).toMatch(/local|not a public/);
  });

  it("compares lowercase without a trailing dot", () => {
    expect(normalizeHostName("  NovaPay.Breezy.HR. ")).toBe("novapay.breezy.hr");
    expect(isPublicHost("TopCV.VN")).toBe(true);
    expect(isPublicHost("COM.VN")).toBe(false);
  });

  it("URLs that lead a bot to a page: only public http(s) sites", () => {
    for (const url of ["http://192.168.1.1/admin", "http://localhost:3000/", "https://github.io/x", "http://[::1]/", "http://2130706433/", "https://com.vn/", "http://router.lan/"]) {
      expect(PublicUrlSchema.safeParse(url).success, url).toBe(false);
      expect(ApplyToLinkParamsSchema.safeParse({ url }).success, url).toBe(false);
      expect(ResearchSingleInputSchema.safeParse({ url }).success, url).toBe(false);
    }
    expect(PublicUrlSchema.safeParse("https://itviec.com/it-jobs/frontend-9").success).toBe(true);
    expect(PublicUrlSchema.safeParse("ftp://itviec.com/x").success).toBe(false);
  });

  it("bot.json allowedSites follow the rule too; the shipped definitions pass", () => {
    const research = botDefinitionFixtures.find((d) => d.name === "research")!;
    expect(BotDefinitionSchema.safeParse(research).success).toBe(true);
    expect(BotDefinitionSchema.safeParse({ ...research, browser: { mode: "read", allowedSites: ["topcv.vn", "vn"] } }).success).toBe(false);
  });
});
