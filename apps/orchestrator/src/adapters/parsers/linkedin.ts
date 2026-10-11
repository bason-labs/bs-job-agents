// LinkedIn guest pages (linkedin.com/jobs/search, /jobs/view), read without signing in. Selectors
// observed 2026-10 on the real pages in ../fixtures/linkedin-*.html.
import { all, attrOf, blockText, pageTitle, textOf, type DomRoot } from "./dom.js";
import { countFrom, type RawCard, type RawJob, type SourceParser } from "./types.js";

export const linkedinParser: SourceParser = {
  cardSelector: ".base-search-card",
  jdSelector: ".show-more-less-html__markup",

  resultCount(root) {
    // <title>81 Frontend Engineer jobs in Quận 3</title>, or the results header.
    return countFrom(textOf(root, ".results-context-header__job-count"), /(\d[\d.,]*)/) ?? countFrom(pageTitle(root), /^(\d[\d.,]*)\+?\s+.*\bjobs?\b/i);
  },

  cards(root) {
    return all(root, this.cardSelector).map((card): RawCard => ({
      href: attrOf(card, "a.base-card__full-link", "href"),
      title: textOf(card, ".base-search-card__title"),
      company: textOf(card, ".base-search-card__subtitle a") ?? textOf(card, ".base-search-card__subtitle"),
      location: textOf(card, ".job-search-card__location"),
      salaryText: textOf(card, ".job-search-card__salary-info"),
      postedText: textOf(card, "time"),
      postedDate: attrOf(card, "time", "datetime"),
      workModeText: null,
    }));
  },

  job(root: DomRoot): RawJob {
    const jd = root.querySelector(this.jdSelector);
    return {
      title: textOf(root, "h1.top-card-layout__title") ?? textOf(root, "h1"),
      company: textOf(root, ".topcard__org-name-link") ?? textOf(root, ".topcard__flavor"),
      location: textOf(root, ".topcard__flavor--bullet:not(.num-applicants__caption)"),
      salaryText: textOf(root, ".compensation__salary"),
      postedText: textOf(root, ".posted-time-ago__text"),
      postedDate: null,
      workModeText: null,
      jdText: jd ? blockText(jd) || null : null,
      canonicalHref: attrOf(root, 'link[rel="canonical"]', "href"),
    };
  },
};
