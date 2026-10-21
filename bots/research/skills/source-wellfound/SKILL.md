---
name: source-wellfound
description: How Research scans Wellfound (startup jobs, remote) read-only for a research.scan task with Ba's own login — page-view and delay limits, the remote role search URL, the time-zone and USD salary rules, where each field sits, and when to stop (login wall, CAPTCHA, layout change).
---

# Wellfound (wellfound.com)

Read-only, in Ba's Chrome where he is signed in to Wellfound. Never apply ("Apply", "Apply Now"), save, message a founder, edit his profile or accept any prompt. Hints **observed 2026-10** on the real pages (tested in `apps/orchestrator/src/adapters/parsers/wellfound.ts`).

## 1. Limits (the orchestrator checks them)
- **At most 30 page views per scan** (the task's `maxPageViews`), with **a random pause of 3–8 s between page loads**: it is Ba's own account.
- **Job limit:** at most `3 × criteria.maxJobs` postings, never more than 30 (`candidateLimit`).
- **Searches:** one per role (the city is ignored: Wellfound is a remote board), at most 6; at most 2 result pages each.

## 2. Search URL
`https://wellfound.com/role/r/<role-slug>` — remote jobs for the role. `<role-slug>`: lowercase with hyphens, without any "(…)" part ("Frontend Engineer" → `frontend-engineer`, "Full Stack Engineer" → `full-stack-engineer`).

## 3. Listing page
- The header states the count: "**553** results total".
- One card per company (`[data-testid="startup-header"]` with the company name in `h2`), and in it one row per job (`div.mb-4.w-full.px-4 > div`): the title links to `/jobs/<id>-<slug>`; small text gives the salary ("$80k – $105k • 0.25% – 0.75%") and the place ("Remote only • Everywhere", "Remote • New York City", "In office • …"); the age ("1 week ago").
- Skip "In office" rows. Pick rows that match the criteria before opening any.

## 4. Job page (`https://wellfound.com/jobs/<id>-<slug>`)
- Title `h1`; under it "Remote (Everywhere) • Berlin", years of experience and employment type; "Posted: 2 days ago"; "Hires remotely in …" (where applicants may live).
- **Full JD:** `#job-description` ("About the job"). The page also embeds a JSON-LD JobPosting (title, company, datePosted, description).

## 5. Remote rules (search profile)
- Ignore the city filter. Keep a job only when its "Hires remotely in" region overlaps `criteria.timezoneOverlap` (e.g. "Asia", "UTC+7 ±3h"); "Everywhere", Vietnam or Asia always fit; skip clearly elsewhere ("United States only"). No `timezoneOverlap` → no region filter.
- Salary: with a USD minimum (`criteria.currency` USD), drop a job only when even the top of its range, per month (yearly ÷ 12), is under it; with a VND minimum, do not filter on salary.

## 6. Writing the JobCandidate
- `url`: `https://wellfound.com/jobs/<id>-<slug>` (nothing after `?`).
- `location`: "Remote" plus the place as shown, e.g. "Remote (Everywhere)". `workMode`: `remote` (or `hybrid` for "Onsite or remote").
- `postedAt`: the JobPosting's `datePosted`, else "N days ago" → today minus N. `salaryText`: as shown, else null.

## 7. Stop at once (blocked)
- Signed out (a "Log In" / "Sign up" page, `/login`, or the job page asks to sign in) → `blocked: { reason: "needs_login", site: "wellfound.com" }`: Ba signs in, then the task resumes.
- A CAPTCHA / bot check ("Just a moment…", "Verify you are human") → `blocked: { reason: "captcha", site: "wellfound.com" }`.
Return the jobs already read and close your tab. Never sign in yourself.

## 8. Layout changed
The header says N results but no job rows, or a posting without `#job-description` → stop and note on the first self-check item: `Layout changed: <what is missing> on <page URL>`.

## 9. No results
Return an empty list with the note `No results: the page says 0 jobs` on the first self-check item.
