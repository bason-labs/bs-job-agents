// ITviec (itviec.com). Selectors observed 2026-10 on the real pages in ../fixtures/itviec-*.html.
// Salaries are shown only to signed-in users ("Sign in to view salary"): Research never signs in,
// so salaryText stays null.
import { foldText } from "../text.js";
import { all, attrOf, blockText, textOf, type DomRoot } from "./dom.js";
import { countFrom, type RawCard, type RawJob, type SourceParser } from "./types.js";

const WORK_MODE_TEXT = /^(at office|hybrid|remote)$/;

function visibleSalary(root: DomRoot, selector: string): string | null {
  const t = textOf(root, selector);
  return t && !/sign in|dang nhap/.test(foldText(t)) ? t : null;
}

export const itviecParser: SourceParser = {
  cardSelector: ".job-card[data-search--job-selection-job-slug-value]",
  jdSelector: ".job-content",

  resultCount(root) {
    // <h1>35 reactjs jobs in Ho Chi Minh</h1>
    return countFrom(textOf(root, "h1"), /^(\d[\d.,]*)\s+.*\bjobs?\b/i);
  },

  cards(root) {
    return all(root, this.cardSelector).map((card): RawCard => {
      const smalls = all(card, "div.text-rich-grey");
      return {
        href: attrOf(card, "h3 a", "href"),
        title: textOf(card, "h3 a") ?? textOf(card, "h3"),
        company: textOf(card, 'span.small-text a[href*="/companies/"]') ?? attrOf(card, 'a.logo-employer-card', "title"),
        location: smalls.find((d) => d.getAttribute("title"))?.getAttribute("title")?.trim() ?? null,
        salaryText: visibleSalary(card, ".salary"),
        postedText: textOf(card, "span.small-text.text-dark-grey"),
        postedDate: null,
        workModeText: smalls.map((d) => (d.textContent ?? "").trim()).find((t) => WORK_MODE_TEXT.test(foldText(t))) ?? null,
      };
    });
  },

  job(root: DomRoot): RawJob {
    const meta = all(root, ".normal-text.text-rich-grey").map((e) => (e.textContent ?? "").replace(/\s+/g, " ").trim());
    const content = root.querySelector(this.jdSelector);
    return {
      title: textOf(root, "h1"),
      company: textOf(root, ".job-header-info .employer-name") ?? textOf(root, ".employer-name"),
      location: meta.find((t) => !WORK_MODE_TEXT.test(foldText(t)) && !/^posted\b/i.test(t)) ?? null,
      salaryText: visibleSalary(root, ".job-header-info .salary"),
      postedText: meta.find((t) => /^posted\b/i.test(t)) ?? null,
      postedDate: null,
      workModeText: meta.find((t) => WORK_MODE_TEXT.test(foldText(t))) ?? null,
      jdText: content ? blockText(content) || null : null,
      canonicalHref: attrOf(root, 'link[rel="canonical"]', "href"),
    };
  },
};
