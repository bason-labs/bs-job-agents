// The dependency-free HTML parser the LinkedIn reader uses (2026-10-20 addendum): the same answers
// as jsdom for the selectors and helpers the readers need.
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { attrOf, blockText, textOf, type DomRoot } from "./dom.js";
import { decodeEntities, parseHtml } from "./html.js";

const SAMPLE = `<!DOCTYPE html>
<!-- a comment <div class="x">not an element</div> -->
<ul>
  <li><div class="base-card job-card" data-entity-urn="urn:li:jobPosting:1">
    <h3 class="base-search-card__title"> Java &amp; Kotlin Dev </h3>
    <h4 class="base-search-card__subtitle"><a class="hidden-nested-link" href="https://x/?a=1&amp;b=2">ACME</a></h4>
    <span class="topcard__flavor topcard__flavor--bullet">Ho Chi Minh City</span>
    <span class="num-applicants__caption topcard__flavor--bullet">40 applicants</span>
    <time class="job-search-card__listdate" datetime="2026-09-20">4 weeks ago</time>
    <img src="a.png" alt>
  </div>
  <li><p>one<p>two<div>three</div>
</ul>
<script>if (a < b && "</div>") {}</script>
<div class="show-more-less-html__markup"><p><strong>About</strong></p><ul><li>Build&nbsp;APIs</li><li>Ship it</li></ul><button>Show more</button></div>`;

describe("parseHtml", () => {
  const ours = parseHtml(SAMPLE);
  const theirs = new JSDOM(SAMPLE).window.document as unknown as DomRoot;

  it("answers the readers' selectors like jsdom", () => {
    for (const sel of [
      "div.base-card[data-entity-urn]",
      "h3.base-search-card__title",
      "h4.base-search-card__subtitle a.hidden-nested-link",
      "span.topcard__flavor--bullet:not(.num-applicants__caption)",
      "time.job-search-card__listdate, time.job-search-card__listdate--new",
      'div[data-entity-urn^="urn:li:jobPosting:"]',
      "ul > li",
      "li p",
      "div.show-more-less-html__markup",
    ]) {
      expect(ours.querySelectorAll(sel).length, sel).toBe(theirs.querySelectorAll(sel).length);
      expect(textOf(ours, sel), sel).toBe(textOf(theirs, sel));
    }
    expect(attrOf(ours, "time", "datetime")).toBe("2026-09-20");
    expect(attrOf(ours, "a.hidden-nested-link", "href")).toBe("https://x/?a=1&b=2");
  });

  it("blockText reads the JD like it does from jsdom (buttons skipped, list items marked)", () => {
    const sel = "div.show-more-less-html__markup";
    expect(blockText(ours.querySelector(sel)!)).toBe(blockText(theirs.querySelector(sel)!));
    expect(blockText(ours.querySelector(sel)!)).toBe("About\n- Build APIs\n- Ship it");
  });

  it("comments and script text never become elements", () => {
    expect(ours.querySelectorAll("div.x")).toHaveLength(0);
    expect(ours.querySelector("script")!.textContent).toContain('"</div>"');
  });

  it("decodes named and numeric entities", () => {
    expect(decodeEntities("a&amp;b &lt;i&gt; &#39;x&#x27; &nbsp;&unknown;")).toBe("a&b <i> 'x'  &unknown;");
  });

  it("a bad selector throws", () => {
    expect(() => ours.querySelector("div[")).toThrow(/bad selector/);
  });
});
