# CV auto-extend: derived facts from what Ba already has

- **Date:** 2026-10-19
- **Status:** Draft, awaiting owner review
- **Owner:** Ba Huynh
- **Scope:** sub-project 2 of 4 from the request in `.vtc/runs/r20261018-074219/request.md`. Sub-project 1 (API research, `2026-10-19-api-research-design.md`) is built first. After this one: multi-source CV guidance (`2026-10-19-cv-guidance-design.md`), then skill self-repair (`2026-10-19-skill-self-repair-design.md`).
- **Reference material (reused, not driven):** the approved VTC spec `.vtc/spec/spec.md` (goal G3: REQ-14, REQ-15, REQ-17 to REQ-20, REQ-26 to REQ-28), AD-1 and AD-9 in `.vtc/architecture/spine.md`, SEC-15 to SEC-19 in `.vtc/architecture/threat-model/threat-model.md`, and the Master CV design (`.vtc/design/screens/master-cv.md`, components `derived-fact-card`, `derived-undo-bar`, `rejected-drafts`, `fact-request-card`, prototype `.vtc/design/prototype/cv/index.html`). This work is done directly, not through the VTC engine. Where this document and those files disagree, this document wins. The differences are listed in §9.

---

## 1. Intent

### 1.1 Why
Ba's tailored CVs leave out things his own facts already prove. A JD asks for "CI/CD" and his master CV says "Built CI pipelines in GitHub Actions for 6 services", but because no fact literally says "CI/CD", the CV bot raises a fact request and leaves it out. A JD asks for "Redux" and his facts say he built a React and Next.js portal. Today Ba has to answer each of these by hand, job after job. He asked for the CV to "auto update based on what I have, auto-extended to match requirements", with no human step, and without ever inventing anything.

### 1.2 What success looks like
1. A JD requirement that Ba's facts support or imply in a well-known way is covered on the tailored CV in the same run, with no question to Ba.
2. Every automatically added fact says which of Ba's facts it rests on, keeps their organisation and dates, and can be undone or deleted in one click.
3. Nothing added states a number, date, duration, employer or title that the cited facts do not contain. This is enforced by code, not by the prompt.
4. A requirement nothing supports still becomes a fact request, as today.
5. The added cost is close to zero on most jobs: no LLM call when the fit step found no gaps, or when every gap is resolved by the known implication table. At most one extra tool-less call per job otherwise.
6. Once a fact is derived it stays in the master CV, so the next job with the same requirement needs no derivation at all.

## 2. Goals, non-goals, anti-goals

### Goals
- **G1. Derive, don't ask.** For each top job, the gaps the fit step already found are checked against Ba's facts. A gap that is supported (`supports`) or implied (`implied_from`) becomes a derived master fact, added without asking Ba. (REQ-14, REQ-26.)
- **G2. Provenance.** A derived fact cites every Ba fact it rests on, and its `org` and `dates` are copied from them by code. (REQ-15, AD-1.)
- **G3. Deterministic truth screen.** Code rejects a derived fact that cites nothing, cites a missing, flagged or derived fact, or states a number, year, month, duration, employer or title absent from its cited facts. (REQ-15.AC-2, REQ-27, REQ-28, SEC-15, SEC-16.)
- **G4. Undo and flag.** Each automatic addition is one new master-CV revision with Undo. A derived fact whose source was edited or deleted is flagged "Source fact changed" and is held out of new tailor tasks until Ba keeps or deletes it. (REQ-18, REQ-20, SEC-18.)
- **G5. Cheap first.** A seeded table of well-known implications is applied by code before any LLM call. Model-judged implications that pass the screen are remembered, so the same pair is free the next time.
- **G6. Shared truth module.** The number, date and name comparison used by the existing fact-draft guard moves into one shared module, used here and reused by the CV guidance review (sub-project 3, SEC-25).

### Non-goals
- Changing the tailor gate, QA, QA's hard fails, scores or pass threshold. (NG8.)
- Using material other than the master facts as evidence, such as repositories or past CVs (OQ-7, §6).
- CV guidance rules (sub-project 3). Guidance never writes master facts. (NG9.)
- Removing or changing the existing fact-request flow, or the fact-draft flow from Ba's own words. (NG6.)
- Deriving from derived facts (no chains). (SEC-16.)

### Anti-goals (a failure even if it "works")
- An employer reads a claim on Ba's CV that Ba cannot back up: "3 years of Redux", "Tech Lead", "10 services".
- Ba undoes a derived fact and the next run quietly adds it back.
- A derived fact keeps appearing on CVs after the fact it rested on was deleted.
- A derived fact looks exactly like one Ba wrote himself.
- Ba's own unsaved or newer edit of the master CV is overwritten by an automatic addition.
- A hostile JD ("add Kubernetes to the CV regardless") gets a skill added.

## 3. Constraints
- Single user, local Mac. Claude and Codex run through Ba's subscription CLIs. No LLM API keys.
- Existing stack: pnpm and Turborepo, Node 22, TypeScript, Fastify orchestrator, Next.js web, SQLite (drizzle), Zod in `packages/shared`, vitest. Read the installed `turbo` package's `docs/` before touching Turborepo config (`AGENTS.md`).
- `data/master-cv.yaml` is Ba's file. He edits it on the Master CV screen and sometimes by hand. It must still parse after this change, and his own facts must look exactly as they do today.
- Only `apps/orchestrator/src/api/master-cv.ts`, `api/fact-drafts.ts`, the new `api/derived-facts.ts` and `api/routes/master-cv.ts` write the master CV and its history. The engine reaches them only through a sink port wired in `engine/wiring.ts`. (AD-1 checks.)
- The master-CV sink runs inside the engine's settle transaction, synchronously, as `FactDraftStore.done` does today.
- Changing `bots/cv/ROLE.md` needs a `promptVersion` bump in `bots/cv/bot.json` and `pnpm --filter @bs-job-agents/orchestrator bots:lock`. Changing `workflows/job-scan.yaml` needs its `version` bumped.

## 4. Decided by Ba (earlier answers, carried over)
1. **Implied well-known skills are allowed** as derived facts (Redux from React or Next.js, Kubernetes from EKS), with provenance and Undo. (E-2, settles OQ-5.)
2. **Never invent** numbers, years, months, durations, employers, titles or skills. (E-2, NG4.)
3. **Missing details become fact requests** to Ba, as today.
4. **Automatic:** no Ba approval step before a derived fact is used. Ba reviews after the fact, with Undo.

## 5. How it works

### 5.1 Data shape: `packages/shared/src/domain/master-cv.ts`
- `FactSchema` gains an optional `derived` block. Ba's own facts have none, so existing files parse unchanged.

  ```yaml
  - id: grad-d1
    type: skill
    text: Redux
    textVi: Redux
    tags: [redux]
    org: Gradion            # copied from the cited fact by code
    dates: Feb 2024 – Sep 2025   # copied from the cited fact by code
    derived:
      restsOn:
        - { factId: grad-3, relation: implied_from, sourceHash: 9f2c… }
      via: table            # table | model
      rationale: Redux is the common state library for React and Next.js apps.
      requirement: Redux    # the JD gap it answers
      jobId: "123"
      taskId: "456"         # null for a table derivation
      derivedAt: 2026-10-19T08:00:00Z
  ```

- `sourceHash` is a hash of the cited fact's `text`, `org` and the **years** in its `dates`, taken at derivation time. `textVi` and month detail are left out on purpose: when Ba fixes a translation, or adds months to "2023 – 2025" because a guidance fact request asked for them (sub-project 3), the derived facts resting on it are not flagged. A real change of text, org or years is flagged. **Status is computed, not stored.** A pure `derivedStatus(cv, fact)` returns `active`, or `source_changed` when a cited fact is missing or its hash differs. This also catches Ba's hand edits of the YAML, which the API never sees. *(Leader's call: AD-1 stores the status; computing it is simpler and cannot go stale.)*
- `org` and `dates` of a derived fact: when all cited facts share one `org`, that org; otherwise null. `dates` likewise, or the span from the earliest to the latest cited dates when they are all in one org. Never from the bot.
- Derived fact ids use the prefix of the first cited fact plus `-d<n>` (e.g. `grad-d1`), made unique by the existing `withFreeFactIds`.
- `MasterCvSchema` refinement: a `derived.restsOn` entry may not cite another derived fact.

### 5.2 Shared truth module: `packages/shared/src/truth/`
- Move `numbersIn`, `allowedNumbers`, `capitalisedNames` and the number words out of `bots/fact-draft.ts` into `truth/claims.ts`. `screenDraftedFacts` keeps its behaviour and its tests.
- Extend the number comparison to the forms SEC-15 names: spelled-out numbers (EN and VI), `3+`, `3yrs`, `a decade`, `half a year`, year ranges like `2021-25`, month names and numbers (`Jun 2023` equals `06/2023`), `Present`/`hiện tại`.
- Add `durationsIn(text)`: any phrase giving a length of time ("3 years", "18 months", "since 2021"). A derived fact may state a duration only if the same duration appears in a cited fact's text.
- Add `titlesIn(text)`: a closed list of job-title words (Lead, Senior, Principal, Head, Manager, Architect, Director, CTO, Engineer, Developer and their Vietnamese forms). A derived fact may name a title only if a cited fact contains it.
- All pure, no I/O, so the guidance review (sub-project 3) can run the same check on whole CVs.

### 5.3 Implication table: `packages/shared/src/cv-derive/implications.ts` plus `data/skill-implications.json`
- **Seeded table** in code: `{ skill, aliases[], category, impliedBy[] }`, small and obvious. A separate term-to-category map covers common technologies; the screen uses it (§5.6). For example:
  - Kubernetes from EKS, GKE, AKS, OpenShift
  - Redux from React, Next.js
  - JavaScript from TypeScript, React, Vue, Angular, Node.js, Next.js
  - HTML and CSS from React, Vue, Angular, Next.js
  - SQL from PostgreSQL, MySQL, SQL Server, Oracle
  - CI/CD from GitHub Actions, GitLab CI, Jenkins, CircleCI
  - REST APIs from Spring Boot, Express, NestJS, FastAPI, Django REST
  - Git from GitHub, GitLab, Bitbucket

  The builder writes the final seed. Each entry must be a relation that a recruiter would not question.
- **Learned entries** live in `data/skill-implications.json` (Ba's runtime data, gitignored with the rest of `data/`): `{ allow: [{ skill, impliedBy, firstSeen, factId }], deny: [{ skill, restsOn: [factId], at }] }`.
  - A model-judged implication that passes the screen is appended to `allow`, so the same pair is resolved by code next time.
  - Undo of a derived fact, or Delete of one, appends its `(skill, restsOn)` to `deny`. A denied pair is never derived again, and that gap goes back to being a fact request. This is what stops an undone fact from coming back on the next run.
- **OQ-10 resolved:** "well-known" is decided by the seeded table first, then by the model's judgement with a recorded `rationale`, under a deterministic anchor check (§5.5). Every model-judged implication is visible on the Master CV screen with its rationale and can be undone, which also blocks it for good. *(Leader's call — Ba can override.)*

### 5.4 The workflow step: `workflows/job-scan.yaml`
- A new branch step `derive` after `company` and before the `tailor` gate. Workflow `version` bumped.
- Step type: a new deterministic-first step. The engine (`apps/orchestrator/src/engine/derive.ts`):
  1. Reads the job's `gaps` (already on the `top` output; `filters.ts` passes `gaps: j.gaps ?? []`). **No gaps: the step settles at once with no task.**
  2. Reads the current master CV and its active Ba facts (no derived, no `source_changed`).
  3. Drops gaps already covered by any active fact, Ba's or derived (case-folded match on text, tags and implication aliases). This is how earlier derivations make later jobs free.
  4. Drops gaps in the `deny` list.
  5. **Table pass (no LLM):** for each remaining gap that matches a table skill or learned `allow` entry, finds Ba facts whose text or tags contain an `impliedBy` term (word-boundary, case-folded). If found, it builds the derived fact itself (`via: table`, text is the skill name, type `skill`).
  6. **Model pass:** only if gaps remain, it queues one `cv.derive` task (§5.5). Otherwise the step ends.
  7. All drafts go through `screenDerivedFacts` (§5.6), then the sink (§5.7).
- The step never fails the branch. A failed `cv.derive` task (after its attempts) is logged, the step ends with the table-pass facts only, and tailoring goes on. The tailor bot raises fact requests for the rest, as today.
- The `cv.tailor` task input is built when the tailor task is created, after `derive` settled, so it sees the new revision (REQ-14.AC-2).

### 5.5 The `cv.derive` task
- New CV task kind `derive` in `bots/cv/bot.json`: `outputSchema.derive: "DeriveOutput"`, `selfCheckByKind.derive`, and **no tools** (no Figma, no files, no browser), like `fact_draft`. A `## Derived facts (task derive)` section in `bots/cv/ROLE.md`. `promptVersion` 5 → 6 and the lock updated.
- Input, all inline (no master-CV copy needed): the remaining gaps, the JD's requirement lines, and the active Ba facts (id, type, text, tags, org, dates). The JD is data in its own user message (untrusted-content rule).
- Output `DeriveOutput` (`packages/shared/src/bots/derive.ts`), strict: `drafts[]` of `{ requirement, text, textVi, type: skill | experience, tags, restsOn[{ factId, relation }], fromTerms[], rationale }`, at most 5, plus the bot envelope. `fromTerms` are the exact words in the cited fact that carry the support or implication (e.g. `["React", "Next.js"]`).
- Role rules: only Ba's facts as evidence; prefer `type: skill` with the bare skill name; no number, date, duration, title or employer unless copied verbatim from a cited fact; return nothing for a gap you cannot support, so tailor raises the fact request.
- Model: the bot's default (`sonnet`). The builder may set a cheaper model for this kind if the runner supports per-kind models.

### 5.6 The screen: `packages/shared/src/bots/derive.ts` → `screenDerivedFacts(drafts, ctx)`
Pure, no I/O (AD-9 checks). `ctx` holds the active Ba facts, the existing derived facts and the deny list. A draft is rejected, with a reason, when:
- it cites no fact, or a fact that does not exist, is derived, or is `source_changed` (REQ-15.AC-2, SEC-16.AC-1/AC-2)
- a `fromTerms` entry does not occur in the cited fact's text or tags (the anchor check: the model must point at Ba's own words)
- the requirement and a `fromTerms` entry both have a known category in the table (`frontend`, `backend`, `cloud_devops`, `data`, `mobile`, `testing`, `ai_ml`) and the categories differ. For example "Kubernetes implied from Java" is rejected. Terms with no known category pass this check. This is the code backstop against a hostile JD or an over-eager model (SEC-16.AC-4)
- it states a number, year, month or duration not in its cited facts, after normalising (REQ-27, SEC-15). "CI/CD with GitHub Actions for 6 services" passes when `f-12` says "6 services" (REQ-27.AC-4); "3 years of Redux" fails (REQ-27.AC-2)
- it names a title or employer that none of its cited facts contains (REQ-28, OQ-9)
- it names a capitalised tool or technology that is neither the requirement, an implication-table term, nor in its cited facts
- its requirement is already covered by an active fact, or the `(skill, restsOn)` pair is denied
- it is the 6th or later accepted draft for this job (SEC-16.AC-3)

The bot's `org` and `dates` are ignored; code fills them (§5.1). Rejections write one `derive.rejected` audit event with fact ids and reasons only, never contact data (SEC-15.AC-4).

### 5.7 The sink: `apps/orchestrator/src/api/derived-facts.ts`
- `DerivedFactStore implements DerivedFactSink`, sibling of `FactDraftStore`, wired in `engine/wiring.ts`. It runs in the settle transaction.
- **Staleness (SEC-17):** it re-reads the current master CV, re-runs `screenDerivedFacts` against it (Ba may have saved since), and keeps only what still passes. Dropped drafts get an audit entry. It never writes over a newer revision; it always appends to the current one.
- **Concurrency:** several job branches can derive in one run. Each add is its own revision. A draft whose requirement another branch has just covered is dropped by the re-screen.
- Accepted facts are appended as one new revision through `keepMasterCvVersionSync` and `writeMasterCvSync`, keeping the previous revision in history first, as `FactDraftStore.done` does. It emits `master_cv.updated` with a new `change: "facts_derived"` and the fact ids.
- It records the addition (task id, job id, fact ids, version, previous version) next to the fact drafts in `data/api-state.json` as `derivedAdds`. *(Builder's call: api-state or SQLite.)*
- Learned implications are appended to `data/skill-implications.json` here, in the same settle.

### 5.8 Undo, Keep, Delete: `api/routes/master-cv.ts`
All new routes sit under the existing Origin and CSRF check (SEC-19).
- `POST /master-cv/derived/undo { version }`: undoes one automatic addition.
  - If it is still the latest revision, the content is restored to the revision before it exactly (REQ-18.AC-2, REQ-26.AC-4).
  - If Ba or another branch saved since, it writes a new revision that removes exactly the facts that addition added and nothing else. *(Leader's call: the existing fact-draft Undo refuses in that case. With several automatic additions per run, refusing would make most of them un-undoable.)*
  - Undone pairs go to `deny`.
- `POST /master-cv/derived/:factId/keep`: Ba vouches for a flagged fact.
  - If all cited facts still exist, the hashes are re-anchored and the fact is active again.
  - If a cited fact was deleted, the `derived` block is removed and the fact becomes Ba's own. Ba has vouched for it, and it no longer has a source to point at. *(Leader's call.)*
- Delete uses the existing fact delete. For a derived fact, it also adds the pair to `deny`.

### 5.9 Holding flagged facts out of tasks (SEC-18)
- The per-task master-CV copy (`engine/queue.ts`, `MASTER_CV_TASK_KEYS`) becomes a filtered projection: it drops `source_changed` derived facts and the `derived` block's internals (only `derived: true` and `restsOn` ids remain, so bots see a fact is derived). This is the same file for `research.fit`, `cv.tailor` and `qa.review`, so QA judges against exactly what tailor could cite.
- After a `cv.tailor` output settles, code checks `citedFactIds` against the projection. A cited id that is unknown or flagged fails the attempt with a clear reason, and it is retried under the existing rules (SEC-18.AC-2).

### 5.10 Telling Ba
- The run's existing summary notice gains one line when facts were derived: "Added 3 facts to your master CV automatically (Redux, CI/CD, Kubernetes). Review or undo them on the Master CV screen." One line per run, not per job. *(Leader's call.)*
- No Lead notice for rejected drafts. They show in the "Not added" region of the Master CV screen.

## 6. Open questions resolved here
- **OQ-7 (other material as evidence):** No. Master facts stay the only evidence, because every truth check depends on citing them. Ba can already turn a past CV or a README into facts by pasting it into the existing "Tell CV something new" fact-draft flow, which runs the invented-detail guard. Reading GitHub repos automatically could be a later sub-project with its own screen. *(Leader's call — Ba can override.)*
- **OQ-9 (employers and titles strict):** Yes, strict. A wrong title or employer is the most damaging false claim in an interview, and implication never yields a title. *(Leader's call — Ba can override.)*
- **OQ-10 ("well-known"):** the seeded table plus model judgement, with a deterministic anchor, a visible rationale and a learned allow and deny list (§5.3). *(Leader's call — Ba can override.)*
- **OQ-6 (caps), this sub-project's part:** at most one `cv.derive` task per job per run, none when there are no gaps left after the table pass. At most 5 derived facts per job. The `cv.derive` timeout is the CV bot's 600 s. *(Leader's call — Ba can override.)*
- **OQ-3 (revert), for derived facts:** already covered by Undo and Delete, and made permanent by the deny list.

## 7. UI states (Master CV screen, `apps/web/components/cv/`)
Built from `.vtc/design/screens/master-cv.md` and its components, in the existing screen's style and tokens. The prototype `.vtc/design/prototype/cv/index.html` is reference.
- **Derived fact card** (extends `FactCard`): meta line, text, then a provenance line: "Added automatically", then "Rests on grad-12" or "Implied from grad-3". The ids are links that scroll to and focus the cited fact. The rationale shows in a small disclosure "Why", as plain text. Edit keeps the label, and the sources show read-only in the editor.
- **Undo bar** (extends `AddedBar`): "Added 2 facts automatically (change 15)." with a badge per fact and Undo. One bar for each addition not yet undone since Ba last opened the screen, newest first, at most 3, then "and N more in the history". Error: "Could not undo. Reload the screen to see its current content."
- **Undone:** toast "Undone: back to change 14." (or "Removed Redux, CI/CD (change 17)." when it was not the latest), and the list updates.
- **Source changed:** "Source fact changed", then "Not used in new tailor tasks until you keep or delete it", with Keep and Delete inline.
- **Not added (n):** a collapsed region listing rejected drafts and their reasons, e.g. "Not added: says 10 services; grad-12 says 6 services." It is read from the audit events for the latest run.
- **Fact request:** unchanged. A gap with no derived fact keeps its request card.
- **Empty, loading, error:** as today and as in the design file.

## 8. Test strategy
vitest, following the repo's conventions. Each item names the acceptance criteria it covers.
- `packages/shared/src/truth/claims.test.ts`: number, duration, month and title normalisation, table-driven. Covers SEC-15.AC-1/AC-2/AC-3 and the `Feb 2024 – Sep 2025` / `06/2023` forms in Ba's real file. Existing `fact-draft.test.ts` still passes unchanged.
- `packages/shared/src/bots/derive.test.ts`: REQ-15.AC-2, REQ-26.AC-1 to AC-3, REQ-27.AC-1 to AC-4, REQ-28.AC-1, SEC-16.AC-1 to AC-3, the anchor check, the deny list, the duplicate-coverage drop.
- `packages/shared/src/domain/master-cv.test.ts`: the `derived` block parses; existing files parse; a derived fact citing a derived fact is refused; `derivedStatus` covers delete, text edit, org edit and a change of years (REQ-20.AC-1), and does not flag on a `textVi` edit or on months added to the same years.
- `packages/shared/src/cv-derive/implications.test.ts`: the table pass derives Kubernetes from "Deployed services on EKS with Docker" (REQ-26.AC-2) with no task; "Rust" from Python-only facts derives nothing (REQ-26.AC-3).
- `apps/orchestrator/src/engine/derive.test.ts`: REQ-14.AC-1/AC-2 (CI/CD from `f-12`, the tailor input holds the derived fact); REQ-17.AC-1 and SEC-16.AC-4 (Kubernetes with no container fact: the table pass finds no anchor, a stubbed `cv.derive` returns a Kubernetes draft anyway and the screen rejects it, no fact is added, and tailor raises one fact request); no gaps means no task; a failed derive task still reaches tailor.
- `apps/orchestrator/src/api/derived-facts.test.ts`: REQ-15.AC-1 (org and dates copied), REQ-18.AC-1/AC-2, REQ-26.AC-4, SEC-17.AC-1 (Ba saved revision 15 first: his content intact, the draft re-screened), Undo when not latest, Keep (both cases), deny on undo and delete, and no re-derivation on the next run.
- `apps/orchestrator/src/engine/queue.test.ts` (or a new test): SEC-18.AC-1 (the flagged fact is absent from the task copy) and SEC-18.AC-2 (a CV citing it fails the attempt).
- Route tests: SEC-19.AC-1 for undo and keep.
- `bots/cv/bot.json` and the lock: `prompt-lock.test.ts` passes after the bump; `SEC-17.AC-2` (no CV write tool can target `data/master-cv.yaml`).
- Web: component tests for the derived card, undo bar, flagged state and "Not added" region. Screenshots of each state for the PR.
- **Live check (QA):** one scan on Ba's real master CV. The PR shows what was derived, from which facts, and that QA passed the tailored CVs.

## 9. Differences from the VTC spec and architecture
| VTC item | Here |
|---|---|
| AD-1: `derived.status` stored and recomputed on every write | Status computed on read from stored source hashes; also catches hand edits (§5.1) |
| AD-9: `cv.derive` gets "the job's requirements" and runs for every job | Input is the fit step's gaps; table pass first; no task when nothing is left (§5.4) |
| AD-9: "well-known" left to the model, OQ-10 open | Seeded table, then model with anchor check, learned allow and deny list (§5.3) |
| REQ-18 Undo restores the previous version | Same when it is the latest; otherwise removes exactly the added facts (§5.8) |
| REQ-20 "keep or delete" undefined | Keep re-anchors, or makes the fact Ba's own when its source was deleted (§5.8) |
| Not in spec | Undone or deleted derived facts are never re-derived (deny list) |
| Not in spec | One summary line per run about derived facts (§5.10) |

## 10. Left to the builder
- The exact seed of the implication table, within "a recruiter would not question it".
- Where `derivedAdds` live (api-state or SQLite), and the route response shapes.
- Whether `derive` is a new step type or a `task` step with an engine pre-pass. The behaviour in §5.4 must hold either way.
- The id prefix rule for derived facts, if `-d<n>` clashes with existing ids.
- Whether the runner supports a per-kind model for `cv.derive`.
- Test layout inside the folders named above.
