# W4a source adapters report (Phase 4)

- **Merged.** develop: 2,635 tests (orchestrator 1,771; 131 new adapter tests).
- **Skills** (`bots/research/skills/source-{topcv,itviec,linkedin,career-site}/SKILL.md`):
  - search URLs built from the search profile; field locations on listing and job pages ("observed 2026-10"); fallbacks when `get_page_text` returns little
  - limits: 3 × maxJobs candidates (≤ 30), ≤ 6 searches, 2–3 result pages per search; LinkedIn ≤ 40 page views with 3–8 s pauses
  - fixed notes the checker reacts to: `Layout changed: <what> on <url>` and `No results: the page says 0 jobs`
  - `skills.test.ts` keeps the skills in step with the code
- **Normalisers:** salary (VI/EN formats, Thỏa thuận), location aliases, posted dates (VI/EN relative dates), canonical URLs + `jobIdentityKey`, search URL builders.
- **Parsers:** one per source; `pages.ts` tells broken / blocked (needs_login, captcha) / valid empty apart. jsdom is used in tests only.
- **Checker:**
  - Implausible output is retried.
  - Adapter broken (no retry): a `Layout changed:` note, all titles are page labels, 3+ jobs share one JD, zero jobs twice without "0 results", LinkedIn over the page-view limit or pauses under 3 s.
  - The screenshot is the latest capture, or "not captured".
- **Fixtures:** real trimmed pages (TopCV, ITviec, LinkedIn guest pages, Greenhouse career site), each fetched with one plain GET, no login; synthetic layout-changed and authwall pages, marked as such.
- **Engine needs:**
  - Relayed to F4b: fill `pageVisits`; ROLE.md layout-note conflict; candidate limit wording / explicit limit; skills reachable on both engines.
  - Deferred to the final QA/PM: Research has no screenshot tool (scan screenshots are always "not captured"); a separate "policy violation" outcome for LinkedIn over-limit; `career_site` is not a search source in shared.
