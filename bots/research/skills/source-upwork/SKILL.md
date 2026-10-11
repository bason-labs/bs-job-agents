---
name: source-upwork
description: How Research lists Upwork jobs read-only and FIND ONLY for a research.scan task with Ba's own login — never a bid, proposal or Connect; page-view and delay limits, the search URL, the time-zone rule, where each field sits, and when to stop (login wall, CAPTCHA, layout change).
---

# Upwork (upwork.com) — find only

Read-only and **find only**. Upwork jobs reach Ba as review cards marked "find only — apply yourself on Upwork"; the app never applies there. So **never** click "Apply now", "Submit a proposal", "Send a proposal", "Buy Connects", "Save job", "Flag as inappropriate", never message a client, never change Ba's profile or settings, never spend or buy Connects. Read in Ba's Chrome, where he is signed in.

The selectors below come from a **synthetic** fixture (Upwork shows a Cloudflare challenge to plain requests, so no page could be captured; the challenge page itself was observed 2026-10-11). Treat them as hints: on the first scan check them against the page and report `Layout changed: …` when they differ (tested in `apps/orchestrator/src/adapters/parsers/upwork.ts`).

## 1. Limits (the orchestrator checks them)
- **At most 30 page views per scan** (the task's `maxPageViews`), with **a random pause of 3–8 s between page loads**: it is Ba's own account.
- **Job limit:** at most `3 × criteria.maxJobs` postings, never more than 30 (`candidateLimit`).
- **Searches:** one per role (the city is ignored: Upwork is remote), at most 6; one result page each.

## 2. Search URL
`https://www.upwork.com/nx/search/jobs/?q=<role>&sort=recency` (URL-encoded role, without any "(…)" part).

## 3. Listing page
- The count: "1,284 jobs found" (`[data-test="jobs-count"]`).
- Cards `article[data-test="JobTile"]`: title link `h2.job-tile-title a` (to `/jobs/<slug>_~<id>/`), "Posted 2 hours ago" (`[data-test="job-pubilshed-date"]`, Upwork's spelling), hourly range or fixed price (`[data-test="job-type-label"]`, `[data-test="is-fixed-price"]`), the client's country (`[data-test="location"]`).

## 4. Job page (`https://www.upwork.com/jobs/~<id>`)
- Title `h1`; "Posted …" (`[data-test="PostedOn"]`); budget (`[data-test="BudgetAmount"]`); the client's country (`[data-test="client-location"]`).
- **Full JD:** `section[data-test="Description"]`. Read it only: the proposal button and the Connects price stay untouched.

## 5. Remote rules (search profile)
- Ignore the city filter. With `criteria.timezoneOverlap` set, skip jobs that name working hours or a region clearly outside it ("US hours only"); keep the rest.
- Salary: hourly or fixed prices are in USD; with a USD minimum, drop a job only when even its top, per month (hourly × 160), is under it; a fixed price is not compared. With a VND minimum, do not filter on salary.

## 6. Writing the JobCandidate
- `url`: `https://www.upwork.com/jobs/~<id>` (the `~` id from the link; nothing after it).
- `company`: Upwork clients are anonymous: `Upwork client (<country>)`, or `Upwork client`. `companyWebsite`: null.
- `location`: "Remote". `workMode`: `remote`. `salaryText`: as shown ("Hourly: $40-$70", "Fixed price $500").
- `postedAt`: "N hours/days ago" → now minus N (ISO).

## 7. Stop at once (blocked)
- Signed out ("Log in to Upwork", `/ab/account-security/login`) → `blocked: { reason: "needs_login", site: "upwork.com" }`: Ba signs in, then the task resumes.
- A Cloudflare challenge ("Challenge - Upwork", "Just a moment…", "Verify you are human") → `blocked: { reason: "captcha", site: "upwork.com" }`.
Return the jobs already read and close your tab. Never sign in or solve a challenge yourself.

## 8. Layout changed
The count says N jobs but no `article[data-test="JobTile"]` cards, or a job page without its description section → stop and note on the first self-check item: `Layout changed: <what is missing> on <page URL>`.

## 9. No results
Return an empty list with the note `No results: the page says 0 jobs` on the first self-check item.
