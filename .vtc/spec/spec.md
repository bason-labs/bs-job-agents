# Specification: job research without the browser extension, and self-updating skills and CV

Run: r20261017-044722. Source request: `.vtc/runs/r20261017-044722/request.md`. Context: `.vtc/research/repo-map/repo-map.md`.

Revision 2. Revised to Ba's gate answers E-1 (access path order, read-only run, research per board) and E-2 (implied skills become derived facts; numbers, years and durations never invented). Changed: Problem, G1, G3, NG1, NG4, REQ-1, REQ-4, REQ-5, REQ-7, REQ-14, REQ-19, NFR-2, user-visible states, assumptions, OQ-1, OQ-2, OQ-5, glossary. Removed: REQ-16 (replaced by REQ-26 to REQ-28). Added: REQ-21 to REQ-28, OQ-8 to OQ-11. No id was renumbered or reused.

## 1. Problem

Ba, the only user, finds jobs through a Research bot that drives his own Chrome through the extension for six boards. When a board changes its layout, the scan fails as "adapter broken" until a person rewrites that source's skill. When a job description asks for something the master CV does not state, the CV leaves it out and waits for Ba to answer a fact request, even when the skill clearly follows from what Ba already did (Redux from React and Next.js work). Once this is solved, each board is read through its public API, or failing that through the board's own internal web API with Ba's account token, and through the browser only when neither exists. Source skills repair themselves without Ba editing a file. The tailored CV covers requirements that Ba's existing master facts support or imply in a well-known way, without Ba answering, and never with a number, year or duration that is not in his real facts.

## 2. Goals

- G1: Scans read each board through the first available of: a public API, the board's internal web API called with Ba's own account token, the browser UI. The choice per board rests on documented research of endpoints and terms-of-use and account risk. This run only reads (REQ-1 to REQ-7, REQ-21 to REQ-25).
- G2: A source skill whose layout check fails gets updated, validated and adopted without Ba editing any file (REQ-8 to REQ-13).
- G3: When a job requirement is supported by existing master facts, or is a skill they imply in a well-known way, the master CV gets a derived fact automatically, labelled with the facts it rests on and undoable, and the tailored CV covers that requirement (REQ-14, REQ-15, REQ-17 to REQ-20, REQ-26 to REQ-28).

## 3. Non-goals

- NG1: Applying to jobs, including applying through any board API. The Apply bot, the `apply` step and the human `review` gate of `workflows/job-scan.yaml` stay as they are. Apply endpoints are documented (REQ-22) but never called (REQ-23); applying through an API is a later change request.
- NG2: Adding or removing search sources, or changing `canApply` for any source.
- NG3: Changing how fit is scored, how jobs are deduplicated, or the shape of `ResearchScanOutput`.
- NG4: Inventing experience. A derived fact may state only what cited master facts state or imply in a well-known way (REQ-26); it never adds a number, year, duration, employer or title the cited facts lack (REQ-27, REQ-28; `bots/cv/ROLE.md` line 1).
- NG5: Automatically changing `ROLE.md`, `bot.json`, workflow YAML, allowed sites or allowed tools (see OQ-4).
- NG6: Removing the existing fact-request flow. Requirements that no existing fact supports or implies still go to Ba as fact requests.
- NG7: Any request that changes state on a board or on Ba's board account (apply, save, follow, message, profile edit).

## 4. Requirements

### Research through an API (G1)

**REQ-1** (revised r2) When a scan runs for a source whose chosen access path is a public API or an account API, the system shall read that source's jobs through that path.
- REQ-1.AC-1: Given `remotive` is enabled, Chrome is not running and the Remotive API returns 3 postings that match the criteria, When the job-scan workflow runs, Then the `remotive` scan branch completes with those 3 jobs and the run records 0 Chrome tool calls for it.
- REQ-1.AC-2: Given the access record for `itviec` chooses the account API path, Ba's ITviec token is in local secret storage and Chrome is not running, When the job-scan workflow runs, Then the `itviec` branch completes with the jobs the account API returns and records 0 Chrome tool calls.
- REQ-1.AC-3: Given the API returns 0 postings that match, When the scan runs, Then the branch completes with 0 jobs and no error.

**REQ-2** While a source has a non-browser access path, the system shall not open, navigate or read a tab in Ba's Chrome for that source's scan.
- REQ-2.AC-1: Given `itviec` has a non-browser access path, When its scan task runs, Then the task's transcript contains no `chrome:` tool call and the bot's granted tool list for that task contains no `chrome:` tool.

**REQ-3** Jobs read through a non-browser access path shall pass the same output validation and deduplication as jobs read through the browser.
- REQ-3.AC-1: Given an API returns a posting without a job URL, When the scan output is validated against `ResearchScanOutput`, Then that posting is rejected and the other postings from the same response are kept.
- REQ-3.AC-2: Given posting URL `https://www.topcv.vn/viec-lam/x/123.html` was found by an earlier browser scan, When a scan through an API returns the same URL, Then the job list holds one job for that URL after dedupe.
- REQ-3.AC-3: Given an API posting has a description shorter than the full job description (a snippet only), When the scan self-check runs, Then the item fails the existing self-check "Every job has full JD text (not a snippet)" exactly as a browser-read item would.

**REQ-4** (revised r2) If a source has neither a public API nor an internal web API recorded as usable in its access record, then the system shall scan it through the browser as it does today.
- REQ-4.AC-1: Given the access record for `upwork` chooses the browser path and Chrome is running, When the scan runs, Then the `upwork` branch runs through the Research bot in Chrome with the source skill `source-upwork`.

**REQ-5** (revised r2) If an access path needs a credential that is not in local secret storage, then the system shall fail that source's branch and let the other sources go on.
- REQ-5.AC-1: Given the access record for `linkedin` chooses the account API path and no LinkedIn token is in local secret storage, When the scan runs, Then the `linkedin` branch fails, Lead posts a notice starting "LinkedIn scan failed:" that names the missing LinkedIn token without any token value and ends "The other sources go on.", and the `remotive` branch still completes.
- REQ-5.AC-2: Given the same state, When the scan runs, Then the system makes no request to LinkedIn and does not open LinkedIn in Chrome. [ASSUMPTION] (see OQ-8)

**REQ-6** If a non-browser access path fails transiently (HTTP 429, HTTP 5xx, connection error or timeout), then the system shall fail only that source's branch after its retries are used up, with the reason in the notice.
- REQ-6.AC-1: Given the Remote OK API answers HTTP 503 on every attempt, When the scan runs, Then the `remoteok` branch fails, Lead posts "Remote OK scan failed: <reason containing 503>. The other sources go on.", and the other branches complete.
- REQ-6.AC-2: Given the API answers HTTP 503 once and then HTTP 200 with 2 postings, When the scan runs, Then the branch completes with those 2 jobs.
- REQ-6.AC-3: Given the API answers HTTP 401 or 403, When the scan runs, Then the branch fails without retry and the notice names the authorisation failure.

**REQ-7** (revised r2) The Search criteria screen shall show, for each enabled source, whether it is read through a public API, an account API or the browser.
- REQ-7.AC-1: Given `remotive` is read through a public API, `itviec` through an account API and `upwork` through the browser, When Ba opens the Search criteria screen, Then the Remotive toggle shows "Public API", the ITviec toggle shows "Account API" and the Upwork toggle shows "Browser".
- REQ-7.AC-2: Given a source's access path changes from browser to account API, When Ba reloads the screen, Then that toggle shows "Account API".

**REQ-21** (added r2) The system shall use, for each source, the first access path available in this order: public API, the board's internal web API called with Ba's account token, the browser UI.
- REQ-21.AC-1: Given the access record for a board lists a usable public API and a usable internal web API, When a scan runs, Then that board is read through the public API and its account token is not read.
- REQ-21.AC-2: Given the access record for a board lists no usable public API and a usable internal web API, When a scan runs, Then that board is read through the account API.
- REQ-21.AC-3: Given the access record for a board lists neither, When a scan runs, Then that board is read through the browser (REQ-4).

**REQ-22** (added r2) For each of the six browser boards (`topcv`, `itviec`, `vietnamworks`, `linkedin`, `wellfound`, `upwork`), an access record shall document: whether a public API exists and its job-read endpoints; the internal web API job-read (get) endpoints found by observing the site in the browser; the apply endpoints found; the terms-of-use clauses on automated access and the risk to Ba's account; and the chosen access path.
- REQ-22.AC-1: Given the research for this run is complete, When the access records are read, Then each of the six boards has a record and every one of the five items above has a value, where "none found" is a valid value for an endpoint item.
- REQ-22.AC-2: Given a board's record lists one or more apply endpoints, When the record is read, Then each apply endpoint is marked "documented only, not called".
- REQ-22.AC-3: Given a board's record chooses the account API path, When the record is read, Then it lists at least one internal web API get endpoint and a non-empty account-risk statement.
- REQ-22.AC-4: Given a board's record lists no public API and no internal web API get endpoint, When the record is read, Then its chosen path is "browser".

**REQ-23** (added r2) While scanning through a public API or an account API, the system shall send requests only to the get endpoints listed in that board's access record.
- REQ-23.AC-1: Given LinkedIn's access record lists apply endpoint `E-apply` and get endpoint `E-search`, When any number of LinkedIn scans run, Then the recorded requests to LinkedIn include no request to `E-apply`.
- REQ-23.AC-2: Given the same state, When a LinkedIn scan runs, Then every recorded request to a LinkedIn host targets an endpoint listed as a get endpoint in the record.

**REQ-24** (added r2) The system shall read a board's account token only from local secret storage.
- REQ-24.AC-1: Given Ba's ITviec token is in local secret storage, When an `itviec` scan runs on the account API path, Then the requests carry that token and the scan completes (REQ-1.AC-2).
- REQ-24.AC-2: Given no ITviec token is in local secret storage and a token-like value sits in a repository file, When an `itviec` scan runs, Then the branch fails as in REQ-5 and the repository value is not used.

**REQ-25** (added r2) If a board rejects Ba's account token (HTTP 401 or 403 on the account API path), then the system shall tell Ba the token must be renewed.
- REQ-25.AC-1: Given the ITviec account API answers HTTP 401, When the scan runs, Then the `itviec` branch fails without retry and Lead posts a notice starting "ITviec scan failed:" that names the rejected ITviec token without its value and asks Ba to renew it in local secret storage.

### Self-updating source skills (G2)

**REQ-8** When a browser-source scan fails as "adapter broken", the system shall draft an updated skill for that source without Ba editing any file.
- REQ-8.AC-1: Given the TopCV scan fails with "adapter broken: no job cards on the results page (layout changed?)", When the failure is recorded, Then exactly one skill-repair attempt for `topcv` starts, and Ba is not asked to edit `bots/research/skills/source-topcv/SKILL.md`.
- REQ-8.AC-2: Given a TopCV scan fails as "scan failed" for a transient reason (not "adapter broken"), When the failure is recorded, Then no skill-repair attempt starts.
- REQ-8.AC-3: Given a skill-repair attempt for `topcv` is already running, When a second TopCV "adapter broken" failure is recorded, Then no second attempt starts.

**REQ-9** Before adopting a drafted skill, the system shall validate it with a scan of that source that passes the scan self-check and the scan output checker.
- REQ-9.AC-1: Given a drafted TopCV skill, When the validation scan returns jobs that pass the self-check and the output checker, Then the drafted skill replaces the previous one and the next TopCV scan uses it.
- REQ-9.AC-2: Given a drafted TopCV skill, When the validation scan fails the self-check, Then the previous skill stays in force unchanged.

**REQ-10** If skill repair fails, then the system shall keep the previous skill and report the source as broken with the repair outcome.
- REQ-10.AC-1: Given a repair attempt whose validation fails, When it ends, Then Lead posts "TopCV adapter broken: <reason>" followed by "Automatic repair failed: <reason>", and the TopCV branch of later scans still runs with the previous skill.

**REQ-11** The system shall record every adopted skill change with the source, the time, the reason that triggered it and the previous and new skill text.
- REQ-11.AC-1: Given the TopCV skill was repaired and adopted at 2026-10-17T09:00:00Z, When Ba views the activity log, Then one entry shows source TopCV, that time, the "adapter broken" reason, and the difference between the previous and new skill.
- REQ-11.AC-2: Given a repair attempt that was not adopted, When Ba views the activity log, Then its entry says it was not adopted and the skill text is unchanged.

**REQ-12** An automatically adopted skill change shall not cause the orchestrator to start in the degraded state that guards prompt changes.
- REQ-12.AC-1: Given the TopCV skill was repaired and adopted, When the orchestrator restarts, Then it starts without the degraded-start warning for the `research` bot.

**REQ-13** Automatic updates under G2 shall change only files under `bots/<bot>/skills/`.
- REQ-13.AC-1: Given a skill repair for `topcv` is adopted, When the repository files are compared before and after, Then only files under `bots/research/skills/source-topcv/` differ.
- REQ-13.AC-2: Given a drafted skill also proposes a change to `bots/research/bot.json` (for example a new allowed site), When the repair is adopted, Then `bots/research/bot.json` is unchanged and the activity log entry lists the change as not applied.

### Automatic CV extension from existing facts (G3)

**REQ-14** (revised r2) When a tailor task finds a job requirement that the master facts do not state but one or more existing master facts support or imply in a well-known way, the system shall add a derived master fact without asking Ba.
- REQ-14.AC-1: Given master fact `f-12` "Built CI pipelines in GitHub Actions for 6 services" and a JD requirement "experience with CI/CD", When the tailor task runs, Then the master CV gains one derived fact covering "CI/CD" that cites `f-12`, and no fact request is raised for "CI/CD".
- REQ-14.AC-2: Given the same state, When the tailored CV is produced, Then it covers "CI/CD" using that derived fact.

**REQ-15** Each derived fact shall cite the id of every master fact it rests on and keep their `org` and `dates`.
- REQ-15.AC-1: Given a derived fact rests on `f-12` (org "Gradion", dates "2023-2025"), When it is added, Then its record lists source `f-12`, org "Gradion" and dates "2023-2025".
- REQ-15.AC-2: Given a drafted derived fact that cites no master fact, When it is screened, Then it is rejected and not added.

**REQ-16** (removed r2, replaced by REQ-26 to REQ-28 per E-2) Formerly: reject a derived fact naming a number, tool, employer, title or date that none of its cited facts contains.

**REQ-17** If no existing master fact supports or implies in a well-known way a job requirement, then the system shall leave the requirement out of the CV and raise a fact request as it does today.
- REQ-17.AC-1: Given no master fact mentions Kubernetes, a Kubernetes service (for example EKS, GKE or AKS) or a container orchestrator, When the JD requires "Kubernetes", Then no derived fact is added, the CV does not mention Kubernetes, and one fact request with topic "Kubernetes" is raised.

**REQ-18** The system shall add accepted derived facts to the master CV as a new version that Ba can undo.
- REQ-18.AC-1: Given master CV version 14 and 2 accepted derived facts, When they are added, Then the master CV is version 15 with those 2 facts and an Undo action is offered.
- REQ-18.AC-2: Given Ba chooses Undo on version 15, When the Master CV screen reloads, Then the master CV content equals version 14.

**REQ-19** (revised r2) The Master CV screen shall mark each derived fact as added automatically and show the facts it rests on, and for an implied skill, the facts it is implied from.
- REQ-19.AC-1: Given derived fact `f-31` citing `f-12`, When Ba opens the Master CV screen, Then `f-31` shows an "Added automatically" label and a reference to `f-12`.
- REQ-19.AC-2: Given derived fact `f-32` "Redux" implied from `f-3` ("Built the customer portal in React and Next.js"), When Ba opens the Master CV screen, Then `f-32` shows an "Added automatically" label and "Implied from f-3".

**REQ-20** If Ba edits or deletes a fact that a derived fact cites, then the system shall flag that derived fact for Ba on the Master CV screen.
- REQ-20.AC-1: Given derived fact `f-31` cites `f-12`, When Ba deletes `f-12`, Then `f-31` shows "Source fact changed" and is not used in new tailor tasks until Ba keeps or deletes it. [ASSUMPTION]

**REQ-26** (added r2) When a job requirement names a skill that existing master facts do not state but imply through a well-known implication, the system shall add that skill as a derived fact citing the facts it is implied from, without asking Ba.
- REQ-26.AC-1: Given master fact `f-3` "Built the customer portal in React and Next.js" (org "Gradion", dates "2023-2025") and a JD requirement "Redux", When the tailor task runs, Then the master CV gains one derived fact naming Redux that cites `f-3` as implied-from, keeps org "Gradion" and dates "2023-2025", and no fact request is raised for "Redux".
- REQ-26.AC-2: Given master fact `f-7` "Deployed services on EKS with Docker" and a JD requirement "Kubernetes", When the tailor task runs, Then a derived fact naming Kubernetes citing `f-7` as implied-from is added.
- REQ-26.AC-3: Given master facts that name only Python and a JD requirement "Rust", When the tailor task runs, Then no derived fact naming Rust is added and one fact request with topic "Rust" is raised (no well-known implication from Python to Rust).
- REQ-26.AC-4: Given the derived fact from AC-1 was added as master CV version 15, When Ba chooses Undo, Then the master CV content equals version 14 and no Redux derived fact remains.

**REQ-27** (added r2) If a derived fact states a number, year or duration that does not appear in its cited master facts, then the system shall reject that fact.
- REQ-27.AC-1: Given cited fact `f-12` says "6 services", When a derived fact says "10 services", Then it is rejected, not added, and an audit entry names the unsupported number as the reason.
- REQ-27.AC-2: Given cited fact `f-3` (dates "2023-2025") and a JD requirement "3+ years of Redux", When the implied Redux fact is drafted saying "3 years of Redux", Then it is rejected; a draft naming Redux with no duration is accepted.
- REQ-27.AC-3: Given cited fact `f-12` with dates "2023-2025", When a derived fact gives dates "2021-2025", Then it is rejected.
- REQ-27.AC-4: Given cited fact `f-12` says "6 services", When a derived fact says "CI/CD with GitHub Actions for 6 services", Then it is accepted.

**REQ-28** (added r2) If a derived fact names an employer or job title that none of its cited master facts contains, then the system shall reject that fact. [ASSUMPTION] (retained from the removed REQ-16; see OQ-9)
- REQ-28.AC-1: Given cited fact `f-3` with org "Gradion" and title "Frontend Engineer", When a derived fact names title "Tech Lead", Then it is rejected and not added.

## 5. Non-functional requirements

- **NFR-1** The system shall leave at least 1.5 s between two requests to the same source host on a non-browser access path, as the existing feed scanner does (repo map, `adapters/feeds/scanner.ts`). This applies to account API paths as well.
  - Check: Given a scan that sends 3 requests to `remotive.com`, When the request times are compared, Then every gap is at least 1500 ms.
- **NFR-2** (revised r2) No board shall be read through an account API path unless its access record states the terms-of-use clauses on automated access and the account risk (REQ-22.AC-3). Whether a high risk blocks the path is OQ-11; no threshold is set here.
  - Check: Given a board record with an empty account-risk statement, When a scan runs, Then that board is not read through the account API path.
- No latency, availability or cost threshold is set: the inputs give none (OQ-6). Security requirements (token handling, redaction, limits on what automatic updates may change) come from the threat model, not from this document.

## 6. User-visible states

- Search criteria screen, per source (REQ-7): "Public API", "Account API" or "Browser" label; loading shows the existing toggle state with no label until known; error loading sources shows the screen's existing error.
- Scan notices (REQ-5, REQ-6, REQ-10, REQ-25): success shows nothing new; failure shows "<Source> scan failed: <reason>. The other sources go on."; a missing or rejected token names the token (never its value) and, when rejected, asks Ba to renew it in local secret storage; "<Source> adapter broken: <reason>" plus "Automatic repair failed: <reason>" when repair failed.
- Activity log (REQ-11): one entry per repair attempt, adopted or not; empty state shows no entries.
- Master CV screen (REQ-18 to REQ-20, REQ-26): derived fact shows "Added automatically" and its cited facts, or "Implied from <fact ids>" for an implied skill; after adding, an Undo action; flagged fact shows "Source fact changed"; with no derived facts the screen is as today.
- No permission: single local user; no new permission state.

## 7. Assumptions

- [ASSUMPTION] A1: "Extension" in the request means the Chrome browser bridge the Research bot uses for `browser` sources.
- A2: (resolved by E-1) Sources with no public or internal web API keep the browser path (REQ-4).
- [ASSUMPTION] A3: "Skill" means the per-source skill files under `bots/research/skills/source-*/SKILL.md`; bot memory already updates itself and is not changed here.
- A4: (revised by E-2) "Auto extend CV based on what I have" means deriving facts from existing master facts, including skills they imply in a well-known way, never inventing numbers, years or durations (REQ-26, REQ-27).
- [ASSUMPTION] A5: Derived facts are written through the same versioned, undoable path as Ba's fact drafts; README's "Bots only read it" is changed by this request for that path only.
- [ASSUMPTION] A6: The REQ-20 behaviour (flag and hold back) when a cited fact changes.
- [ASSUMPTION] A7: "MCP" in the request is a way a bot may be given an API path as a tool, not a separate tier; the tiers are those of REQ-21.
- [ASSUMPTION] A8: Finding a board's internal web API by observing the site in the browser is research done in this run to fill the access records, not a step of every scan.
- [ASSUMPTION] A9: A missing or rejected account token fails the branch; the system does not fall back to the browser in the same scan (REQ-5.AC-2; OQ-8).

## 8. Open questions

- OQ-1: (resolved by E-1) Access path per board follows REQ-21; the per-board choice comes from the research recorded under REQ-22.
- OQ-2: (resolved by E-1) Browser path for boards with no API (REQ-4).
- OQ-3: Should Ba be able to revert an automatically adopted skill change, as he can undo master CV versions?
- OQ-4: Does "auto update all things" also cover `ROLE.md`, workflows or bot config? NG5 excludes them for now.
- OQ-5: (resolved by E-2) Implied skills are allowed as derived facts (REQ-26).
- OQ-6: Is there a cap on retries, scan time, API cost or LLM quota per scan or per repair attempt?
- OQ-7: Besides master facts, may "what I have" include other material (for example Ba's repositories or past CVs) as evidence for derived facts?
- OQ-8: When the account API path fails (missing or rejected token, changed endpoint), should that scan fall back to the browser instead of failing? A9 assumes no.
- OQ-9: Should employers and job titles stay under the strict rule (REQ-28)? E-2 names only numbers, years and durations; the spec keeps the earlier rule for employers and titles.
- OQ-10: What decides that an implication is "well-known": model judgement recorded per fact, or a list Ba can see and edit? REQ-26 tests only the examples given (React or Next.js to Redux, EKS to Kubernetes) and one clear non-implication.
- OQ-11: If a board's terms forbid automated access or the research rates the account risk high (for example a ban risk on LinkedIn), should that board still use the account API path, or need Ba's approval per board? Recommendation: Ba approves each account-API board after reading its access record.

## 9. Out of scope

Applying through APIs or any other state-changing request to a board (a later change request); new sources; changes to fit scoring, dedupe rules or the scan output shape; automatic edits to ROLE.md, bot.json, workflows or allowed sites; facts not supported or implied by existing master facts; invented numbers, years or durations; changes to the human review gate before applying; automatic repair of account API paths when a board changes its internal API.

## 10. Glossary

- **Source** / **board**: one job board in `SEARCH_SOURCES` (`packages/shared/src/common/sources.ts`).
- **Public API**: a job-read interface the board publishes for outside use, including the feeds the orchestrator reads today.
- **Internal web API**: the HTTP endpoints the board's own website calls to load job data, found by observing the site in the browser.
- **Account API path**: reading a board through its internal web API with Ba's own account token taken from local secret storage.
- **Non-browser access path**: a public API or account API path; it may be fetched by the orchestrator or given to a bot as an MCP tool.
- **Browser path**: the Research bot reading a source in Ba's Chrome with that source's skill.
- **Access record**: the per-board research result of REQ-22.
- **Get endpoint**: an endpoint that only returns job data and changes no state.
- **Apply endpoint**: an endpoint that submits an application; documented, never called in this run.
- **Local secret storage**: the place on Ba's machine where account tokens are kept outside the repository.
- **Skill**: the per-source instructions file `bots/research/skills/source-<source>/SKILL.md`.
- **Adapter broken**: a scan failure marked `adapter broken: <reason>` by the scan check, meaning the page layout no longer matches the skill or parser.
- **Skill repair**: drafting, validating and adopting a new skill after an adapter-broken failure.
- **Master fact**: one entry of `facts[]` in `data/master-cv.yaml`.
- **Derived fact**: a master fact the system adds itself, resting on cited existing master facts.
- **Implied skill**: a skill a master fact does not state but that follows from it through a well-known implication (for example Redux from React or Next.js, Kubernetes from EKS).
- **Fact request**: a CV output entry asking Ba for a fact the master facts lack.
