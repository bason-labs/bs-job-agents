// A company's own career site. There is no single layout, so this tries the common job-board
// platforms first (Greenhouse, Lever, Workable — observed 2026-10, fixture: a Greenhouse board), then
// the page's schema.org JobPosting, then generic headings and description blocks.
import { all, attrOf, blockText, jobPostingLd, textOf, type DomElement, type DomRoot } from "./dom.js";
import type { RawCard, RawJob, SourceParser } from "./types.js";

const CARD = "tr.job-post, .posting, li.whr-item, [data-ui='job'], .job-listing, .opening";
const JD = ".job__description, #content .content-intro, .posting-page .section-wrapper, [data-ui='job-description'], .job-description, [class*='description']";

function cardTitle(card: DomElement): string | null {
  return textOf(card, "p.body--medium, h5, .posting-title h5, h3, h4, [data-ui='job-title']") ?? textOf(card, "a");
}

export const careerSiteParser: SourceParser = {
  cardSelector: CARD,
  jdSelector: JD,

  resultCount() {
    return null;
  },

  cards(root) {
    return all(root, CARD).map((card): RawCard => ({
      href: attrOf(card, "a[href]", "href"),
      title: cardTitle(card),
      company: null,
      location: textOf(card, "p.body--metadata, .location, .sort-by-location, [data-ui='job-location']"),
      salaryText: null,
      postedText: null,
      postedDate: null,
      workModeText: textOf(card, ".workplaceTypes, [data-ui='job-workplace']"),
    }));
  },

  job(root: DomRoot): RawJob {
    const ld = jobPostingLd(root);
    const jd = root.querySelector(JD) ?? root.querySelector("main") ?? root.querySelector("article");
    return {
      title: textOf(root, "h1") ?? ld?.title ?? null,
      company: ld?.company ?? null,
      location: textOf(root, ".job__location, .location, .posting-categories .location, [data-ui='job-location']") ?? ld?.region ?? null,
      salaryText: ld?.salaryText ?? null,
      postedText: null,
      postedDate: ld?.datePosted ?? null,
      workModeText: null,
      jdText: (jd ? blockText(jd) : null) || ld?.description || null,
      canonicalHref: attrOf(root, 'link[rel="canonical"]', "href"),
    };
  },
};
