---
name: source-topcv
description: How Research scans TopCV (topcv.vn) read-only for a research.scan task — search URLs from the search profile, where each field sits on listing and job pages, limits, and what to report when the page is blocked or its layout changed.
---

# TopCV (topcv.vn)

Read-only. Never click "Ứng tuyển", "Lưu tin", log in or fill anything. Selectors below are **hints observed 2026-10** (tested in `apps/orchestrator/src/adapters/parsers/topcv.ts`); the visible labels matter more than class names.

## 1. Limits for this scan
- **Job limit:** at most `3 × criteria.maxJobs` postings, never more than 30 (the fit step keeps the best `maxJobs`). Stop opening postings when you reach it.
- **Searches:** one per role × location, at most 6. **Pages:** at most 3 result pages per search.
- Skip a card at once if its title or company matches `excludeKeywords` / `excludeCompanies`; do not open it.

## 2. Search URL
`https://www.topcv.vn/tim-viec-lam-<role-slug>-tai-<city>`, role slug = role in lowercase ASCII with dashes (`Frontend Engineer` → `frontend-engineer`).

| Location | `<city>` |
|---|---|
| Hồ Chí Minh / HCM / Sài Gòn | `ho-chi-minh-kl2` |
| Hà Nội | `ha-noi-kl1` |
| Đà Nẵng | `da-nang-kl8` |
| Remote or anything else | leave out `-tai-…`: `https://www.topcv.vn/tim-viec-lam-<role-slug>` |

TopCV may redirect to a category URL (e.g. `/tim-viec-lam-software-engineering-cr257cb258`); that is fine. Next page: the pager under the list (`?page=2`). Salary and work mode are filtered by you while reading, not in the URL.

## 3. Listing page
- The tab title states the count: "Tuyển dụng **14** việc làm …". "0 việc làm" or "Không tìm thấy" = no results.
- **`get_page_text` often returns only a feedback widget here (spike S2).** Then use `find` ("job title links in the search results") or `read_page` and read the cards.
- Each card (`.job-item-search-result`, `data-job-id`): title link (`h3.title a`, href `/viec-lam/<slug>/<id>.html`), company (`a.company .company-name`), salary (`.label-content .salary`: "20 - 30 triệu", "Tới 30 triệu", "Thoả thuận"), location (`.address`: "Hồ Chí Minh"), posted label (`.label-update`: "Đăng 3 ngày trước").
- Cards marked as ads/highlight are normal postings; read them like the others.

## 4. Job page (open each matching posting)
- Title: the `h1` (`.box-header-job__title`). Company: the company box (`.company-name-label`). Salary: header `.box-header-job__salary`.
- Location: header item "Địa điểm" (e.g. "Hồ Chí Minh"). Work mode is usually only in the JD text ("Làm việc từ xa", "Hybrid"); leave it null if not stated.
- **Posting date:** the page shows only "Hạn ứng tuyển" (the deadline) — that is **not** `postedAt`. Use the listing card's "Đăng … trước" label; if neither exists, null.
- **Full JD** = the sections "Mô tả công việc", "Yêu cầu ứng viên", "Quyền lợi" (and "Địa điểm và thời gian làm việc", "Cách thức ứng tuyển" if present), in page order, with their headings (each is a `.box-job-information-detail-item` block). Do not include "Việc làm liên quan" or "Thông tin chung". If `get_page_text` is short, use `read_page` on the main column.

## 5. Writing the JobCandidate
- `url`: the posting URL without its query (`?ta_source=…&u_sr_id=…`): `https://www.topcv.vn/viec-lam/<slug>/<id>.html`.
- `salaryText`: as shown ("15 - 25 triệu", "Thoả thuận"); null if the page shows none.
- `postedAt`: "Đăng N ngày/tuần trước" → today minus that, ISO with +07:00. Unknown → null.
- `language`: usually `vi`. Same job twice (same `<id>`) → keep one.

## 6. Blocked
A login popup that hides the page, or a CAPTCHA / "Verify you are human" page → stop, set `blocked` (`needs_login` or `captcha`, site `topcv.vn`) and return what you have. Never log in. The "Ứng tuyển" login popup is not a block: you never click it.

## 7. Layout changed
If the page no longer matches this skill (the count says N jobs but there are no cards, or a job page has no JD sections), stop reading TopCV and put this note on the **first** self-check item (keep it `passed: true` when it is true for what you return): `Layout changed: <what is missing> on <page URL>`. The orchestrator then reports "TopCV adapter broken". Do not guess fields.

## 8. No results
An empty list is valid. Say so on the first self-check item: `No results: the page says 0 jobs` (or the text it shows).
