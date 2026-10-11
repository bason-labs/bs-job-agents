// TopCV (topcv.vn). Selectors observed 2026-10 on the real pages in ../fixtures/topcv-*.html.
import { cleanText, foldText } from "../text.js";
import { all, attrOf, blockText, jobPostingLd, pageTitle, textOf, type DomRoot } from "./dom.js";
import { countFrom, type RawCard, type RawJob, type SourceParser } from "./types.js";

/** JD sections worth keeping (folded titles); "Tổng quan", "Việc làm liên quan", "Thông tin chung" are not the JD. */
const JD_SECTIONS = /^(mo ta|yeu cau|quyen loi|dia diem|thoi gian|cach thuc)/;

export const topcvParser: SourceParser = {
  cardSelector: ".job-item-search-result",
  jdSelector: ".box-job-information-detail-item",

  resultCount(root) {
    // <title>Tuyển dụng 14 việc làm Frontend Developer tại Hồ Chí Minh [Update 11/10/2026]</title>
    return countFrom(pageTitle(root), /(\d[\d.,]*)\s+việc làm/i);
  },

  cards(root) {
    return all(root, this.cardSelector).map((card): RawCard => ({
      href: attrOf(card, "h3.title a", "href"),
      title: textOf(card, "h3.title a span[title]") ?? textOf(card, "h3.title a"),
      company: textOf(card, "a.company .company-name") ?? textOf(card, ".company-name"),
      location: textOf(card, ".label-content .address:not(.label-update)") ?? textOf(card, ".address:not(.label-update)"),
      salaryText: textOf(card, ".label-content .salary") ?? textOf(card, ".title-salary"),
      postedText: textOf(card, ".label-update"),
      postedDate: null,
      workModeText: null,
    }));
  },

  job(root: DomRoot): RawJob {
    const ld = jobPostingLd(root);
    const sections = all(root, this.jdSelector).filter((s) =>
      JD_SECTIONS.test(foldText(s.querySelector(".box-job-information-detail-item__title--title")?.textContent)),
    );
    const jd = sections.map((s) => blockText(s)).join("\n\n");
    // "Địa điểm Hồ Chí Minh" in the header's info list.
    const placeItem = all(root, ".box-header-job-list-info__item").find((i) => foldText(i.textContent).startsWith("dia diem"));
    const place = placeItem ? cleanText(placeItem.querySelector(".list-info__content__desc")?.textContent ?? placeItem.textContent).replace(/^Địa điểm\s*/i, "") : null;
    return {
      title: textOf(root, "h1.box-header-job__title") ?? textOf(root, "h1") ?? ld?.title ?? null,
      company: textOf(root, ".company-name-label a") ?? textOf(root, ".company-name-label") ?? ld?.company ?? null,
      location: place || ld?.region || null,
      salaryText: textOf(root, ".box-header-job__salary") ?? ld?.salaryText ?? null,
      // The page shows only the deadline ("Hạn ứng tuyển"); the posting date is in its JSON-LD.
      postedText: null,
      postedDate: ld?.datePosted ?? null,
      workModeText: null,
      jdText: jd || null,
      canonicalHref: attrOf(root, 'link[rel="canonical"]', "href"),
    };
  },
};
