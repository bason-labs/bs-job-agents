# CV guidance: multi-source recruiter rules and an automatic review of every tailored CV

- **Date:** 2026-10-19
- **Status:** Draft, awaiting owner review
- **Owner:** Ba Huynh
- **Scope:** sub-project 3 of 4 from the request in `.vtc/runs/r20261018-074219/request.md`. It builds on sub-project 1 (API research: the shared HTTP layer in `apps/orchestrator/src/adapters/http/`) and sub-project 2 (CV auto-extend: the shared truth module `packages/shared/src/truth/` and derived facts). Skill self-repair comes after it.
- **Reference material (reused, not driven):** the approved VTC spec `.vtc/spec/spec.md` (goal G4: REQ-29 to REQ-40), AD-10 to AD-13 in `.vtc/architecture/spine.md`, SEC-17.AC-3 and SEC-20 to SEC-26 in `.vtc/architecture/threat-model/threat-model.md`, and the designs `.vtc/design/screens/{guidance,review,activity,scan-notices}.md`, components `guidance-rule`, `rule-status-badge`, `review-guidance-panel`, `language-tabs`, `fact-request-card`, `guidance-refresh-banner`, `activity-entry`, prototypes `.vtc/design/prototype/{guidance,review,activity}/`. The VNPT recruiter post (`.vtc/state/attachments/r20261018-074219/1-2.png`) was read for this document. This work is done directly, not through the VTC engine. Where this document and those files disagree, this document wins. The differences are listed in §9.

---

## 1. Intent

### 1.1 Why
Ba's tailored CVs follow the CV bot's layout rules and QA's truth check, but no recruiter advice. A VNPT recruiter post lists what makes IT CVs get answers: month and year on every date, the most relevant experience first, "what you did, with which technology, with what result", contact details, links, JD-relevant skills, no technology without practice, and 1 to 2 pages. That is one recruiter's opinion. Ba wants advice from **several** HR sources, with each rule traceable to where it came from, **refreshed on every run** so the CVs keep up as recruiting changes. He wants every tailored CV **reviewed and improved against it automatically**, per job. Anything the CV cannot do truthfully, such as a missing month or a missing result figure, should come back to him as a fact request.

### 1.2 What success looks like
1. The rule set holds the 8 VNPT points plus rules from at least 2 other real, fetched recruiter or HR sources. Every rule names its sources (title, URL or file, retrieval date).
2. Every job-scan run checks its sources before the first CV is tailored. When nothing changed, this costs only HTTP requests and **no LLM call**.
3. Every tailored CV, in each language, gets a review result for every rule, and is revised within the existing 3 rounds when facts can fix a rule.
4. No guidance rule ever puts a number, month, year, skill, title or employer on a CV that Ba's facts lack. Code enforces this before QA, and QA's `invented_claim` stays the second check.
5. At the review step Ba sees only what needs him: rules not met, facts needed (with the question), or disputes. Otherwise he sees "All CV guidance rules met".
6. QA is unchanged: same schema, prompt, scores, threshold of 80 and hard fails, including `over_one_page`.

## 2. Goals, non-goals, anti-goals

### Goals
- **G1. Sourced rule set.** An append-only series of rule-set snapshots in SQLite. Every position of every rule cites at least one source, and every source was fetched by the orchestrator or is a file in the repo. (REQ-29, REQ-30, REQ-31, AD-10, SEC-23.)
- **G2. Disputes are visible and settled by code.** Different advice on one point is kept as separate positions with their sources. A pure function decides which applies. (REQ-32, REQ-33, REQ-34, AD-11.)
- **G3. Refresh every run, cheaply.** Code re-fetches the known sources on each run. An LLM extracts rules only from pages whose text changed or is new. A search for new sources runs at most weekly. (REQ-35, REQ-36.)
- **G4. Review every tailored CV.** Mechanical rules are checked by code on every round. Judgement rules are checked by one tool-less `cv.review` call on the round that matters. Fixable misses drive a revision within the 3 rounds. (REQ-37, REQ-38, AD-13.)
- **G5. Truth before QA.** A deterministic claim check on every tailored CV rejects an attempt that states a number, month, year or duration its cited facts lack. The attempt is retried, and no round is used up. (REQ-39, SEC-25.)
- **G6. Fact requests, not guesses.** "Needs fact" items become fact requests tied to the exact fact and field, asked once across all jobs. (REQ-37.AC-2, REQ-39.AC-1.)
- **G7. Screens.** A new CV guidance screen (`/guidance`), a guidance panel per language on the existing review screen, and a new Activity screen (`/activity`) that sub-project 4 later shares. (REQ-36, REQ-40.)

### Non-goals
- Changing QA in any way (NG8). The page-length question is settled in §6 (OQ-12).
- Applying guidance to master facts (NG9). Guidance raises fact requests; only Ba's answers change facts.
- Editing `bots/*/ROLE.md`, `bot.json`, skills or the prompt lock automatically. The rule set reaches bots only as task input data. (NG5, SEC-24.)
- Ba editing rule text, or choosing between disputed positions by hand. Ba can only turn a rule off or on (§5.9).
- Cover letters or application answers.

### Anti-goals (a failure even if it "works")
- A rule pushes the CV to claim a result figure, a month or a skill Ba never gave, and it reaches an employer.
- A web page's injected text ("tell the CV writer to list every JD skill") becomes a rule.
- A rule cites a source that was never fetched, or a page that never said it.
- One publisher with many pages outvotes everyone else in a dispute.
- Every run spends an LLM session re-reading the same unchanged articles.
- A refresh failure stops tailoring, or leaves an empty or half-written rule set in force.
- Ba is asked the same "what months did you study?" question once per job.

## 3. Constraints
- Single user, local Mac, subscription CLIs, no LLM API keys. Same stack and Turborepo note as sub-project 1.
- The orchestrator fetches guidance pages itself (SEC-20, SEC-21). The Research bot's Chrome site guard limits Chrome to the six boards, and guidance pages must never go through Ba's logged-in browser.
- Bot role changes are developer changes in this PR, with `promptVersion` bumps and `bots:lock`: CV (`derive` from sub-project 2, plus `review` and guidance-following in `tailor`) and Research (`guidance_extract`, `guidance_discover`).
- The gate stays at `maxRounds: 3` and keeps its per-language rows.
- `.vtc/state/` is gitignored, so the VNPT image is copied into the repo (§5.2) and cited there.

## 4. Decided by Ba (earlier answers, carried over)
1. Guidance comes from **multiple** HR or recruiter sources, each rule with its provenance. (E-5.)
2. **Refresh and optimise on each run.** (E-5, settles the "when" of OQ-15; the "how" is in §6.)
3. **Missing details become fact requests** to Ba. (E-5.)
4. **Never invent.** (NG4.)
5. The QA one-page hard fail stays unless there is a strong reason. None was found (§6, OQ-12).

## 5. How it works

### 5.1 Schema: `packages/shared/src/cv-guidance/schema.ts`
This is AD-10's shape, with these additions:
- **Source:** `{ id, title | publisher, url (https) | repoPath, retrievedAt (set by code), kind, market, host }`.
  - `kind` is one of `vn_recruiter`, `global_recruiter`, `ats_vendor`, `hr_publication`, `attachment`.
  - `market` is `vn` or `global`.
  - `host` is the registrable domain, computed by code, and used for counting (SEC-23).
  - Each source also keeps `contentHash` and `etag`/`lastModified`, for the cheap re-check in §5.4.
- **Rule:** `{ id, topic, point, check, appliesWhen, overriddenBy, positions[] }`.
  - `topic` is a fixed list: `dates`, `order`, `bullet_content`, `contact`, `links`, `skills`, `length`, `layout_ats`, `summary`, `language`, `other`.
  - `check` is either the id of a deterministic checker (§5.6) or `judgement`.
  - Each **position** is `{ id, text (≤ 300 chars), sourceIds[] (≥ 1), evidence[] }`. `evidence` holds one short verbatim quote (≤ 300 chars) per source, taken from that source's fetched text.
- **Disputed** is computed (more than one position), never stored. **Turned off** is a separate Ba setting (§5.9), never part of a snapshot.
- Limits: 100 rules at most, 40 sources, 300-character statements (SEC-22).

### 5.2 Seed: `packages/shared/src/cv-guidance/seed.ts`
- The VNPT image is copied to `docs/cv-guidance/vnpt-cv-tips-2026-10.png`, and its transcription goes in the seed. Source: `{ publisher: "VNPT (Tuyển dụng VNPT)", repoPath: "docs/cv-guidance/vnpt-cv-tips-2026-10.png", kind: "attachment", market: "vn" }`. These positions are **pinned**: a refresh may add positions next to them, but never rewrite or remove them.
- The eight VNPT rules, with checks:

| Point (REQ-30.AC-1) | VNPT says (from the post) | `check` |
|---|---|---|
| (a) month and year on education and experience | "06/2023 – 08/2025", not "2023 – 2025"; also certificates | `month_year` |
| (b) most relevant experience first | "Kinh nghiệm liên quan nhất → đặt trước" | `judgement` |
| (c) what, which technology, what result | "Bạn làm gì – dùng công nghệ gì – tạo ra kết quả gì" | `judgement` (a missing result figure becomes `needs_fact`) |
| (d) name, phone, email complete and correct | "Họ tên, SĐT, Email đầy đủ & chính xác" | `contact_present` |
| (e) LinkedIn, GitHub or portfolio if they exist | "LinkedIn/GitHub/Portfolio nếu có" | `links_present`, `appliesWhen: has_profile_link` |
| (f) skills relevant to the JD | "Skills/Tech Stack liên quan đến JD" | `judgement` |
| (g) no technology without practical experience | "Không liệt kê quá nhiều công nghệ nhưng không có kinh nghiệm thực tế" | `practical_experience` |
| (h) 1 to 2 pages, easy layout | "CV ưu tiên 1–2 trang" | `page_length`, `overriddenBy: [over_one_page]` |

- **At least 2 non-VNPT sources in the seed**, found at build time by the researcher. They must be pages it actually fetched, with quotes. Candidates to try, in this mix of kinds: one or two Vietnamese IT recruiter or job-board career guides (e.g. ITviec blog, TopCV or VietnamWorks career advice), one global recruiter or career guide, and one ATS-vendor guide on ATS-safe CVs. These are names to try, not facts: only pages that fetch and quote cleanly are kept.
- At start, a seed rule or source missing from the current snapshot is committed through the same screen and commit path as a refresh, so it is logged (AD-10).

### 5.3 Storage: `apps/orchestrator/src/db/repos/guidance.ts`
AD-10 as written:
- the `guidance_rule_sets` table: snapshot number, `createdAt`, `runId`, JSON
- append-only
- `commitGuidanceRuleSet` writes the snapshot plus one `guidance.rule_added` or `guidance.rule_changed` event per change in one transaction

It also adds a small `guidance_settings` table: rules Ba turned off (§5.9), `lastDiscoveryAt`, and the refresh lock.

### 5.4 Refresh: `apps/orchestrator/src/engine/guidance-refresh.ts`
**Workflow.** `workflows/job-scan.yaml` gets a step `guidance` after `top` and before every branch step: `optional: true`, `skipIfEmpty: top`, run once per run (AD-12). `TaskStepSchema` gains the additive fields `optional` and `skipIfEmpty`. Workflow `version` bumped. The step is engine-run with sub-tasks rather than a single bot task:

1. **Re-check (code, every run, no LLM).** `GuidanceFetcher` (`apps/orchestrator/src/adapters/guidance-fetch/`) does a GET for every web source in the current set, through the shared HTTP layer, with these rules:
   - SEC-21 policy: https only; public addresses only, re-checked after each redirect; at most 3 redirects; no cookie, `Authorization` or board token; 2 MiB and 20 s per page; 15 pages per refresh
   - the 1.5 s per-host gap
   - `If-None-Match` and `If-Modified-Since` when known

   The main text is extracted (reusing `adapters/text.ts`) and hashed. **Unchanged pages end here.**
2. **Discovery (LLM, at most weekly).** Runs only when `lastDiscoveryAt` is older than 7 days, or when fewer than 3 distinct non-VNPT hosts back the set. One `research.guidance_discover` task with `web_search` only and no Chrome, files or fetch. It returns up to 10 candidate URLs and nothing else (SEC-20). The orchestrator fetches them as in step 1, within the same 15-page cap.
3. **Extract (LLM, only for changed or new pages).** One `research.guidance_extract` task for the whole batch, with **no tools**. The input is the current rules (ids, points, positions) and each changed or new page as quoted data in its own block, capped at about 60k characters in total. The output is drafts `{ ruleId?, topic, point, positionId?, text, sourceUrl, evidence }`.
4. **Screen** with `screenGuidanceUpdate` (§5.5), then **commit** once if anything changed. Each refresh records one `guidance.refresh` event: run id, pages checked, unchanged, changed, failed, drafts accepted and rejected (counts and reasons, no page text).

**Cost per run.** In the common case (nothing changed, no discovery due) it is N HTTP GETs and 0 LLM calls. When a page changed: 1 tool-less extraction call. Weekly: 1 more search call.

**Failure (REQ-35.AC-3).** The previous snapshot stays in force and tailoring goes on. Lead posts "CV guidance refresh failed: <reason>" **only** when no source could be read at all, or the step itself failed. A partial failure (some pages unreachable) is recorded in the refresh event and shown on the Guidance screen, without a notice. **Lock:** one refresh at a time across runs. A second run that finds a refresh in progress waits for it, up to the step timeout, and uses its result. A run never refreshes twice (SEC-24.AC-1).

**Step budget.** 5 minutes. After that, the step ends as failed and is optional, so tailoring goes on with the previous snapshot.

### 5.5 Pure policy: `packages/shared/src/cv-guidance/` (AD-11, no I/O, no clock)
- **`screenGuidanceUpdate(current, drafts, fetchedPages, refreshedAt)`** does everything AD-11 says, plus:
  - **Evidence check (SEC-23).** A draft's `sourceUrl` must be a page fetched in this refresh, and its `evidence` must occur in that page's text after normalising whitespace and case. Otherwise the source is dropped, and a position left with no source is rejected. Source `url`, `title` and `retrievedAt` come from the fetch, never from the model.
  - **Content screen (SEC-22).** It rejects:
    - statements over 300 characters
    - a URL in the text
    - instructions aimed at the bot or its configuration ("ignore", "system prompt", "ROLE.md", "output schema")
    - any statement telling the CV to add, assume, estimate or round up a fact, number, date, title, employer or skill, or to list skills without experience. This uses a deny-list of verbs and objects in EN and VI, table-tested.
  - **Mapping.** A draft with a known `ruleId` and the same advice adds its source to the existing position. With different advice, it adds a new position (the rule becomes disputed, REQ-32). With no `ruleId`, it creates a new rule only if its `topic` plus point does not duplicate an existing rule (normalised text match). Otherwise it maps onto that rule.
  - **Constraint mapping (SEC-22).** `overriddenBy` is set by code from the topic and the text: any `length` position allowing more than one page gets `over_one_page`, and any `layout_ats` position that conflicts with the CV bot's named layout rules gets that rule's id.
- **`resolveGuidance(ruleSet, ctx)`**, where `ctx` is `{ masterContact, jobMarket, turnedOff }`. One disposition per rule, in this order:
  1. `turned_off` (Ba)
  2. `overridden` (non-empty `overriddenBy`)
  3. `not_applicable` (`appliesWhen` false)
  4. for a disputed rule, the position with the most **distinct hosts** is applied
  5. on a tie at the top, the position whose sources include the job's market (`vn` when the JD is Vietnamese or the job is in Vietnam, else `global`), if exactly one tied position has it
  6. otherwise `disputed_not_applied`
  7. a single position is applied
- **`checks.ts`**: the deterministic checkers (§5.6).
- **`completeGuidanceReview(resolved, checkerItems, reviewerItems, activeFactIds)`**: AD-11 as written. Deterministic checker items win over reviewer items for the same rule.

### 5.6 Deterministic checkers: `packages/shared/src/cv-guidance/checks.ts`
They take the tailored CV, the PDF facts and text, the cited active facts (Ba's and derived) and the master contact.
- `month_year`: every experience and education item's cited facts have month and year in `dates`.
  - Met if all do.
  - Otherwise `needs_fact`, one per fact without months: "What were the start and end months of <fact text, short>?" The CV keeps the years only (REQ-37.AC-2/AC-3).
  - "Present" counts as a month.
- `contact_present`: name, phone and email are in the master contact and in the PDF text. If the master has no phone, `needs_fact` (field `contact.phone`).
- `links_present`: when the master contact has links, at least one is in the PDF text. Otherwise not met and fixable.
- `practical_experience`: every technology in the CV's skills section is mentioned by at least one cited experience or project fact, or by a derived fact resting on one. Otherwise not met and fixable, with the fix "remove <skill>" (REQ-38.AC-2).
- `page_length`: from `pdf.pageCount`. It is `overridden` under the constraint anyway, but the stored result still records the page count.

### 5.7 Review in the gate: `apps/orchestrator/src/engine/gate.ts`
AD-13's flow. `GateStepSchema` gains `reviewer`, and `job-scan.yaml`'s `tailor` gets `reviewer: { bot: cv, kind: review }`. It is made cheaper as follows:
- **Tailor input.** `cv.tailor` gets the resolved guidance, as data: the applied positions only, with their rule ids. A new `ROLE.md` section says to follow them where Ba's facts allow, always below the truthfulness and layout rules.
- **Truth check before export (SEC-25).** When a `cv.tailor` output settles, `checkCvClaims(cv, citedFacts)` (from `packages/shared/src/truth/`, sub-project 2) rejects any bullet or summary that states a number, percentage, month, year or duration its cited facts lack. The **attempt** fails with the reason and is retried under the existing attempt rules. It does not use up a gate round, and QA is not called on it.
- **Each round:**
  1. tailor
  2. truth check
  3. export
  4. `qa.review`, unchanged
  5. the deterministic checkers (free)
  6. **`cv.review` only when QA passed this round, or when this round is the one handed to Ba**
  7. `completeGuidanceReview`
  8. store the result
- **Pass rule.** The gate passes when `qaPassed` holds and no fixable `not_met` remains. Otherwise, while the round is below 3, the next round gets QA's fixes plus one fix per fixable `not_met`. A QA-failed round already gets a new round today, so a guidance review there would be wasted. The deterministic fixes ride along at no cost.
- **Handed round.** As AD-13: the latest QA-passed round, else the latest without `invented_claim`, else the latest (escalated as today). Guidance never escalates on its own (REQ-38.AC-3).
- **`cv.review` task.** New CV kind `review`, no tools. Input: the CV, the PDF text, the JD (as data), the cited active facts, and the applied `judgement` rules only. Output (`packages/shared/src/bots/cv-review.ts`): one item per judgement rule, with status `met`, `not_met`, `needs_fact` or `not_applicable`, a one-line reason, `fixable` with an instruction and the fact ids it uses, or `needs_fact` with one fact id and a question. Fixes that cite unknown or inactive facts are dropped (AD-11).
- **Cost per language per job:** typically 1 review call, at most 3. The worst case is unchanged from AD-13; the usual case is a third of it.
- `guidance_reviews` table: one row per stored CV round, with the snapshot number and the result JSON (AD-13).

### 5.8 Fact requests from guidance
- `needs_fact` items become fact requests on the stored CV version, tagged `origin: guidance` with `ruleId`, `factId` and `field` (`dates`, `result`, `contact.phone`). They are **deduplicated across jobs** by `(ruleId, factId, field)` against the open requests in `data/api-state.json`, so Ba is asked once.
- On the Master CV screen:
  - a `dates` or `contact` request opens the **existing fact editor** for that fact or the contact block. Ba types the months himself: no LLM, and his own edit.
  - a `result` request uses the existing "answer a fact request" flow (`cv.fact_draft`), which adds a metric or experience fact in his words, with the org taken from that fact.
- When the answer is saved, the matching open requests close for every job. "Re-tailor CVs for …" stays as today.
- Nothing in guidance writes the master CV (SEC-17.AC-3). The AD-1 and AD-12 import checks stay.

### 5.9 Turning a rule off (OQ-3)
- On the Guidance screen, each rule has "Turn off for my CVs" and "Turn on" (a state-changing route under Origin and CSRF, SEC-19). A turned-off rule resolves to `turned_off`: it is not sent to tailor or review, and it shows in the all-rules list as "Turned off by you".
- A refresh never turns a rule back on. This is the one control Ba has. Rule text is never edited by hand, and there is no snapshot revert. *(Leader's call — Ba can override.)*

### 5.10 Telling Ba
- A successful refresh posts nothing. The Guidance screen's summary line shows the last refresh and what it changed.
- A failed refresh posts the notice in §5.4, with the action "Open the CV guidance" (`scan-notices.md`).
- The review step shows the per-language panel (§7).

## 6. Open questions resolved here
- **OQ-12 (one page or 1 to 2 pages):** keep one page, and QA unchanged. Three reasons. A one-page CV also meets VNPT's "1–2 pages". Ba's roles in the master CV start in 2022, which is the range where most recruiter advice says one page. And the hard fail is the check that keeps the CV layout honest. The length rule shows "overridden by over_one_page". **No strong reason to change QA was found, so it is not flagged for change.** *(Leader's call — Ba can override.)*
- **OQ-13 (how many sources, which kinds):** at least 2 non-VNPT hosts (REQ-31), with a target of 4 to 6 hosts covering 3 kinds: a Vietnamese IT recruiter or job board, a global recruiter or career guide, and an ATS vendor. Discovery runs early when the set falls below 3 non-VNPT hosts. *(Leader's call — Ba can override.)*
- **OQ-14 (disputes):** count distinct publisher hosts. A tie is broken by the job's market (VN or global), and is otherwise not applied. QA hard fails and the CV bot's layout rules always win. No hand weighting and no Ba choice: both cost Ba's time, and the market tie-break is the adaptive part he asked for. *(Leader's call — Ba can override.)*
- **OQ-15 (when to refresh):** every run, as Ba decided. A cheap conditional re-fetch every run, LLM extraction only for changed or new pages, and source discovery at most weekly. *(Leader's call on the "how" — Ba can override, e.g. discovery every run.)*
- **OQ-6 (caps), this sub-project's part:**
  - per refresh: 15 pages, 2 MiB and 20 s per page, 5 minutes in total, 1 extraction call, 1 discovery call per week
  - per job and language: at most 3 `cv.review` calls, usually 1
  - 100 rules
  *(Leader's call — Ba can override.)*
- **OQ-3 (revert), for guidance:** no snapshot revert. Ba can turn a rule off (§5.9). *(Leader's call — Ba can override.)*

## 7. UI states
In the existing shell and tokens. The VTC screens and prototypes are reference.
- **CV guidance (`/guidance`, new; sidebar entry after "Master CV").**
  - Summary line: "N rules from M sources. Last checked <time>; changed <k> rules."
  - One card per rule: statement, status badge ("Sources agree", "Disputed", "QA limit over_one_page applies", "Turned off by you"), the "applies only when" line, and "Sources (n)" opening the sources in place (title, link only if https with `rel="noopener noreferrer"`, retrieved date, the evidence quote). All of it is plain text (SEC-26).
  - A disputed rule shows every position, each with its sources and "Applied", "Not applied" or "Applied for Vietnam jobs", plus one sentence saying why.
  - Turn off and Turn on per rule.
  - States:
    - empty: "No guidance rules yet…", with "Open Lead to start a scan"
    - loading: three skeletons
    - error: "Could not load the CV guidance… Tailoring is not affected. Retry."
    - refresh-failed: the banner from the design, plus "Last successful check <time>"
    - partial: "3 of 5 sources could not be read this run; their rules stay as they were."
- **Review step (existing `/review`).** Language tabs (English CV, Vietnamese CV), then the "CV guidance" panel per language:
  - Summary sentence: "2 rules need your attention. Checked in 2 rounds; the CV was revised once."
  - Items in this order: Not met (with "Still not met after round 3" where true), Needs fact (with its fact-request card and "Answer"), Disputed not applied. Each item has its sources.
  - "All N rules in this review" disclosure.
  - Or "All CV guidance rules met" with no list (REQ-40.AC-2).
  - The review actions are never blocked.
  - States: empty, loading, error and all-met, as in the design.
- **Activity (`/activity`, new; sidebar entry after "Schedules").**
  - Built here with guidance entries: "Rule added" or "Rule changed", the time, the rule, previous and new text side by side, and sources.
  - Sub-project 4 adds skill-repair entries to the same list.
  - States: empty, loading and error, as in the design.
- **Master CV.** Guidance fact requests use the existing fact-request card, with the label "From CV guidance: <rule>". Answering opens the editor or the draft flow (§5.8).

## 8. Test strategy
vitest, following the repo's conventions.
- `packages/shared/src/cv-guidance/schema.test.ts`:
  - REQ-29.AC-1 over the seed; a source without title or publisher, or without url or path, is refused
  - REQ-30.AC-1: the 8 points, each citing the repo copy of the post, and the file exists (SEC-23.AC-3)
  - REQ-31.AC-1: at least 2 non-VNPT hosts
- `screen.test.ts`:
  - REQ-29.AC-2
  - REQ-32.AC-1
  - REQ-35.AC-2
  - pinned VNPT positions
  - SEC-20.AC-2
  - SEC-22.AC-1/AC-2
  - SEC-23.AC-1: an unfetched URL, or evidence not found in the page text
  - mapping onto existing rules
- `resolve.test.ts`:
  - REQ-33.AC-1
  - REQ-33.AC-2 with distinct hosts (SEC-23.AC-2)
  - the market tie-break
  - REQ-34.AC-1
  - REQ-37.AC-4
  - `turned_off`
- `checks.test.ts`: `month_year` on Ba's real date forms ("Feb 2024 – Sep 2025" met, "2020 – 2023" needs fact), REQ-37.AC-2/AC-3, REQ-38.AC-2 (Go), contact and links.
- `review.test.ts`: REQ-37.AC-1, REQ-39.AC-1, a fix citing an unknown fact is dropped, deterministic items win.
- `packages/shared/src/truth/` (extended): SEC-25.AC-1 to AC-3.
- `apps/orchestrator/src/adapters/guidance-fetch/*.test.ts`: SEC-21.AC-1 to AC-3 with a mocked resolver and fetch; a conditional GET with 304 means no extraction.
- `apps/orchestrator/src/engine/guidance-refresh.test.ts`:
  - REQ-35.AC-1: 3 jobs, one refresh, ended before the first `cv.tailor`
  - REQ-35.AC-2
  - REQ-35.AC-3: all unreachable means the same snapshot, the notice, and tailor tasks still created
  - unchanged pages mean 0 extraction tasks
  - discovery only when due
  - SEC-20.AC-1: the hostile page is in a user message, the tool grants are empty, and 0 requests go to evil.example
  - SEC-24.AC-1 to AC-4
- `apps/orchestrator/src/db/repos/guidance.test.ts`: REQ-36.AC-1, and a throw inside the commit keeps the previous snapshot.
- `apps/orchestrator/src/engine/gate.test.ts`:
  - REQ-37.AC-5: an EN and a VI row
  - REQ-38.AC-1 to AC-3
  - REQ-39.AC-2
  - SEC-25 rejects an attempt without using a round
  - `cv.review` is not created on QA-failed rounds that are not handed over
  - never a round 4
- `packages/shared/src/bots/qa.test.ts` pins QA (NG8), and the AD-13 forbidden-pattern check on `bots/qa/**` and `bots/qa.ts` passes.
- `apps/orchestrator/src/api/views/review.test.ts`: REQ-40.AC-1/AC-2. Fact-request dedupe across two jobs. SEC-17.AC-3: the master CV is byte-identical before and after a refresh plus review.
- Prompt lock: `bots:lock` after the bumps; SEC-24.AC-2.
- Web: component tests for the guidance rule card, sources (SEC-26.AC-1), the review panel and tabs, and the activity entry. Screenshots of every state for the PR.
- **Live check (QA):** one real refresh (sources fetched, rules extracted, counts shown), then a second run showing 0 extraction calls when nothing changed. Then one real job tailored and reviewed in both languages, with the review step screenshot.

## 9. Differences from the VTC spec and architecture
| VTC item | Here |
|---|---|
| AD-12: the refresh is a Research task reading pages through `web_search` | The orchestrator fetches pages (SEC-20/21). Tool-less extraction runs only for changed pages; URL-only discovery runs weekly (§5.4) |
| AD-13: `cv.review` on every round | Deterministic checks every round; `cv.review` only on QA-passed or handed-over rounds (§5.7) |
| SEC-25 "reject a revision" | Rejects the attempt before QA, retried without using a round (§5.7) |
| REQ-33.AC-2: a tie applies neither | A tie is broken by the job's market first; still tied applies neither (§5.5) |
| REQ-30 cites `.vtc/state/attachments/...` | Cites a repo copy `docs/cv-guidance/vnpt-cv-tips-2026-10.png` (`.vtc/state/` is gitignored) |
| AD-10 rule shape | Adds `topic`, `check`, source `market`/`kind`/`host`, position `evidence` |
| Guidance screen: no actions | Adds Turn off and Turn on per rule (§5.9) |
| Not in spec | Fact requests are deduplicated across jobs; `dates` requests open the fact editor (§5.8) |
| Notice on any refresh failure | Notice only when no source could be read; partial failures show on the screen |

## 10. Left to the builder
- The non-VNPT seed sources: real pages, fetched and quoted at build time.
- The main-text extraction method for HTML pages, within `adapters/text.ts` style.
- The exact deny-list for the content screen, table-tested in EN and VI.
- Whether `guidance` is a new step type or a `task` step with engine sub-tasks. The behaviour in §5.4 must hold either way.
- The `guidance_settings` table shape, the route shapes and the `/activity` API.
- How the stored CV holds guidance fact requests (extend the stored type, keep `CvOutput`'s `FactRequestSchema` unchanged for the bot).
- The model for `guidance_extract`, `guidance_discover` and `cv.review`, if per-kind models are supported.
- Test layout.
