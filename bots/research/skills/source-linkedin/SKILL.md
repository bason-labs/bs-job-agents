---
name: source-linkedin
description: How Research scans LinkedIn jobs read-only for a research.scan task — strict page-view and delay limits, the public job search URL from the search profile, where each field sits, and when to stop (login wall, CAPTCHA, layout change).
---

# LinkedIn (linkedin.com/jobs)

Read-only, and the strictest source (UC-03 c). Never connect, follow, message, save, "Easy Apply", sign in or accept a sign-up prompt. Selectors are **hints observed 2026-10** on the public (guest) pages (tested in `apps/orchestrator/src/adapters/parsers/linkedin.ts`).

## 1. Hard limits (the orchestrator checks them)
- **At most 40 page views per scan** (or the task's lower `maxPageViews`). Every `navigate` counts, listing pages included. Report the true number in `pageViews`. Over the limit, the whole scan is thrown away as a failure.
- **A random pause of 3–8 s between page loads**, every time (vary it; never under 3 s).
- **Job limit:** at most `3 × criteria.maxJobs` postings, never more than 30 — and stop earlier if the page budget runs out (reserve 1 view per search page).
- **Searches:** one per role × location, at most 6; **at most 2 result pages** per search.

## 2. Search URL
`https://www.linkedin.com/jobs/search?keywords=<role>&location=<city>, Vietnam&f_TPR=r604800` (URL-encoded; `f_TPR=r604800` = past week).
- `<city>`: "Ho Chi Minh City", "Hanoi", "Da Nang"; for Remote use `location=Vietnam`.
- Work modes, only when the profile does not want all three: `&f_WT=` with 1 = on-site, 2 = remote, 3 = hybrid (comma-separated, e.g. `f_WT=2,3`).
- Next page: `&start=25`.

## 3. Listing page
- Tab title states the count: "**81** Frontend Engineer jobs in …".
- Cards (`ul.jobs-search__results-list > li`, `.base-search-card`): title (`.base-search-card__title`), company (`.base-search-card__subtitle`), location (`.job-search-card__location`), posted (`<time datetime="2026-10-05">5 days ago</time>`), salary (`.job-search-card__salary-info`, rarely shown), link to `/jobs/view/<slug>-<id>`.
- Pick the cards that match the criteria **before** opening any, so the 40 views go to likely fits.

## 4. Job page
- Title `h1`, company `.topcard__org-name-link`, location `.topcard__flavor--bullet` ("Ho Chi Minh City, Vietnam"), posted `.posted-time-ago__text`.
- **Full JD:** the "description" block (`.show-more-less-html__markup`). The guest page includes the whole text even when it shows "Show more"; do not click it unless the text is visibly cut off. Seniority / employment type are in the criteria list below it.
- Work mode often only appears in the title or JD ("Remote", "Hybrid"); otherwise null.

## 5. Writing the JobCandidate
- `url`: `https://www.linkedin.com/jobs/view/<id>/` (the number at the end of the posting link; drop `vn.` and every `?position=…&refId=…&trackingId=…`).
- `postedAt`: the `datetime` of the card's `<time>`, else "N days ago" → today minus N (ISO, +07:00).
- `salaryText`: only if shown; else null. The same `<id>` twice → keep one.

## 6. Stop at once (blocked)
- A login wall ("Sign in", "Join LinkedIn to see more jobs", `/authwall`, `/login`, `/checkpoint`) → `blocked: { reason: "needs_login", site: "linkedin.com" }`.
- A CAPTCHA or "security verification" → `blocked: { reason: "captcha", site: "linkedin.com" }`.
Return the jobs already read, close your tab. Never try to sign in or solve it.

## 7. Layout changed
The count says N jobs but no cards, or a posting without its description block → stop and note on the first self-check item: `Layout changed: <what is missing> on <page URL>`. The orchestrator reports "LinkedIn adapter broken".

## 8. No results
Return an empty list with the note `No results: the page says 0 jobs` on the first self-check item.
