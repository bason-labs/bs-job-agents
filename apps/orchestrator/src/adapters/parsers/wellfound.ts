// Wellfound (wellfound.com), observed 2026-10-11 on the real pages in ../fixtures/wellfound-*.html.
// The role pages (/role/r/<role> = remote, /role/l/<role>/<place>) list company cards, each with
// one row per job: the title links to /jobs/<id>-<slug>; small text spans give the salary
// ("$80k – $105k • 0.25% – 0.75%") and the place ("Remote only • Everywhere", "Onsite or remote •
// Chattanooga"); the age is "1 week ago". The job page embeds a schema.org JobPosting and shows the
// JD in #job-description. Applying needs Ba's Wellfound login (the skill pauses as needs_login).
import { cleanText } from "../text.js";
import { all, attrOf, blockText, jobPostingLd, textOf, type DomRoot } from "./dom.js";
import { countFrom, type RawCard, type RawJob, type SourceParser } from "./types.js";

const MONEY = /[$€£₹]|\bequity\b|\d+(\.\d+)?%/i;
const PLACE = /\b(remote|onsite|on-site|in office|hybrid)\b/i;

export const wellfoundParser: SourceParser = {
  cardSelector: "div.mb-4.w-full.px-4 > div",
  jdSelector: "#job-description",

  resultCount(root) {
    const h4 = all(root, "h4").map((e) => cleanText(e.textContent)).find((t) => /results? total/i.test(t));
    return countFrom(h4, /^(\d[\d.,]*)\s+results?/i);
  },

  cards(root) {
    const cards: RawCard[] = [];
    // Company cards hold the company name and one row per job.
    for (const company of all(root, "div.mb-6.rounded")) {
      const name = textOf(company, '[data-testid="startup-header"] h2');
      for (const row of all(company, this.cardSelector)) {
        const spans = all(row, "span.pl-1.text-xs").map((s) => cleanText(s.textContent));
        const place = spans.find((t) => PLACE.test(t) && !MONEY.test(t)) ?? null;
        cards.push({
          href: attrOf(row, 'a[href^="/jobs/"]', "href"),
          title: textOf(row, 'a[href^="/jobs/"]'),
          company: name,
          location: place ? place.replace(/\s*\+\s*\d+$/, "") : null,
          salaryText: spans.find((t) => MONEY.test(t)) ?? null,
          postedText: textOf(row, "span.lowercase"),
          postedDate: null,
          workModeText: place,
        });
      }
    }
    return cards;
  },

  job(root: DomRoot): RawJob {
    const ld = jobPostingLd(root);
    const content = root.querySelector(this.jdSelector);
    const place = all(root, "h1 ~ ul li").map((li) => cleanText(li.textContent)).find((t) => PLACE.test(t)) ?? null;
    const posted = all(root, "div").map((d) => cleanText(d.textContent)).find((t) => /^Posted:\s/.test(t)) ?? null;
    return {
      title: textOf(root, "h1") ?? ld?.title ?? null,
      company: ld?.company ?? null,
      location: place ?? ld?.region ?? null,
      salaryText: ld?.salaryText ?? null,
      postedText: posted ? posted.replace(/^Posted:\s*/, "") : null,
      postedDate: ld?.datePosted ?? null,
      workModeText: place,
      jdText: content ? blockText(content) || null : (ld?.description ?? null),
      canonicalHref: attrOf(root, 'link[rel="canonical"]', "href"),
    };
  },
};
