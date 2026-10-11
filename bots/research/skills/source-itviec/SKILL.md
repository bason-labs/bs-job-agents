---
name: source-itviec
description: How Research scans ITviec (itviec.com) read-only for a research.scan task — search URLs from the search profile, where each field sits on listing and job pages, limits, and what to report when the page is blocked or its layout changed.
---

# ITviec (itviec.com)

Read-only. Never click "Apply now", "Sign in to view salary" or "Save", and never sign in. Selectors below are **hints observed 2026-10** (tested in `apps/orchestrator/src/adapters/parsers/itviec.ts`).

## 1. Limits for this scan
- **Job limit:** at most `3 × criteria.maxJobs` postings, never more than 30. Stop when you reach it.
- **Searches:** one per role × location, at most 6. **Pages:** at most 3 result pages per search (20 cards each).
- Skip cards whose title or company matches `excludeKeywords` / `excludeCompanies` without opening them.

## 2. Search URL
`https://itviec.com/it-jobs/<role-slug>/<city>`, role slug = lowercase ASCII with dashes (`React Developer` → `react-developer`; a skill such as `reactjs` works too).

| Location | `<city>` |
|---|---|
| Hồ Chí Minh | `ho-chi-minh-hcm` |
| Hà Nội | `ha-noi` |
| Đà Nẵng | `da-nang` |
| Remote or anything else | leave it out: `https://itviec.com/it-jobs/<role-slug>` |

Next page: `?page=2`.

## 3. Listing page
- The heading states the count: "**35** reactjs jobs in Ho Chi Minh". A "no jobs found" message = no results.
- Each card (`.job-card`): "Posted 10 days ago", title link (`h3 a`, href `/it-jobs/<slug>-<number>`), company (link to `/companies/…`), salary ("Sign in to view salary" for guests), work mode ("At office" / "Hybrid" / "Remote"), city ("Ho Chi Minh", "Ho Chi Minh - Ha Noi"), skill tags.
- The right-hand preview panel is not a separate page; open the posting itself to get the full JD.

## 4. Job page
- Title: `h1`. Company: `.employer-name`. Under the header: address ("261 Hoang Van Thu st, Ho Chi Minh"), work mode ("Hybrid"), "Posted 10 days ago".
- **Full JD** = the content block (`.job-content`): "Top 3 reasons to join us", "Job description", "Your skills and experience", "Why you'll love working here", with headings. Stop before "More jobs for you".
- If `get_page_text` returns little, use `read_page` / `find` ("the job description section").

## 5. Writing the JobCandidate
- `url`: `https://itviec.com/it-jobs/<slug>-<number>` without `?lab_feature=…` and without `/content`.
- `salaryText`: **null** when it says "Sign in to view salary" (never sign in to see it).
- `workMode`: At office → `onsite`, Hybrid → `hybrid`, Remote → `remote`.
- `postedAt`: "Posted N days ago" → today minus N days (ISO, +07:00). `language`: usually `en`; detect from the JD.

## 6. Blocked
A sign-in page instead of the posting, or a CAPTCHA / Cloudflare check → stop, set `blocked` (`needs_login` / `captcha`, site `itviec.com`), return what you have.

## 7. Layout changed
Count says N jobs but no cards, or a job page without the JD block → stop and note on the first self-check item: `Layout changed: <what is missing> on <page URL>`. The orchestrator reports "ITviec adapter broken". Never guess fields.

## 8. No results
Return an empty list and note on the first self-check item: `No results: the page says 0 jobs`.
