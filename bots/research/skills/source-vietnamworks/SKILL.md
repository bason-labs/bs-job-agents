---
name: source-vietnamworks
description: How Research scans VietnamWorks read-only for a research.scan task — the search URL from the search profile, waiting for the cards to render, where each field sits on a posting, the limits, and when to stop (login wall, CAPTCHA, layout change).
---

# VietnamWorks (vietnamworks.com)

Read-only. Never sign in, apply ("Nộp đơn"), save a job, follow a company or fill in any form. Hints **observed 2026-10** on the real pages (tested in `apps/orchestrator/src/adapters/parsers/vietnamworks.ts`). VietnamWorks renders its pages in the browser: give each page a moment to fill before you read it.

## 1. Limits
- **Job limit:** at most `3 × criteria.maxJobs` postings, never more than 30 (the task's `candidateLimit`).
- **Searches:** one per role × location, at most 6; **at most 2 result pages** per search.
- A short pause (1–3 s) between postings is enough; open postings one at a time in your own tab.

## 2. Search URL
`https://www.vietnamworks.com/viec-lam?q=<role-slug>&l=<city id>`
- `<role-slug>`: the role in lowercase with hyphens, without any "(…)" part ("Frontend Developer (React)" → `frontend-developer`).
- `<city id>`: Hồ Chí Minh `29`, Hà Nội `24`, Đà Nẵng `17` (the site's own `/viec-lam-ho-chi-minh-v29-vn` links). For "Remote" or no city, leave `l` out.
- Next page: `&page=2`.

## 3. Listing page
- Tab title states the count: "Tuyển dụng **6** việc làm frontend developer tại Hồ Chí Minh …".
- The cards appear after the page renders (before that there are only grey `.job-item-placeholder` boxes): wait, then read again. Each card's title links to the posting, whose URL ends in `-<id>-jv` (`a[href$="-jv"]`, often with `?source=searchResults…`). Company, salary ("Thương lượng" = negotiable) and city sit under the title.
- Pick the cards that match the criteria before opening them.

## 4. Job page (`https://www.vietnamworks.com/<slug>-<id>-jv`)
- Title (`h1`), company, salary as shown ("Thương lượng", "$1,000 - $2,000", "15 - 25 triệu"), working address, the posting age ("Đăng 27 ngày trước") and the deadline ("Hết hạn …": not the posting date).
- **Full JD:** the sections "Mô tả công việc" (jobDescription) and "Yêu cầu công việc" (jobRequirement); include both, and "Các phúc lợi dành cho bạn" when shown. Click "Xem thêm" only when the text is visibly cut off.
- JDs are often in Vietnamese: set `language` to `vi` then.

## 5. Writing the JobCandidate
- `url`: `https://www.vietnamworks.com/<slug>-<id>-jv` (drop everything after `?`).
- `postedAt`: from "Đăng N ngày trước" → today minus N (ISO, +07:00); null when not shown.
- `salaryText`: as shown; "Thương lượng" is fine. `workMode` only when the page says it (e.g. "Remote", "Làm việc từ xa").

## 6. Stop at once (blocked)
- A login page or wall ("Đăng nhập", `/dang-nhap`, `/login`) → `blocked: { reason: "needs_login", site: "vietnamworks.com" }`.
- A CAPTCHA / bot check → `blocked: { reason: "captcha", site: "vietnamworks.com" }`.
Return the jobs already read and close your tab.

## 7. Layout changed
The title says N jobs but no `-jv` links appear after the page rendered, or a posting without its "Mô tả công việc" text → stop and note on the first self-check item: `Layout changed: <what is missing> on <page URL>`.

## 8. No results
Return an empty list with the note `No results: the page says 0 jobs` on the first self-check item.
