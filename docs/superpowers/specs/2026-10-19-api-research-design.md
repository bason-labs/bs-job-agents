# API research: read job boards through APIs instead of Chrome

- **Date:** 2026-10-19
- **Status:** Draft, awaiting owner review
- **Owner:** Ba Huynh
- **Scope:** sub-project 1 of 4 from the request in `.vtc/runs/r20261018-074219/request.md`. The other three (self-repairing source skills, automatic CV extension, multi-source CV guidance) are separate designs, done later in this order: CV extension, CV guidance, skill self-repair.
- **Reference material (reused, not driven):** the approved VTC spec `.vtc/spec/spec.md` (goal G1: REQ-1 to REQ-7, REQ-21 to REQ-25, NFR-1, NFR-2) and the architecture decisions AD-2 to AD-6 in `.vtc/architecture/spine.md`. This work is done directly, not through the VTC engine. Where this document and those files disagree, this document wins. The differences are listed in §6.

---

## 1. Intent

### 1.1 Why
Ba wants job scans to be **faster and cheaper**. Today the Research bot reads six boards (TopCV, ITviec, VietnamWorks, LinkedIn, Wellfound, Upwork) by driving Ba's own logged-in Chrome through Claude in Chrome. Every page's text goes into a Claude session, and a single `read_page` can be about 200k characters (`bots/research/memory.md`). That is slow, uses up Claude subscription quota, and breaks when a board changes its layout.

The four feed boards (Remote OK, We Work Remotely, Remotive, Jobspresso) already show the better way. The orchestrator fetches them in plain code (`apps/orchestrator/src/adapters/feeds/`), and only the later fit step uses an LLM.

### 1.2 What success looks like
1. Every one of the six boards that has a usable API is scanned with **zero Chrome tool calls and zero Claude sessions** for the scan itself. Fit scoring is unchanged and still uses Claude.
2. Ba can see on the Search criteria screen how each board is read.
3. A risky board is never read through Ba's account until Ba has read its research and approved it.
4. A missing or expired token never stops a scan. The scan falls back to the browser and tells Ba to renew the token.
5. The PR shows before and after numbers for one scan: wall-clock time, Chrome tool calls and Claude sessions per source.

## 2. Goals, non-goals, anti-goals

### Goals
- **G1. Access path per board.** Each board is read through the first usable path in this order: public API, then the board's internal web API called with Ba's own account token (the "account API"), then the browser. (Spec REQ-21.)
- **G2. Research per board.** For each of the six browser boards, an access record documents:
  - the public API, if any, and its job-read endpoints
  - the internal GET endpoints the site itself uses, found by watching its network traffic while logged in
  - any apply endpoints, documented only and never called
  - the terms-of-use clauses on automated access
  - the risk to Ba's account
  - a risk level
  - the chosen path

  (Spec REQ-22.)
- **G3. Code fetches, not a bot.** On API paths the orchestrator makes the requests itself. No LLM sees tokens or raw responses. (AD-5.)
- **G4. Read-only and polite.** Only GET endpoints listed in the record are allowed. There are at least 1.5 s between requests to one host. (REQ-23, NFR-1, AD-2.)
- **G5. Same downstream.** API jobs pass the same validation, self-check and dedupe as browser jobs, and `ResearchScanOutput` keeps its shape. (REQ-3, AD-6.)
- **G6. Labels.** The Search criteria screen shows "Public API", "Account API" or "Browser" per source. A risky board that is not yet approved shows "Account API (needs approval)". (REQ-7, extended.)

### Non-goals
- Applying through any API, or any request that changes state (apply, save, follow, message, profile edit). (Spec NG1, NG7.)
- Changing fit scoring, dedupe or the `ResearchScanOutput` shape. (NG3.)
- Adding or removing sources, or changing `canApply`. (NG2.)
- Exposing boards as MCP tools. "MCP" in the request is satisfied by the orchestrator calling the APIs directly, which is cheaper than handing a bot an MCP tool. (Spec A7.)
- Capturing tokens automatically from Chrome's cookie store. This is a possible follow-up.
- The other three sub-projects.

### Anti-goals (a failure even if it "works")
- Ba's LinkedIn, or any other account, gets restricted because the app hit a `high`-risk account API Ba never approved. Low-risk boards need no approval (Ba's decision 2 covers risky boards only).
- A token value shows up in a log, notice, event, transcript, prompt or committed file.
- Any request reaches an apply or other state-changing endpoint.
- A board stops returning jobs because its token expired, instead of falling back to the browser.

## 3. Constraints
- Single user, local Mac. No API keys for LLMs. Claude and Codex run through Ba's subscription CLIs, which is unchanged.
- Existing stack: pnpm and Turborepo, Node 22, TypeScript, Fastify orchestrator, Next.js web, SQLite (drizzle), Zod schemas in `packages/shared`, vitest.
- Turborepo note: read the installed `turbo` package's `docs/` before touching Turborepo config (see `AGENTS.md`).
- The existing feed scanner's per-host gap, caching and error behaviour must keep working. Feeds move under the shared HTTP layer (AD-2) without changing what they return.

## 4. Decided by Ba (this conversation, 2026-10-19)

1. **Path order:** public API, then account API with Ba's own token, then browser. Read-only. (Also an earlier answer, E-1.)
2. **Risky boards need Ba's approval.** A board whose terms forbid automated access, or whose account risk is high, is not read through the account API until Ba has read its research and approved it. Until then it stays on the browser path. (This settles spec OQ-11.)
3. **Expired or missing token: fall back to the browser and show a notice.** When an account-API board has no token, or the board rejects it (401/403), that run scans the board through the browser as today, and Ba sees a notice naming the token to renew. (This reverses spec A9, REQ-5.AC-2 and the "no fallback" part of AD-4/AD-5. Settles OQ-8.)
4. **Order of sub-projects:** this one first.
5. **No live account calls to a `high` board before approval.** During the build, the engineer and QA use only the saved, scrubbed sample responses for `high`-risk boards. Live requests with Ba's token start only after Ba approves that board. Low-risk and public-API boards may be called live during development, within the 1.5 s gap.
6. **How it gets built:** directly, with a team of subagents (leader, researcher, designer/architect, engineer, QA that loops back to the engineer), ending in a PR with screenshots or video. Not through the VTC engine.

## 5. How it works (taken from the spec and AD-2 to AD-6, with Ba's changes)

### 5.1 Access records: `packages/shared/src/source-access/`
- `schema.ts`: `SourceAccessRecordSchema`. One `<source>.json` for each of `topcv`, `itviec`, `vietnamworks`, `linkedin`, `wellfound`, `upwork`. An `index.ts` exports `accessPathOf(source, approvals)`.
- Record fields:
  - `publicApi`: endpoints, or "none found"
  - `internalApiGetEndpoints`: method, host and path pattern, or "none found"
  - `applyEndpoints`: each `documentedOnly: true`
  - `termsOfUse`: the relevant clauses, quoted, with a URL
  - `accountRisk`: a statement
  - `riskLevel`: `low | high`. `high` if the terms forbid automated access or accounts are known to be restricted for it.
  - `auth`: how the token is sent, e.g. a cookie name or a header name
  - `chosenPath`
  - `researchedAt`
- Credentials can have several named values (e.g. LinkedIn's `li_at` cookie plus a CSRF header). The record's `auth` field lists the names, and the secrets file holds `{ "<source>": { "<name>": "<value>" } }`. *(My call.)*
- `chosenPath` is informational. A schema test asserts it equals `accessPathOf` with every board approved. *(My call.)*
- A public API that needs a developer key or OAuth app (e.g. Upwork's GraphQL API, LinkedIn partner APIs) counts as "not usable" in this sub-project. Such a board falls through to the next path. *(My call: Ba has no such keys, and getting them is a separate process.)*
- `accessPathOf` returns:
  - `public_api` if a usable public API is listed
  - otherwise `account_api` if at least one internal GET endpoint is listed, `termsOfUse` and `accountRisk` are non-empty, and either `riskLevel` is `low` or Ba has approved this board
  - otherwise `browser`

  The four feed boards are `public_api` by construction.
- **Approval is stored in SQLite, not in the record.** Each source has an approval flag with a timestamp and the record's `researchedAt`. If the record is re-researched (`researchedAt` changes), the approval lapses and the board needs approving again. *(My call.)* Records stay human-written research, and approval stays Ba's runtime decision. *(Builder's call how to store it, e.g. in the existing settings or criteria tables.)*
- Nothing else decides a path. The queue's claim filter, the runner, the bot tool grant and the web labels all call `accessPathOf`. The `kind` and `isFeedSource` checks in `packages/shared/src/common/sources.ts` become views of it.

### 5.2 Board API client: `apps/orchestrator/src/adapters/board-api/`
- `client.ts`: `BoardApiClient`, built from a record.
  - A request whose method, host and path match none of the record's GET endpoints throws `EndpointNotAllowed` before any network I/O. The client has no code path that builds apply endpoints.
- One mapper per account-API or public-API board (`<source>.ts`). It turns responses into `ResearchScanOutput` jobs, including fetching the full JD text when the list endpoint gives only a snippet. Mappers never call `fetch` directly.
- `apps/orchestrator/src/adapters/http/`: the per-host 1500 ms gate and error classification, extracted from `adapters/feeds/scanner.ts` and used by both feeds and board APIs.
  - 429, 5xx, connection errors and timeouts are transient and retried under the existing `maxAttempts`.
  - 401 and 403 are `AuthRejected`.
- Each request is recorded on the task as a progress event with method, host and path only. Query strings and headers are dropped.

### 5.3 Secrets: `apps/orchestrator/src/adapters/secrets/`
- A `SecretStore` port (`token(source): string | null`), implemented by `FileSecretStore`.
  - It reads the JSON file named by `ORCH_SECRETS_FILE`. The default is a file in the user's config directory, outside the repo.
  - It refuses a path inside the repo root, and warns if the file can be read by anyone but its owner.
- Only the board-API adapters and `engine/wiring.ts` touch it. Every token is registered with a redactor, and every error, notice and event on this path is redacted.
- How Ba adds a token: paste it into the secrets file. `docs/runbook.md` gets a section with the file format and, for each approved board, where to copy the cookie or header from in Chrome DevTools.

### 5.4 Running a scan: `apps/orchestrator/src/engine/api-tasks.ts`
- `ApiTaskRunner` absorbs `engine/feed-tasks.ts`. The queue hands it every `research.scan` task whose source path is `public_api` or `account_api`. Those tasks never reach a CLI runner, so there is no `chrome:` tool and no Claude session.
- **Fallback (Ba's decision 3).** For an `account_api` board, when the token is missing or the request fails with `AuthRejected`:
  - the API attempt stops, sending no request at all if the token is missing
  - if the 401/403 arrives partway through, jobs already fetched are discarded. The browser scan covers the board, so there is no merge logic. *(My call.)*
  - the API task does not count as a failed source in the join (it ends as superseded by the fallback). *(Builder picks the status representation.)*
  - a browser `research.scan` task is queued for the same source in the same run, so the join waits for it
  - Ba gets a notice: "<Source> token missing" or "<Source> token rejected", then "— scanned through the browser this time. Renew the <Source> token in your secrets file." The notice never includes the token value.
- **Transient errors, once retries are used up:** the branch fails with "<Source> scan failed: <reason>. The other sources go on." There is no browser fallback for these. *(My call: a 5xx outage is not something the browser path fixes reliably, and silently opening Chrome on every hiccup would undo the cost saving. Ba can override.)*
- **Settling.** Output goes through a new `engine/scan-settle.ts` (`settleScanOutput`):
  1. per-posting schema validation, dropping invalid postings and keeping the rest
  2. deterministic self-check items, e.g. "Every job has full JD text (not a snippet)"
  3. the existing `ScanOutputChecker`
  4. the existing dedupe

### 5.5 Research step (done once, before the board code)
- A researcher subagent visits each of the six boards in Ba's logged-in Chrome (Claude in Chrome: navigate, then read network requests). It records the GET endpoints the job search and job detail pages call, how auth is sent, any public or partner API, and the terms-of-use clauses. It writes the six JSON records.
- It does not click apply, save or follow, or submit any form.
- It saves one sample response per endpoint as a test fixture, scrubbed of tokens, cookies, CSRF values and Ba's personal data (name, email, phone, profile ids), and commits only the scrubbed copy. Mappers are built and tested against these fixtures. *(My call.)*
- The records are reviewed by the leader. The account-API boards marked `high` are presented to Ba with their research summary for approval. The build does not wait on this: code for `high` boards is finished and tested against fixtures, and the live check for each one runs after Ba approves it. Any board still unapproved when the PR opens is listed in the PR as "fixture-tested only".

### 5.6 Web: the Search criteria screen
- Each source toggle shows a label: "Public API", "Account API" or "Browser".
- A risky board that is not approved shows "Account API (needs approval)" with an **Approve** action. The action shows the record's terms quote and risk statement before confirming, and approval can be revoked.
- An account-API board with no token configured shows "Account API (token missing)". *(My call.)*
- While sources are loading, the toggles show no label, as today. If loading fails, the existing error shows.
- The visual style follows the existing screen and design tokens. The VTC prototype `.vtc/design/prototype/criteria/index.html` may be reused as reference.

## 6. Differences from the VTC spec and architecture
| VTC item | Here |
|---|---|
| A9, REQ-5.AC-2, AD-4/AD-5: missing or rejected token fails the branch, no browser | Falls back to the browser for that run, with a renew notice (§5.4) |
| REQ-25 notice "…scan failed… renew" | The notice says the board was scanned through the browser this time and asks to renew the token |
| OQ-11 open; AD-3 "approval not decided" | `riskLevel` plus Ba's approval gate the account path (§5.1, §5.6) |
| REQ-7 three labels | Adds "Account API (needs approval)" plus an Approve action |
| G2 to G4 of the VTC spec | Out of scope here; later sub-projects |

## 7. Left to the builder
- Exact file layout inside the folders named above, mapper internals and the pagination strategy, within the 1.5 s gap.
- Where the approval flag lives in SQLite, and the API route shape for approve and revoke.
- Whether a public-API board needs a mapper, or reuses the feed adapters' style.
- Test layout, following the repo's vitest conventions. Each REQ acceptance criterion in spec §4 (G1 part) that still applies, plus the changed ones in §6, gets a test.
- How the before and after measurement (success item 5) is taken and shown in the PR.

## 8. Delivery
- Branch off `main`. The uncommitted `.vtc/` design changes in the working tree are left untouched and are not part of this PR.
- The team:
  - **Leader:** splits the plan into tasks and assigns them.
  - **Researcher:** §5.5 records.
  - **Designer/architect:** confirms the plan against AD-2 to AD-6 and this document, and owns the label/approve UI detail.
  - **Engineer:** TDD, one task at a time.
  - **QA:** runs tests, typecheck and lint, checks each acceptance criterion, and loops back to the engineer until everything passes. Then takes screenshots or a short video of the Search criteria screen and a scan run.
- The leader opens the PR with the evidence and the before and after numbers.
