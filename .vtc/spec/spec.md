# Specification: job research without the browser extension, self-updating skills and CV, and multi-source CV guidance

Run: r20261018-074219 (restarted from the cancelled run r20261017-044722). Source request: `.vtc/runs/r20261018-074219/request.md`. Attachment: `.vtc/state/attachments/r20261018-074219/1-2.png` (VNPT recruiter post). Context: `.vtc/research/repo-map/repo-map.md`.

Revision 3. This revision keeps every requirement id of revision 2 with the same meaning and adds goal G4 and the requirements REQ-29 to REQ-40 from Ba's answer E-5. E-1 and E-2 are applied as in revision 2. No id has been renumbered or reused. Removed ids, never reused: REQ-16 (removed in revision 2 and replaced by REQ-26, REQ-27 and REQ-28).

## 1. Problem

Ba is the only user. The Research bot finds his jobs by driving his own Chrome through the extension for six boards, so a board layout change breaks the scan until a person rewrites that source's skill. His tailored CVs also leave out skills his own work clearly implies, and they follow no recruiter guidance. One recruiter's checklist (the VNPT post) is a single opinion that other HR people may not share. Once this is solved, each board is read through an API wherever one is usable, and source skills repair themselves. Each tailored CV covers what Ba's real facts support or imply. On every run, each tailored CV is reviewed and improved against a set of CV rules. That set is researched from several recruiter sources, records where each rule came from, and is applied to the job's JD. No CV ever states an invented number, date, employer, title or skill.

## 2. Goals

- G1: Scans read each board through the first available of: a public API, the board's internal web API called with Ba's own account token, the browser UI. The choice for each board rests on documented research of its endpoints, its terms of use and the risk to Ba's account. Scans only read (REQ-1 to REQ-7, REQ-21 to REQ-25).
- G2: When a source skill fails its layout check, a new skill is drafted, validated and adopted without Ba editing any file (REQ-8 to REQ-13).
- G3: When existing master facts support a job requirement, or imply it as a skill in a well-known way, the master CV gains a derived fact automatically. That fact names the facts it rests on, can be undone, and is used by the tailored CV (REQ-14, REQ-15, REQ-17 to REQ-20, REQ-26 to REQ-28).
- G4: CV guidance rules are researched from more than one HR or recruiter source, and each rule keeps its sources. The rule set refreshes itself. On every run, each tailored CV is reviewed and revised against the rules that apply to it and against that job's JD, within the truthfulness rules. Details the CV lacks become fact requests to Ba (REQ-29 to REQ-40).

## 3. Non-goals

- NG1: Applying to jobs, including through any board API. The Apply bot, the `apply` step and the human `review` gate of `workflows/job-scan.yaml` stay as they are. Apply endpoints are documented but never called.
- NG2: Adding or removing search sources, or changing `canApply` for any source.
- NG3: Changing how fit is scored, how jobs are deduplicated, or the shape of `ResearchScanOutput`.
- NG4: Inventing experience. A derived fact or a CV revision may not add a number, year, month, duration, employer, title or skill that the cited facts do not contain or imply.
- NG5: Automatically changing `ROLE.md`, `bot.json`, workflow YAML, allowed sites or allowed tools (see OQ-4).
- NG6: Removing the existing fact-request flow.
- NG7: Any request that changes state on a board or on Ba's board account (apply, save, follow, message, profile edit).
- NG8: Changing the QA score weights, the QA pass threshold (total of 80 or more) or the existing QA hard-fail list.
- NG9: Applying a CV guidance rule to the master CV facts themselves. Guidance shapes only the tailored CVs. Master facts change only through fact requests answered by Ba and through derived facts (G3).

## 4. Requirements

### Research through an API (G1)

#### REQ-1
When a scan runs for a source whose chosen access path is a public API or an account API, the system shall read that source's jobs through that path.
- REQ-1.AC-1: Given `remotive` is enabled, Chrome is not running and the Remotive API returns 3 matching postings, When the job-scan workflow runs, Then the `remotive` scan branch completes with those 3 jobs and the run records 0 Chrome tool calls for it.
- REQ-1.AC-2: Given the access record for `itviec` chooses the account API path, Ba's ITviec token is in local secret storage and Chrome is not running, When the job-scan workflow runs, Then the `itviec` branch completes with the jobs the account API returns and records 0 Chrome tool calls.
- REQ-1.AC-3: Given the API returns 0 matching postings, When the scan runs, Then the branch completes with 0 jobs and no error.

#### REQ-2
While a source has a non-browser access path, the system shall not open, navigate or read a tab in Ba's Chrome for that source's scan.
- REQ-2.AC-1: Given `itviec` has a non-browser access path, When its scan task runs, Then the task's transcript contains no `chrome:` tool call and the tools granted for that task include no `chrome:` tool.

#### REQ-3
The system shall pass jobs read through a non-browser access path through the same output validation and deduplication as jobs read through the browser.
- REQ-3.AC-1: Given an API returns a posting without a job URL, When the scan output is validated against `ResearchScanOutput`, Then that posting is rejected and the other postings from the same response are kept.
- REQ-3.AC-2: Given posting URL `https://www.topcv.vn/viec-lam/x/123.html` was found by an earlier browser scan, When an API scan returns the same URL, Then the job list holds one job for that URL after dedupe.
- REQ-3.AC-3: Given an API posting carries only a snippet of the job description, When the scan self-check runs, Then the item fails the existing self-check "Every job has full JD text (not a snippet)" exactly as a browser-read item would.

#### REQ-4
If a source has neither a public API nor an internal web API recorded as usable in its access record, then the system shall scan it through the browser as it does today.
- REQ-4.AC-1: Given the access record for `upwork` chooses the browser path and Chrome is running, When the scan runs, Then the `upwork` branch runs through the Research bot in Chrome with the skill `source-upwork`.

#### REQ-5
If an access path needs a credential that is not in local secret storage, then the system shall fail that source's branch and let the other sources go on.
- REQ-5.AC-1: Given the access record for `linkedin` chooses the account API path and no LinkedIn token is in local secret storage, When the scan runs, Then the `linkedin` branch fails, Lead posts a notice starting "LinkedIn scan failed:" that names the missing LinkedIn token without any token value and ends "The other sources go on.", and the `remotive` branch still completes.
- REQ-5.AC-2: Given the same state, When the scan runs, Then the system sends no request to LinkedIn and does not open LinkedIn in Chrome. [ASSUMPTION] (see OQ-8)

#### REQ-6
If a non-browser access path fails transiently (HTTP 429, HTTP 5xx, connection error or timeout), then the system shall fail only that source's branch once its retries are used up, and give the reason in the notice.
- REQ-6.AC-1: Given the Remote OK API answers HTTP 503 on every attempt, When the scan runs, Then the `remoteok` branch fails, Lead posts "Remote OK scan failed: <reason containing 503>. The other sources go on.", and the other branches complete.
- REQ-6.AC-2: Given the API answers HTTP 503 once and then HTTP 200 with 2 postings, When the scan runs, Then the branch completes with those 2 jobs.
- REQ-6.AC-3: Given the API answers HTTP 401 or 403, When the scan runs, Then the branch fails without a retry and the notice names the authorisation failure.

#### REQ-7
The Search criteria screen shall show, for each enabled source, whether it is read through a public API, an account API or the browser.
- REQ-7.AC-1: Given `remotive` is read through a public API, `itviec` through an account API and `upwork` through the browser, When Ba opens the Search criteria screen, Then the Remotive toggle shows "Public API", the ITviec toggle shows "Account API" and the Upwork toggle shows "Browser".
- REQ-7.AC-2: Given a source's access path changes from browser to account API, When Ba reloads the screen, Then that toggle shows "Account API".

#### REQ-21
The system shall use, for each source, the first access path available in this order: public API, the board's internal web API called with Ba's account token, the browser UI.
- REQ-21.AC-1: Given the access record for a board lists a usable public API and a usable internal web API, When a scan runs, Then that board is read through the public API and its account token is not read.
- REQ-21.AC-2: Given the access record for a board lists no usable public API but a usable internal web API, When a scan runs, Then that board is read through the account API.
- REQ-21.AC-3: Given the access record for a board lists neither, When a scan runs, Then that board is read through the browser.

#### REQ-22
The system shall keep an access record for each of the six browser boards (`topcv`, `itviec`, `vietnamworks`, `linkedin`, `wellfound`, `upwork`). Each record documents five items: whether a public API exists and its job-read endpoints; the internal web API get endpoints found by observing the site in the browser; the apply endpoints found; the terms-of-use clauses on automated access and the risk to Ba's account; and the chosen access path.
- REQ-22.AC-1: Given the research for this run is complete, When the access records are read, Then each of the six boards has a record in which every one of the five items has a value; "none found" is a valid value for an endpoint item.
- REQ-22.AC-2: Given a board's record lists one or more apply endpoints, When the record is read, Then each apply endpoint is marked "documented only, not called".
- REQ-22.AC-3: Given a board's record chooses the account API path, When the record is read, Then it lists at least one internal web API get endpoint and a non-empty account-risk statement.
- REQ-22.AC-4: Given a board's record lists no public API and no internal web API get endpoint, When the record is read, Then its chosen path is "browser".

#### REQ-23
While scanning through a public API or an account API, the system shall send requests only to the get endpoints listed in that board's access record.
- REQ-23.AC-1: Given LinkedIn's access record lists apply endpoint `E-apply` and get endpoint `E-search`, When any number of LinkedIn scans run, Then the recorded requests to LinkedIn include no request to `E-apply`.
- REQ-23.AC-2: Given the same state, When a LinkedIn scan runs, Then every recorded request to a LinkedIn host targets an endpoint listed as a get endpoint in the record.

#### REQ-24
The system shall read a board's account token only from local secret storage.
- REQ-24.AC-1: Given Ba's ITviec token is in local secret storage, When an `itviec` scan runs on the account API path, Then the requests carry that token and the scan completes.
- REQ-24.AC-2: Given no ITviec token is in local secret storage and a token-like value sits in a repository file, When an `itviec` scan runs, Then the branch fails as a missing credential and the repository value is not used.

#### REQ-25
If a board rejects Ba's account token with HTTP 401 or 403 on the account API path, then the system shall tell Ba the token must be renewed.
- REQ-25.AC-1: Given the ITviec account API answers HTTP 401, When the scan runs, Then the `itviec` branch fails without a retry and Lead posts a notice starting "ITviec scan failed:" that names the rejected ITviec token without its value and asks Ba to renew it in local secret storage.

### Self-updating source skills (G2)

#### REQ-8
When a browser-source scan fails as "adapter broken", the system shall draft an updated skill for that source without Ba editing any file.
- REQ-8.AC-1: Given the TopCV scan fails with "adapter broken: no job cards on the results page (layout changed?)", When the failure is recorded, Then exactly one skill-repair attempt for `topcv` starts and Ba is not asked to edit `bots/research/skills/source-topcv/SKILL.md`.
- REQ-8.AC-2: Given a TopCV scan fails as "scan failed" for a transient reason, When the failure is recorded, Then no skill-repair attempt starts.
- REQ-8.AC-3: Given a skill-repair attempt for `topcv` is already running, When a second TopCV "adapter broken" failure is recorded, Then no second attempt starts.

#### REQ-9
Before adopting a drafted skill, the system shall validate it with a scan of that source that passes the scan self-check and the scan output checker.
- REQ-9.AC-1: Given a drafted TopCV skill, When the validation scan returns jobs that pass the self-check and the output checker, Then the drafted skill replaces the previous one and the next TopCV scan uses it.
- REQ-9.AC-2: Given a drafted TopCV skill, When the validation scan fails the self-check, Then the previous skill stays in force unchanged.

#### REQ-10
If a skill repair fails, then the system shall keep the previous skill and report the source as broken together with the repair outcome.
- REQ-10.AC-1: Given a repair attempt whose validation fails, When it ends, Then Lead posts "TopCV adapter broken: <reason>" followed by "Automatic repair failed: <reason>", and the TopCV branch of later scans still runs with the previous skill.

#### REQ-11
The system shall record every skill-repair attempt with the source, the time, the triggering reason, whether it was adopted, and the previous and new skill text.
- REQ-11.AC-1: Given the TopCV skill was repaired and adopted at 2026-10-17T09:00:00Z, When Ba views the activity log, Then one entry shows source TopCV, that time, the "adapter broken" reason and the difference between the previous and new skill.
- REQ-11.AC-2: Given a repair attempt that was not adopted, When Ba views the activity log, Then its entry says it was not adopted and the skill text is unchanged.

#### REQ-12
The system shall not let an automatically adopted skill change put the orchestrator into the degraded start that guards prompt changes.
- REQ-12.AC-1: Given the TopCV skill was repaired and adopted, When the orchestrator restarts, Then it starts without the degraded-start warning for the `research` bot.

#### REQ-13
The system shall limit automatic skill updates to files under `bots/<bot>/skills/`.
- REQ-13.AC-1: Given a skill repair for `topcv` is adopted, When the repository files are compared before and after, Then only files under `bots/research/skills/source-topcv/` differ.
- REQ-13.AC-2: Given a drafted skill also proposes a change to `bots/research/bot.json` (for example a new allowed site), When the repair is adopted, Then `bots/research/bot.json` is unchanged and the activity log entry lists that change as not applied.

### Automatic CV extension from existing facts (G3)

#### REQ-14
When a tailor task finds a job requirement that the master facts do not state but that one or more existing master facts support, the system shall add a derived master fact without asking Ba.
- REQ-14.AC-1: Given master fact `f-12` "Built CI pipelines in GitHub Actions for 6 services" and a JD requirement "experience with CI/CD", When the tailor task runs, Then the master CV gains one derived fact covering "CI/CD" that cites `f-12`, and no fact request is raised for "CI/CD".
- REQ-14.AC-2: Given the same state, When the tailored CV is produced, Then it covers "CI/CD" using that derived fact.

#### REQ-15
The system shall make each derived fact cite the id of every master fact it rests on and keep their `org` and `dates`.
- REQ-15.AC-1: Given a derived fact rests on `f-12` (org "Gradion", dates "2023-2025"), When it is added, Then its record lists source `f-12`, org "Gradion" and dates "2023-2025".
- REQ-15.AC-2: Given a drafted derived fact that cites no master fact, When it is screened, Then it is rejected and not added.

#### REQ-17
If no existing master fact supports or implies a job requirement in a well-known way, then the system shall leave the requirement out of the CV and raise a fact request as it does today.
- REQ-17.AC-1: Given no master fact mentions Kubernetes, a Kubernetes service (EKS, GKE or AKS) or a container orchestrator, When the JD requires "Kubernetes", Then no derived fact is added, the CV does not mention Kubernetes and one fact request with topic "Kubernetes" is raised.

#### REQ-18
The system shall add accepted derived facts to the master CV as a new version that Ba can undo.
- REQ-18.AC-1: Given master CV version 14 and 2 accepted derived facts, When they are added, Then the master CV is version 15 with those 2 facts and an Undo action is offered.
- REQ-18.AC-2: Given Ba chooses Undo on version 15, When the Master CV screen reloads, Then the master CV content equals version 14.

#### REQ-19
The Master CV screen shall mark each derived fact as added automatically and show the facts it rests on, or the facts it is implied from for an implied skill.
- REQ-19.AC-1: Given derived fact `f-31` citing `f-12`, When Ba opens the Master CV screen, Then `f-31` shows an "Added automatically" label and a reference to `f-12`.
- REQ-19.AC-2: Given derived fact `f-32` "Redux" implied from `f-3` ("Built the customer portal in React and Next.js"), When Ba opens the Master CV screen, Then `f-32` shows an "Added automatically" label and "Implied from f-3".

#### REQ-20
If Ba edits or deletes a fact that a derived fact cites, then the system shall flag that derived fact on the Master CV screen.
- REQ-20.AC-1: Given derived fact `f-31` cites `f-12`, When Ba deletes `f-12`, Then `f-31` shows "Source fact changed" and is not used in new tailor tasks until Ba keeps or deletes it. [ASSUMPTION]

#### REQ-26
When a job requirement names a skill that existing master facts do not state but imply through a well-known implication, the system shall add that skill as a derived fact citing the facts it is implied from, without asking Ba.
- REQ-26.AC-1: Given master fact `f-3` "Built the customer portal in React and Next.js" (org "Gradion", dates "2023-2025") and a JD requirement "Redux", When the tailor task runs, Then the master CV gains one derived fact naming Redux that cites `f-3` as implied-from and keeps org "Gradion" and dates "2023-2025", and no fact request is raised for "Redux".
- REQ-26.AC-2: Given master fact `f-7` "Deployed services on EKS with Docker" and a JD requirement "Kubernetes", When the tailor task runs, Then a derived fact naming Kubernetes that cites `f-7` as implied-from is added.
- REQ-26.AC-3: Given master facts that name only Python and a JD requirement "Rust", When the tailor task runs, Then no derived fact naming Rust is added and one fact request with topic "Rust" is raised.
- REQ-26.AC-4: Given the derived fact from REQ-26.AC-1 was added as master CV version 15, When Ba chooses Undo, Then the master CV content equals version 14 and no Redux derived fact remains.

#### REQ-27
If a derived fact states a number, year or duration that does not appear in its cited master facts, then the system shall reject that fact.
- REQ-27.AC-1: Given cited fact `f-12` says "6 services", When a derived fact says "10 services", Then it is rejected and not added, and an audit entry names the unsupported number as the reason.
- REQ-27.AC-2: Given cited fact `f-3` (dates "2023-2025") and a JD requirement "3+ years of Redux", When the implied Redux fact is drafted as "3 years of Redux", Then it is rejected, and a draft naming Redux with no duration is accepted.
- REQ-27.AC-3: Given cited fact `f-12` with dates "2023-2025", When a derived fact gives dates "2021-2025", Then it is rejected.
- REQ-27.AC-4: Given cited fact `f-12` says "6 services", When a derived fact says "CI/CD with GitHub Actions for 6 services", Then it is accepted.

#### REQ-28
If a derived fact names an employer or job title that none of its cited master facts contains, then the system shall reject that fact. [ASSUMPTION] (see OQ-9)
- REQ-28.AC-1: Given cited fact `f-3` with org "Gradion" and title "Frontend Engineer", When a derived fact names title "Tech Lead", Then it is rejected and not added.

### Multi-source CV guidance and automatic CV review (G4)

#### REQ-29
The system shall keep a CV guidance rule set in which every rule names each source it came from.
- REQ-29.AC-1: Given the guidance rule set, When any rule is read, Then it lists at least one source, and each source has a title or publisher, a URL or attachment path, and the date it was retrieved.
- REQ-29.AC-2: Given a drafted rule that names no source, When the rule set is updated, Then that rule is rejected and the rule set is unchanged.

#### REQ-30
The system shall include in the guidance rule set the rules of the attached VNPT recruiter post, each citing that post as a source.
- REQ-30.AC-1: Given the attachment `.vtc/state/attachments/r20261018-074219/1-2.png`, When the rule set is read, Then it holds a rule for each of these eight points, and each rule cites that attachment: (a) education and experience dates give month and year; (b) the most relevant experience comes first; (c) each experience item states what was done, which technologies were used and what result came of it; (d) name, phone and email are present; (e) LinkedIn, GitHub or portfolio links are shown when they exist; (f) the listed skills are those relevant to the JD; (g) no technology is listed without practical experience; (h) the CV is 1 to 2 pages.

#### REQ-31
The system shall draw the guidance rule set from more than one HR or recruiter source.
- REQ-31.AC-1: Given the guidance research for this run is complete, When the sources cited across the rule set are counted, Then there are at least 2 distinct sources other than the VNPT post. [ASSUMPTION] (see OQ-13)

#### REQ-32
When two sources give different advice on the same point, the system shall record each position with its own sources and mark the rule as disputed.
- REQ-32.AC-1: Given source S1 advises a CV of at most 1 page and the VNPT post advises 1 to 2 pages, When the rule set is updated, Then the page-length rule holds both positions, each with its sources, and is marked disputed.

#### REQ-33
While a rule is disputed and no existing CV constraint decides the point, the system shall apply the position cited by the most distinct sources. [ASSUMPTION] (see OQ-14)
- REQ-33.AC-1: Given a disputed rule with position P1 cited by 3 sources and position P2 cited by 1 source, When a tailored CV is reviewed, Then P1 is applied and the review result names P2 as not applied.
- REQ-33.AC-2: Given a disputed rule whose two positions are each cited by 2 sources, When a tailored CV is reviewed, Then neither position is applied and the review result shows the rule as "disputed, not applied".

#### REQ-34
If a guidance rule conflicts with an existing CV constraint (the CV bot's layout and ATS rules or a QA hard fail), then the system shall apply the existing constraint and show the rule as overridden.
- REQ-34.AC-1: Given the QA hard fail `over_one_page` and a guidance rule allowing 1 to 2 pages, When a tailored CV of 2 pages is reviewed, Then QA still hard-fails it with `over_one_page`, and the review result shows the page-length rule as "overridden by over_one_page". (see OQ-12)

#### REQ-35
When a job-scan run reaches its first tailor task, the system shall refresh the guidance rule set from its research once for that run, without Ba editing any file. [ASSUMPTION] (see OQ-15)
- REQ-35.AC-1: Given a job-scan run that tailors CVs for 3 jobs, When the run completes, Then exactly one guidance refresh is recorded for that run and it ended before the first tailor task started.
- REQ-35.AC-2: Given the refresh finds a source that is not yet in the rule set, When the refresh ends, Then rules from that source are added, each citing it.
- REQ-35.AC-3: Given every guidance source is unreachable during the refresh, When the refresh ends, Then the previous rule set stays in force unchanged, tailoring goes on with it, and Lead posts a notice starting "CV guidance refresh failed:".

#### REQ-36
The system shall record every change to the guidance rule set with the time, the rule, the previous and new text, and the sources behind the change.
- REQ-36.AC-1: Given a refresh at 2026-10-18T08:00:00Z adds one rule and changes one, When Ba views the activity log, Then there are 2 entries with that time, each showing the rule, its previous text (empty for the added rule), its new text and its sources.

#### REQ-37
When a tailored CV is drafted for a job, the system shall review it against every applicable guidance rule and against that job's JD before it reaches Ba's review step.
- REQ-37.AC-1: Given a tailored CV for job J, When the review ends, Then the review result gives every rule in the set a status of "met", "not met", "needs fact", "not applicable", "overridden" or "disputed, not applied", and lists each rule's sources.
- REQ-37.AC-2: Given experience fact `f-12` with dates "2023-2025" and no months, When the CV is reviewed, Then the month-and-year rule is "needs fact", one fact request asks Ba for the start and end months of `f-12`, and the CV still shows "2023 – 2025" with no month added.
- REQ-37.AC-3: Given experience fact `f-12` with dates "06/2023-08/2025", When the CV is reviewed, Then the CV shows "06/2023 – 08/2025" and the month-and-year rule is "met".
- REQ-37.AC-4: Given the master CV contact holds no GitHub, LinkedIn or portfolio link, When the CV is reviewed, Then the links rule is "not applicable" and no link appears on the CV.
- REQ-37.AC-5: Given the tailor step produces an English and a Vietnamese CV for job J, When both are reviewed, Then each language has its own review result.

#### REQ-38
When the review finds a rule "not met" that the cited master and derived facts can satisfy, the system shall revise the CV and review it again, within the tailor step's existing limit of 3 rounds.
- REQ-38.AC-1: Given a JD for a Java backend role, master fact `f-1` "Built REST APIs in Java and Spring Boot" and master fact `f-2` "Built UI in React", and a draft CV that lists `f-2` before `f-1`, When the CV is reviewed, Then the most-relevant-first rule is "not met", the CV is revised, and the revised CV lists `f-1` before `f-2`.
- REQ-38.AC-2: Given skill fact "Go" and no experience or project fact that mentions Go, When the CV is reviewed, Then the practical-experience rule is "not met" for Go and the revised CV does not list Go.
- REQ-38.AC-3: Given a rule is still "not met" after round 3, When the tailor step ends, Then the CV goes to Ba's review step with that rule shown as "not met".

#### REQ-39
The system shall keep every CV revision made for a guidance rule within the truthfulness rules: no number, date, employer, title or skill that the cited master or derived facts do not contain.
- REQ-39.AC-1: Given the results rule and experience fact `f-5` "Optimised the order service" with no result figure, When the CV is revised, Then the CV item for `f-5` contains no number or percentage, the results rule is "needs fact" for `f-5`, and one fact request asks Ba for the result of `f-5`.
- REQ-39.AC-2: Given a revision states "reduced response time by 30%" and no cited fact contains "30%", When QA checks the revision, Then it hard-fails with `invented_claim` and that revision is not shown to Ba.

#### REQ-40
At the review step, the system shall show Ba, for each tailored CV, the guidance rules that are "not met", "needs fact" or "disputed, not applied", each with its sources, and the fact requests those rules raised.
- REQ-40.AC-1: Given a tailored CV whose review result has 1 rule "not met" and 1 rule "needs fact" with one fact request, When Ba opens that job at the review step, Then he sees both rules with their source names and the one fact request.
- REQ-40.AC-2: Given a tailored CV whose review result has every rule "met" or "not applicable", When Ba opens that job at the review step, Then he sees "All CV guidance rules met" and no rule list.

## 5. Non-functional requirements

- NFR-1: The system shall leave at least 1.5 s between two requests to the same source host on a non-browser access path, as the existing feed scanner does. This applies to account API paths as well. Check: Given a scan that sends 3 requests to `remotive.com`, When the request times are compared, Then every gap is at least 1500 ms.
- NFR-2: No board shall be read through an account API path unless its access record states the terms-of-use clauses on automated access and the account risk. Check: Given a board record with an empty account-risk statement, When a scan runs, Then that board is not read through the account API path. Whether a high risk blocks the path is OQ-11.
- The inputs set no latency, availability or cost threshold for scans, skill repair or guidance refresh (OQ-6). Security requirements (token handling, redaction, limits on what automatic updates may change, trust in fetched guidance text) come from the threat model, not from this document.

## 6. User-visible states

- Search criteria screen, per source: a "Public API", "Account API" or "Browser" label. While loading, the existing toggle state shows with no label. If loading the sources fails, the screen's existing error shows.
- Scan notices: success adds nothing new. A failure shows "<Source> scan failed: <reason>. The other sources go on.". A missing or rejected token is named, never its value; a rejected token adds a request to renew it in local secret storage. A failed repair shows "<Source> adapter broken: <reason>" and then "Automatic repair failed: <reason>".
- Guidance refresh notice: nothing on success; "CV guidance refresh failed: <reason>" on failure, while tailoring goes on with the previous rules.
- Activity log: one entry for each skill-repair attempt, adopted or not, and one for each guidance rule change. With no entries, the log is empty.
- Master CV screen: a derived fact shows "Added automatically" and its cited facts, or "Implied from <fact ids>" for an implied skill. After facts are added, an Undo action is offered. A flagged fact shows "Source fact changed". With no derived facts, the screen is as it is today.
- Review step, per tailored CV: the rules that are "not met", "needs fact" or "disputed, not applied", with their source names and the fact requests they raised; or "All CV guidance rules met".
- No permission: there is a single local user, so this adds no permission state.

## 7. Assumptions

- [ASSUMPTION] A1: "Extension" in the request means the Chrome browser bridge the Research bot uses for `browser` sources.
- A2: (resolved by E-1) Sources with no public or internal web API keep the browser path.
- [ASSUMPTION] A3: "Skill" means the per-source skill files `bots/research/skills/source-*/SKILL.md`. Bot memory already updates itself and is not changed here.
- A4: (resolved by E-2) "Auto extend CV based on what I have" means deriving facts from existing master facts, including skills they imply in a well-known way, never inventing numbers, years or durations.
- [ASSUMPTION] A5: Derived facts are written through the same versioned, undoable path as Ba's fact drafts. The rule "bots only read" the master CV changes for that path only.
- [ASSUMPTION] A6: When a cited fact changes, the derived fact is flagged and held back (REQ-20).
- [ASSUMPTION] A7: "MCP" in the request is one way to give a bot an API path as a tool, not a separate tier.
- [ASSUMPTION] A8: Finding a board's internal web API by observing the site is research done in this run to fill the access records, not a step of every scan.
- [ASSUMPTION] A9: A missing or rejected account token fails the branch with no fallback to the browser in the same scan.
- [ASSUMPTION] A10: "Multiple HR sources" means at least 2 distinct sources besides the VNPT post (REQ-31).
- [ASSUMPTION] A11: A disputed rule follows the position with the most distinct sources, and a tie applies neither position (REQ-33).
- [ASSUMPTION] A12: Existing CV constraints, such as the one-page hard fail, take precedence over guidance rules (REQ-34).
- [ASSUMPTION] A13: "Each time run" means one guidance refresh per job-scan run, before tailoring starts (REQ-35).

## 8. Open questions

- OQ-1: (resolved by E-1) Access path for each board follows REQ-21, and the choice comes from the access records.
- OQ-2: (resolved by E-1) Boards with no API keep the browser path.
- OQ-3: Should Ba be able to revert an automatically adopted skill change or guidance rule change, as he can undo master CV versions?
- OQ-4: Does "auto update all things" also cover `ROLE.md`, workflows or bot config? NG5 excludes them for now.
- OQ-5: (resolved by E-2) Implied skills are allowed as derived facts.
- OQ-6: Is there a cap on retries, scan time, API cost or LLM quota for each scan, repair attempt or guidance refresh?
- OQ-7: Besides master facts, may "what I have" include other material, such as Ba's repositories or past CVs, as evidence?
- OQ-8: When the account API path fails, should that scan fall back to the browser instead of failing? A9 assumes it should not.
- OQ-9: Should employers and job titles stay under the strict rule of REQ-28? E-2 names only numbers, years and durations.
- OQ-10: What decides that an implication is "well-known": model judgement recorded for each fact, or a list Ba can see and edit?
- OQ-11: If a board's terms forbid automated access or its account risk is high, should it still use the account API path, or should Ba approve each such board? Recommendation: Ba approves each account-API board after reading its access record.
- OQ-12: Should the tailored CV stay at one page (the QA hard fail `over_one_page`), or may it be up to 2 pages as the VNPT post advises? Changing this would be a change to QA (NG8).
- OQ-13: How many guidance sources, and which kinds (Vietnamese IT recruiters, global recruiters, ATS vendors), make a sufficient rule set?
- OQ-14: How should disputes between sources be settled: by source count (A11), by a source weighting, or by Ba's choice?
- OQ-15: Should the guidance rule set refresh on every run (A13), on a schedule, or only when it is older than a set age?

## 9. Out of scope

- Applying through APIs, and any other request that changes state on a board.
- New sources.
- Changes to fit scoring, dedupe rules, the scan output shape, the QA scores, the QA pass threshold or the QA hard fails.
- Automatic edits to `ROLE.md`, `bot.json`, workflows or allowed sites.
- Facts that existing master facts neither support nor imply.
- Invented numbers, months, years, durations, employers, titles or skills.
- Changes to the human review gate before applying.
- Automatic repair of account API paths when a board changes its internal API.
- Applying guidance rules to the master facts.

## 10. Glossary

- **Source** / **board**: one job board in `SEARCH_SOURCES` (`packages/shared/src/common/sources.ts`).
- **Public API**: a job-read interface the board publishes for outside use, including the feeds the orchestrator reads today.
- **Internal web API**: the HTTP endpoints the board's own website calls to load job data, found by observing the site in the browser.
- **Account API path**: reading a board through its internal web API with Ba's own account token taken from local secret storage.
- **Non-browser access path**: a public API or account API path.
- **Browser path**: the Research bot reading a source in Ba's Chrome with that source's skill.
- **Access record**: the research result for one board, as REQ-22 defines it.
- **Get endpoint**: an endpoint that only returns job data and changes no state.
- **Apply endpoint**: an endpoint that submits an application. It is documented, never called.
- **Local secret storage**: the place on Ba's machine where account tokens are kept outside the repository.
- **Skill**: the per-source instructions file `bots/research/skills/source-<source>/SKILL.md`.
- **Adapter broken**: a scan failure marked `adapter broken: <reason>`, meaning the page layout no longer matches the skill or parser.
- **Skill repair**: drafting, validating and adopting a new skill after an adapter-broken failure.
- **Master fact**: one entry of `facts[]` in `data/master-cv.yaml`.
- **Derived fact**: a master fact the system adds itself, resting on cited existing master facts.
- **Implied skill**: a skill a master fact does not state but that follows from it through a well-known implication (for example Redux from React or Next.js, or Kubernetes from EKS).
- **Fact request**: a CV output entry that asks Ba for a fact the master facts lack.
- **Guidance source**: an HR or recruiter publication (an article, a post or the attached VNPT post) from which CV rules are taken.
- **Guidance rule**: one piece of CV advice in the rule set, with the sources it came from.
- **Disputed rule**: a guidance rule on which sources give different advice.
- **Existing CV constraint**: a layout or ATS rule in `bots/cv/ROLE.md` or a QA hard fail in `bots/qa/ROLE.md`.
- **Applicable rule**: a guidance rule whose condition holds for the CV being reviewed (for example, the links rule applies only when Ba has a link).
- **Review result**: the status of each guidance rule for one tailored CV in one language.
