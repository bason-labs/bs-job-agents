// Upwork (upwork.com): FIND ONLY. Research lists jobs from Ba's signed-in search; the app never
// applies, bids, sends proposals or spends Connects (SEARCH_SOURCES.upwork.canApply = false).
// Upwork answers a plain GET with a Cloudflare challenge (../fixtures/upwork-challenge.html, real),
// so the listing and job fixtures are SYNTHETIC: the data-test hooks below are a starting point that
// Research verifies on its first live scan ("Layout changed: …" when they differ).
// Clients are anonymous on Upwork: the company is "Upwork client (<country>)".
import { cleanText } from "../text.js";
import { all, attrOf, blockText, textOf, type DomRoot } from "./dom.js";
import { countFrom, type RawCard, type RawJob, type SourceParser } from "./types.js";

function client(country: string | null): string {
  return country ? `Upwork client (${country})` : "Upwork client";
}

export const upworkParser: SourceParser = {
  cardSelector: 'article[data-test="JobTile"]',
  jdSelector: 'section[data-test="Description"]',

  resultCount(root) {
    return countFrom(textOf(root, '[data-test="jobs-count"]'), /(\d[\d.,]*)\s+jobs?\b/i);
  },

  cards(root) {
    return all(root, this.cardSelector).map((card): RawCard => {
      const type = textOf(card, '[data-test="job-type-label"]');
      const fixed = textOf(card, '[data-test="is-fixed-price"]');
      return {
        href: attrOf(card, "h2.job-tile-title a, h2 a", "href"),
        title: textOf(card, "h2.job-tile-title a") ?? textOf(card, "h2"),
        company: client(textOf(card, '[data-test="location"]')),
        location: "Remote",
        salaryText: [type, fixed].filter(Boolean).join(" ") || null,
        postedText: cleanText(textOf(card, '[data-test="job-pubilshed-date"]')?.replace(/^Posted\s*/i, "")) || null,
        postedDate: null,
        workModeText: "Remote",
      };
    });
  },

  job(root: DomRoot): RawJob {
    const content = root.querySelector(this.jdSelector);
    const budget = textOf(root, '[data-test="BudgetAmount"]');
    return {
      title: textOf(root, "h1"),
      company: client(textOf(root, '[data-test="client-location"]')),
      location: "Remote",
      salaryText: budget,
      postedText: cleanText(textOf(root, '[data-test="PostedOn"]')?.replace(/^Posted\s*/i, "")) || null,
      postedDate: null,
      workModeText: "Remote",
      jdText: content ? blockText(content) || null : null,
      canonicalHref: attrOf(root, 'link[rel="canonical"]', "href"),
    };
  },
};
