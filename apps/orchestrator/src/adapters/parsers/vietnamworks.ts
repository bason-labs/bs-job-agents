// VietnamWorks (vietnamworks.com), observed 2026-10-11 on the real pages in ../fixtures/vietnamworks-*.
// Both pages render in the browser (Next.js): a plain GET has no job cards and no JD text.
// - Listing: the result count is in <title> ("Tuyển dụng 6 việc làm frontend developer tại Hồ Chí
//   Minh …"); once rendered, each card's title links to the posting, whose URL ends in "-<id>-jv".
//   Before the cards render, the page has empty .job-item-placeholder boxes only.
// - Job page: the job's data is embedded in the page's flight chunks (self.__next_f.push): jobTitle,
//   companyName, prettySalary, approvedOn (posting date), address, jobDescription, jobRequirement.
//   Research reads the same fields off the rendered page ("Mô tả công việc", "Yêu cầu công việc").
import { cleanText } from "../text.js";
import { all, attrOf, htmlToText, pageTitle, type DomRoot } from "./dom.js";
import { countFrom, type RawCard, type RawJob, type SourceParser } from "./types.js";

/** The page's flight data: every self.__next_f.push([1, "…"]) string, joined. */
function flightText(root: DomRoot): string {
  let out = "";
  for (const s of all(root, "script")) {
    const m = /self\.__next_f\.push\((\[[\s\S]*\])\)\s*;?\s*$/.exec((s.textContent ?? "").trim());
    if (!m) continue;
    try {
      const chunk = JSON.parse(m[1]!) as unknown[];
      if (typeof chunk[1] === "string") out += chunk[1];
    } catch {
      // not a data chunk
    }
  }
  return out;
}

/** A field's string value in the flight data; "$29"-style references resolve to their text chunk. */
function field(flight: string, name: string): string | null {
  const m = new RegExp(`"${name}":"((?:[^"\\\\]|\\\\.)*)"`).exec(flight);
  if (!m) return null;
  let value: string;
  try {
    value = JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return null;
  }
  const ref = /^\$([0-9a-f]+)$/.exec(value);
  if (!ref) return value;
  // "<id>:T<hex byte length>,<text>" — the length counts UTF-8 bytes.
  // A text row starts a line or a chunk: "29:T787,<text>".
  const head = new RegExp(`(?<![0-9a-f])${ref[1]}:T([0-9a-f]+),`).exec(flight);
  if (!head) return null;
  const start = head.index + head[0].length;
  return Buffer.from(flight.slice(start), "utf8").subarray(0, parseInt(head[1]!, 16)).toString("utf8");
}

export const vietnamworksParser: SourceParser = {
  cardSelector: 'a[href$="-jv"]',
  jdSelector: "jobDescription",

  resultCount(root) {
    return countFrom(pageTitle(root), /(\d[\d.,]*)\s+vi[eệ]c l[aà]m/i);
  },

  cards(root) {
    const seen = new Set<string>();
    const cards: RawCard[] = [];
    for (const a of all(root, 'a[href$="-jv"], a[href*="-jv?"]')) {
      const href = a.getAttribute("href");
      const title = cleanText(a.textContent);
      if (!href || !title || seen.has(href.split("?")[0]!)) continue;
      seen.add(href.split("?")[0]!);
      cards.push({ href, title, company: null, location: null, salaryText: null, postedText: null, postedDate: null, workModeText: null });
    }
    return cards;
  },

  job(root): RawJob {
    const flight = flightText(root);
    const description = field(flight, "jobDescription");
    const requirement = field(flight, "jobRequirement");
    const parts = [
      description ? `Mô tả công việc\n${htmlToText(description)}` : "",
      requirement ? `Yêu cầu công việc\n${htmlToText(requirement)}` : "",
    ].filter(Boolean);
    const salary = field(flight, "prettySalary");
    return {
      title: field(flight, "jobTitle"),
      company: field(flight, "companyName"),
      location: field(flight, "address"),
      salaryText: salary ? cleanText(salary) : null,
      postedText: field(flight, "approvedOnText"),
      postedDate: field(flight, "approvedOn"),
      workModeText: null,
      jdText: parts.length > 0 ? parts.join("\n") : null,
      canonicalHref: attrOf(root, 'link[rel="canonical"]', "href"),
    };
  },
};
