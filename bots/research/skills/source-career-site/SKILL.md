---
name: source-career-site
description: How Research reads a company's own career page read-only (Greenhouse, Lever, Workable or a custom site) — finding the openings list, the job page fields and full JD, limits, and what to report when the page is blocked or unreadable.
---

# Company career site

Read-only. Only the sites the task allows (a guard blocks others; never follow links off them, e.g. to a separate apply portal on another domain). Never fill the application form that is often on the same page. Selectors are **hints observed 2026-10** (fixture: a Greenhouse board; code in `apps/orchestrator/src/adapters/parsers/career-site.ts`).

## 1. Limits
- **Job limit:** at most `3 × criteria.maxJobs` postings, never more than 30. At most 3 listing pages.
- Use `source: "career_site"` for every job.

## 2. Finding the openings
Start from the URL the task gives. Look for "Careers", "Jobs", "Open positions", "Tuyển dụng", "Cơ hội nghề nghiệp". Common platforms:

| Platform | Openings list | One job |
|---|---|---|
| Greenhouse (`job-boards.greenhouse.io/<co>`) | rows `tr.job-post`: title (`p.body--medium`), location (`p.body--metadata`); filter by office with the page's own filter links | `/<co>/jobs/<id>` |
| Lever (`jobs.lever.co/<co>`) | `.posting`: title `h5`, location `.location` | `/<co>/<uuid>` |
| Workable (`apply.workable.com/<co>`) | `[data-ui="job"]` | `/<co>/j/<code>` |
| Custom | the list of links to individual postings | — |

Prefer postings whose location matches the profile (Ho Chi Minh City / Hà Nội / Đà Nẵng / Remote).

## 3. Job page
- Title: `h1`. Location: `.job__location` (Greenhouse), `.location` (Lever), or the line under the title.
- **Full JD:** the description block (`.job__description`, `[data-ui="job-description"]`, or the main article), with headings and bullets. Stop before the application form ("Apply for this job", "First Name*").
- Company: the career site's company name. `companyWebsite`: the company's main site if linked.
- Posting date and salary: only if the page states them; otherwise null.

## 4. Writing the JobCandidate
- `url`: the posting URL without tracking parameters (`utm_*`, `gh_src`, `source`, `ref`, `lever-source`) and without `#…`.
- `language`: detect from the JD (`vi` or `en`).

## 5. Blocked / layout changed / no results
- Login wall or CAPTCHA → `blocked` with the site's host, return what you have.
- The page has no recognisable openings list or job description → note on the first self-check item: `Layout changed: <what is missing> on <page URL>`.
- No openings → empty list, note `No results: the page says 0 jobs`.
