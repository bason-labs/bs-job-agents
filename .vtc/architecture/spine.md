# Architecture spine: job research without the browser extension, self-updating skills and CV

Run r20261017-044722. Spec: `.vtc/spec/spec.md` (revision 2). Repo map: `.vtc/research/repo-map/repo-map.md`.
Companion document: `.vtc/architecture/architecture.md` (scenarios, candidates, scorecard,
requirement-to-component map, C4 diagrams).

Baseline kept (rule 4): the modular monolith `apps/orchestrator` (Fastify, engine, runner, SQLite),
`apps/web`, `packages/shared` (Zod), bots under `bots/`. Existing code that breaks a rule below is
baseline, not a finding; each Check is scoped to the files this feature adds or changes.
No new technology, package or datastore is introduced, so no version, licence or price claim is made.

Order: the riskiest irreversible decisions first (Ba-owned data model, then outbound requests to
boards with Ba's account, then secrets).

### AD-1: Derived facts are master facts with a provenance block, written only through the versioned master-CV path

- **Binds:** `packages/shared/src/domain/master-cv.ts` (the `Fact` schema gains an optional
  `derived` block), `apps/orchestrator/src/api/master-cv.ts` (the only file that writes
  `data/master-cv.yaml` and its history), `apps/orchestrator/src/api/derived-facts.ts` (new sink,
  sibling of `api/fact-drafts.ts`), `apps/orchestrator/src/api/routes/master-cv.ts`,
  `data/master-cv.yaml`, the Master CV screen in `apps/web`.
- **Covers:** REQ-14, REQ-15, REQ-18, REQ-19, REQ-20, REQ-26.
- **Prevents:** a derived fact that looks like one Ba wrote; a bot or engine module writing
  `data/master-cv.yaml` directly; a derived fact that Undo cannot remove; a derived fact still used
  after the fact it rests on was edited or deleted.
- **Rule:**
  - A derived fact is a normal `Fact` plus `derived: { restsOn: [{ factId, relation:
    "supports" | "implied_from" }] (at least one), status: "active" | "source_changed",
    rationale, taskId, derivedAt }`. Ba's own facts have no `derived` block; the shape is additive,
    so existing master files still parse.
  - `org` and `dates` of a derived fact are copied by the orchestrator from the cited facts, never
    taken from the bot's draft (REQ-15).
  - Accepted derived facts of one task are added as one new master version through the same
    `keepMasterCvVersionSync` / `writeMasterCvSync` path the fact-draft sink uses, so Undo restores
    the previous version exactly (REQ-18, REQ-26.AC-4).
  - Every master write (Ba's edit or delete on the Master CV screen, a fact draft, a derived-fact
    add, an Undo) recomputes `derived.status`: a derived fact whose cited fact was deleted or whose
    cited text, org or dates changed becomes `source_changed` until Ba keeps or deletes it. Task
    inputs for `cv.derive` and `cv.tailor` exclude `source_changed` facts (REQ-20).
  - The Master CV screen shows "Added automatically" and the cited ids, or "Implied from <ids>"
    for `implied_from` (REQ-19), and "Source fact changed" for flagged facts.
- **Check:**

```vtc-check
kind: forbidden-pattern
mode: blocking
paths: ["apps/orchestrator/src/**"]
except: ["apps/orchestrator/src/api/master-cv.ts", "apps/orchestrator/src/api/fact-drafts.ts", "apps/orchestrator/src/api/derived-facts.ts", "apps/orchestrator/src/api/routes/master-cv.ts", "apps/orchestrator/src/**/*.test.ts", "apps/orchestrator/src/engine/testing/**"]
pattern: '\b(writeMasterCv|writeMasterCvSync|keepMasterCvVersion|keepMasterCvVersionSync)\('
message: Only the master-CV API files write data/master-cv.yaml and its versions (AD-1).
```

```vtc-check
kind: import-boundary
mode: blocking
from: ["apps/orchestrator/src/engine/**", "apps/orchestrator/src/runner/**", "apps/orchestrator/src/adapters/**", "apps/orchestrator/src/mcp/**"]
except: ["apps/orchestrator/src/engine/wiring.ts", "apps/orchestrator/src/**/*.test.ts", "apps/orchestrator/src/engine/testing/**"]
forbid: ["apps/orchestrator/src/api/master-cv.ts", "apps/orchestrator/src/api/derived-facts.ts"]
message: The engine reaches the master CV only through its sink port, wired in wiring.ts (AD-1).
```

Check: vitest `packages/shared/src/domain/master-cv.test.ts` and `apps/orchestrator/src/api/derived-facts.test.ts` cover REQ-15.AC-1, REQ-18.AC-1/AC-2, REQ-20.AC-1 and REQ-26.AC-4, blocking.

### AD-2: The orchestrator talks to boards read-only, through one allowlisted, polite client

- **Binds:** `apps/orchestrator/src/adapters/board-api/client.ts` (new `BoardApiClient`),
  `apps/orchestrator/src/adapters/board-api/<source>.ts` (one response mapper per account-API
  board), `apps/orchestrator/src/adapters/http/**` (per-host gap and error classification, extracted
  from `adapters/feeds/scanner.ts` and used by both feeds and board APIs).
- **Covers:** REQ-23, REQ-6, NFR-1, NG7.
- **Prevents:** an apply, save, follow, message or profile request to a board; a request to an
  endpoint nobody researched; hammering a board host with Ba's account.
- **Rule:**
  - Every board-API request goes through `BoardApiClient`, built from the board's access record
    (AD-3). A request whose method, host and path do not match one of the record's get endpoints
    throws `EndpointNotAllowed` before any network I/O. Apply endpoints are data in the record
    only; the client has no code path that builds them (REQ-23).
  - At least 1500 ms between two requests to the same host on any non-browser path, feeds and
    account APIs alike, enforced by one per-host gate in `adapters/http/` (NFR-1).
  - Errors are classified once: HTTP 429, 5xx, connection error and timeout are transient (the task
    attempt is retried under the existing `maxAttempts` policy, REQ-6.AC-1/AC-2); 401 and 403 are
    `AuthRejected` (no retry, REQ-6.AC-3, REQ-25).
  - Each request is recorded on the task as a progress event with method, host and path, the query
    string and every header value dropped (evidence for REQ-23.AC-2).
- **Check:**

```vtc-check
kind: forbidden-pattern
mode: blocking
paths: ["apps/orchestrator/src/adapters/board-api/**"]
except: ["apps/orchestrator/src/adapters/board-api/client.ts", "apps/orchestrator/src/adapters/board-api/**/*.test.ts"]
pattern: '\bfetch\('
message: Board-API mappers never call fetch; every request goes through the allowlisted BoardApiClient (AD-2).
```

```vtc-check
kind: import-boundary
mode: blocking
from: ["apps/orchestrator/src/adapters/board-api/**", "apps/orchestrator/src/adapters/http/**"]
forbid_packages: ["axios", "got", "node-fetch", "undici", "superagent", "puppeteer", "playwright"]
message: Board APIs use the injected fetch through BoardApiClient, no second HTTP or browser client (AD-2).
```

Check: vitest `apps/orchestrator/src/adapters/board-api/client.test.ts` (an unlisted endpoint and every apply endpoint of every record throw before fetch is called; three requests to one host are at least 1500 ms apart on the fake clock; 503 is transient, 401/403 are AuthRejected), blocking.

### AD-3: One access record per board decides its path; the order is public API, account API, browser

- **Binds:** `packages/shared/src/source-access/` (new: `schema.ts` with `SourceAccessRecordSchema`,
  one `<source>.json` per board, `index.ts` with `accessPathOf(source)`),
  `packages/shared/src/common/sources.ts` (`kind` and `isFeedSource` become views of
  `accessPathOf`), the Search criteria screen in `apps/web` (label per toggle), the queue's claim
  filter in `apps/orchestrator/src/db/repos/tasks.ts`.
- **Covers:** REQ-4, REQ-7, REQ-21, REQ-22, NFR-2.
- **Prevents:** a board read through Ba's account without documented terms and risk; two places
  disagreeing on a board's path; a research result that lives only in prose and cannot be enforced.
- **Rule:**
  - Each of `topcv`, `itviec`, `vietnamworks`, `linkedin`, `wellfound`, `upwork` has a record with
    the five REQ-22 items: `publicApi` (endpoints or "none found"), `internalApiGetEndpoints`
    (method, host, path pattern, or "none found"), `applyEndpoints` (each `documentedOnly: true`,
    "documented only, not called"), `termsOfUse` (clauses on automated access) and `accountRisk`,
    plus `chosenPath` and `researchedAt`. The four feed boards are `public_api` by construction.
  - `accessPathOf` returns `public_api` when a usable public API is listed; else `account_api` only
    when at least one internal get endpoint is listed and `termsOfUse` and `accountRisk` are
    non-empty (NFR-2); else `browser` (REQ-21, REQ-4). A record's `chosenPath` must equal
    `accessPathOf`.
  - Nothing else decides a path: the queue, the runner, the bot tool grant and the web label all
    call `accessPathOf`. The web shows "Public API", "Account API" or "Browser" (REQ-7).
  - Records are written by people (the research task of this run), never by an automatic update
    (NG5). Whether a high-risk board needs Ba's explicit approval is OQ-11 and is not decided here.
- **Check:**

```vtc-check
kind: forbidden-pattern
mode: warn
paths: ["apps/**/*.ts", "apps/**/*.tsx", "packages/**/*.ts"]
except: ["packages/shared/src/common/sources.ts", "packages/shared/src/source-access/**", "**/*.test.ts"]
pattern: '\.kind\s*===?\s*["''](browser|feed)["'']'
message: A source's access path comes from accessPathOf, not from comparing SEARCH_SOURCES kind (AD-3).
```

```vtc-check
kind: import-boundary
mode: blocking
from: ["packages/shared/src/**"]
forbid: ["apps/**"]
forbid_packages: ["fastify", "drizzle-orm", "better-sqlite3", "next", "react"]
message: Shared policy (access records, derived-fact screen) depends on no app, framework or database (AD-3).
```

Check: vitest `packages/shared/src/source-access/source-access.test.ts` asserts REQ-22.AC-1 to AC-4, REQ-21.AC-1 to AC-3 and NFR-2 (an empty risk statement yields `browser`) over the real records, blocking.

### AD-4: Account tokens live only in a local secret file outside the repository, behind a port

- **Binds:** `apps/orchestrator/src/engine/ports.ts` (new `SecretStore` port: `token(source):
  string | null`), `apps/orchestrator/src/adapters/secrets/**` (new `FileSecretStore` and the
  redactor), `apps/orchestrator/src/config.ts` (`ORCH_SECRETS_FILE`), `engine/notices.ts`.
- **Covers:** REQ-24, REQ-5, REQ-25.
- **Prevents:** a token read from a repository file or committed by mistake; a token in a bot
  prompt, a transcript, an event, a notice or a log line.
- **Rule:**
  - `FileSecretStore` reads one JSON file named by `ORCH_SECRETS_FILE` (default: a file in the
    user's config directory). It refuses, at start, a path that resolves inside the repository
    root, and logs a warning when the file is readable by anyone but its owner. No other source of
    tokens exists: no environment variable per board, no repository file (REQ-24.AC-2).
  - Only `adapters/board-api/**` reads tokens (through the port, injected in `engine/wiring.ts`).
    The runner, the prompt builder, the MCP server, the API routes and the web never see a token.
  - A token is registered with the redactor when read; every error, notice and event text built on
    the board-API path passes the redactor. Notices name the token ("LinkedIn token"), never its
    value. A missing token fails the branch with no request sent (REQ-5.AC-2); a rejected one asks
    Ba to renew it in local secret storage (REQ-25).
  - Trade-off: a file is simple, testable and portable but is plain text at rest; the macOS
    Keychain would encrypt at rest but ties the orchestrator to one OS and a `security` subprocess.
    The port keeps that switch to one adapter.
- **Check:**

```vtc-check
kind: import-boundary
mode: blocking
from: ["apps/orchestrator/src/**", "apps/web/**"]
except: ["apps/orchestrator/src/adapters/secrets/**", "apps/orchestrator/src/adapters/board-api/**", "apps/orchestrator/src/engine/wiring.ts", "apps/orchestrator/src/**/*.test.ts"]
forbid: ["apps/orchestrator/src/adapters/secrets/**"]
message: Only the board-API adapters and the wiring touch the secret store (AD-4).
```

Check: vitest `apps/orchestrator/src/adapters/secrets/file-store.test.ts` (a path inside the repo is refused; a token-like value in a repo file is never read) and `apps/orchestrator/src/engine/api-tasks.test.ts` (REQ-5.AC-1/AC-2, REQ-25.AC-1: notice text matches and contains no token value; zero requests when the token is missing), blocking.

### AD-5: Non-browser paths are fetched by the orchestrator, never by a bot

- **Binds:** `apps/orchestrator/src/engine/api-tasks.ts` (new `ApiTaskRunner`; it absorbs
  `engine/feed-tasks.ts`), `apps/orchestrator/src/db/repos/tasks.ts` (claim filter by
  `accessPathOf`), `apps/orchestrator/src/engine/wiring.ts`, `bots/research/bot.json` (unchanged:
  `mcpServers: []`).
- **Covers:** REQ-1, REQ-2, REQ-5, REQ-6, REQ-25.
- **Prevents:** Chrome opened for a board that has an API; a Claude or Codex session (and its
  quota) spent per API scan; an LLM context holding Ba's token or account responses.
- **Rule:**
  - The queue hands every `research.scan` task whose source's path is `public_api` or
    `account_api` to `ApiTaskRunner`; such a task is never given to a CLI runner, so it has no
    granted tools and no `chrome:` call (REQ-2.AC-1).
  - Missing token: fail the attempt without retry and without a request. `AuthRejected`: fail
    without retry with the renew-token reason. Transient errors: the existing attempt retry.
    Each failure goes through `noticeTaskFailed`, so the notice reads "<Source> scan failed:
    <reason>. The other sources go on." and the scan join goes on (REQ-5, REQ-6).
  - No board is exposed as an MCP tool in this run (spec A7 allows it later); see the scorecard,
    candidate B.
- **Check:**

```vtc-check
kind: import-boundary
mode: blocking
from: ["apps/orchestrator/src/engine/api-tasks.ts"]
forbid: ["apps/orchestrator/src/runner/**", "apps/orchestrator/src/bridges/**", "apps/orchestrator/src/mcp/**"]
message: API scans never spawn a bot, a browser bridge or an MCP server (AD-5).
```

Check: vitest `apps/orchestrator/src/engine/api-tasks.test.ts` covers REQ-1.AC-1 to AC-3, REQ-2.AC-1 (zero runner spawns for an account-API source), REQ-6.AC-1 to AC-3, blocking.

### AD-6: One settle pipeline validates scan output from every path

- **Binds:** `apps/orchestrator/src/engine/scan-settle.ts` (new `settleScanOutput`), the runner's
  scan settle path, `engine/api-tasks.ts`, `engine/scan-check.ts`, `adapters/checker.ts`,
  `apps/orchestrator/src/db/dedupe.ts` (unchanged).
- **Covers:** REQ-3, REQ-1.
- **Prevents:** API postings skipping the checks browser postings pass; a snippet-only posting
  accepted because no bot wrote a self-check.
- **Rule:** an API-path output goes through `settleScanOutput`: each posting is validated alone
  against the `ResearchScanOutput` job schema (invalid ones are dropped and logged, the rest kept,
  REQ-3.AC-1); the orchestrator computes the research bot's `selfCheck` items deterministically
  (for example "Every job has full JD text (not a snippet)") with the same failure effect as a
  bot-reported failed item (REQ-3.AC-3); then the `ScanOutputChecker`; then the existing dedupe
  (REQ-3.AC-2). The output shape is unchanged (NG3).
- **Check:**

```vtc-check
kind: forbidden-pattern
mode: blocking
paths: ["apps/orchestrator/src/engine/api-tasks.ts"]
pattern: '\bcompleteTask\('
message: API scans settle through settleScanOutput, never by completing the task directly (AD-6).
```

Check: vitest `apps/orchestrator/src/engine/scan-settle.test.ts` covers REQ-3.AC-1 to AC-3, blocking.

### AD-7: Skill repair is a single-flight engine flow (draft, validate, adopt) that writes only under bots/<bot>/skills/

- **Binds:** `apps/orchestrator/src/engine/skill-repair.ts` (new), `apps/orchestrator/src/adapters/skill-store/**`
  (new: the only writer of skill files), a `skill_repairs` table and migration in
  `apps/orchestrator/src/db/`, a research task kind `repair` (`bots/research/bot.json`
  `selfCheckByKind.repair`, `ROLE.md` and `promptVersion` bump, a developer change in this run),
  `apps/orchestrator/src/runner/prompt.ts` (skill override for the validation scan), the activity
  log (events `skill_repair.adopted` and `skill_repair.not_adopted`), `engine/notices.ts`.
- **Covers:** REQ-8, REQ-9, REQ-10, REQ-11, REQ-13.
- **Prevents:** a broken or hostile draft replacing a working skill; two repairs racing on one
  source; an automatic change to `bot.json`, `ROLE.md`, workflows or allowed sites (NG5); a skill
  change nobody can see.
- **Rule:**
  - Trigger: only a `research.scan` failure whose error is `adapter broken: …` on a `browser`
    path source, in the transaction that fails the task. A unique partial index on
    `skill_repairs(source)` for active statuses makes the repair single-flight (REQ-8.AC-3);
    transient "scan failed" never triggers one (REQ-8.AC-2).
  - Draft: a `research.repair` task (Chrome read-only, the same site guard and tool grant as a
    scan) returns `{ skillMd, otherChanges[] }`. The draft is stored in the `skill_repairs` row,
    never on disk. The orchestrator screens it: size limit, and every host it names must be one of
    the source's `hosts`.
  - Validate: a `research.scan` task for that source runs with the draft injected by the prompt
    builder in place of the file. Adopt only when it passes the self-check and the
    `ScanOutputChecker` (REQ-9).
  - Adopt: `SkillStore.write(source, text)` builds the path from the source key, resolves it and
    refuses anything outside `bots/research/skills/source-<source>/`; it writes atomically.
    `otherChanges` are never applied and are listed as "not applied" in the log entry (REQ-13).
  - Every attempt ends with one event carrying source, time, trigger reason, outcome and the
    previous and new skill text (REQ-11). A failed attempt keeps the old skill and Lead posts
    "<Source> adapter broken: <reason>" then "Automatic repair failed: <reason>" (REQ-10).
- **Check:**

```vtc-check
kind: import-boundary
mode: blocking
from: ["apps/orchestrator/src/**"]
except: ["apps/orchestrator/src/engine/skill-repair.ts", "apps/orchestrator/src/engine/wiring.ts", "apps/orchestrator/src/adapters/skill-store/**", "apps/orchestrator/src/**/*.test.ts"]
forbid: ["apps/orchestrator/src/adapters/skill-store/**"]
message: Only the skill-repair flow writes skill files (AD-7).
```

```vtc-check
kind: forbidden-pattern
mode: blocking
paths: ["apps/orchestrator/src/adapters/skill-store/**", "apps/orchestrator/src/engine/skill-repair.ts"]
except: ["**/*.test.ts"]
pattern: 'bot\.json|ROLE\.md|prompt-versions\.json|workflows/|allowedSites'
message: Automatic repair never names bot config, roles, the prompt lock, workflows or allowed sites (AD-7, NG5).
```

Check: vitest `apps/orchestrator/src/engine/skill-repair.test.ts` covers REQ-8.AC-1 to AC-3, REQ-9.AC-1/AC-2, REQ-10.AC-1, REQ-11.AC-1/AC-2, REQ-13.AC-1/AC-2 (a git-style file diff before and after adoption touches only `bots/research/skills/source-topcv/`), blocking.

### AD-8: Skill files stay outside the prompt-version lock

- **Binds:** `apps/orchestrator/src/runner/prompt-lock.ts`, `bots/prompt-versions.json`, the
  degraded-start check in `Engine.start`.
- **Covers:** REQ-12.
- **Prevents:** an adopted repair putting the orchestrator into the degraded start that guards
  ROLE.md changes.
- **Rule:** the lock and the start check hash only each bot's `ROLE.md` and `promptVersion`.
  Skill files are never hashed or locked, and skill repair never writes the lock file.
- **Check:**

```vtc-check
kind: forbidden-pattern
mode: blocking
paths: ["apps/orchestrator/src/runner/prompt-lock.ts"]
pattern: 'SKILL\.md|skills/'
message: The prompt-version lock covers ROLE.md and promptVersion only, never skills (AD-8).
```

Check: vitest `apps/orchestrator/src/runner/prompt-lock.test.ts` changes a SKILL.md on a temp bots directory and asserts no degraded start for `research` (REQ-12.AC-1), blocking.

### AD-9: Derived facts come from a tool-less cv.derive step and are screened deterministically before they reach the master CV

- **Binds:** `workflows/job-scan.yaml` (a `derive` step per job before the `tailor` gate,
  `version` bumped), a CV task kind `derive` (`bots/cv/bot.json` `selfCheckByKind.derive`, no tools,
  `ROLE.md` and `promptVersion` bump), `packages/shared/src/bots/derive.ts` (new: draft schema and
  the pure `screenDerivedFacts`), `apps/orchestrator/src/engine/derive.ts` (new: settle, screen,
  hand to the sink of AD-1, audit events).
- **Covers:** REQ-14, REQ-15, REQ-16 (removed in r2; its rule continues in REQ-27 and REQ-28),
  REQ-17, REQ-26, REQ-27, REQ-28.
- **Prevents:** an invented number, year, duration, employer or title entering the master CV; a
  derived fact citing nothing; a tailored CV claiming a skill whose derived fact was rejected.
- **Rule:**
  - `cv.derive` gets the job's requirements and the active master facts and returns drafts
    `{ text, textVi, tags, restsOn[{ factId, relation }], rationale }` (the "well-known" judgement
    is the model's, recorded as `relation` and `rationale`; OQ-10 stays open).
  - `screenDerivedFacts` (pure, in shared) rejects a draft that: cites no existing active fact
    (REQ-15.AC-2); states a number, year or duration not present in its cited facts' text or dates
    (REQ-27); names an employer or job title that none of its cited facts contains (REQ-28). Each
    rejection writes an audit event naming the reason (REQ-27.AC-1).
  - Accepted drafts go to the AD-1 sink as one new master version. The `tailor` step runs after,
    and its task input reads the current master version, so the tailored CV covers the requirement
    with the derived fact (REQ-14.AC-2). A requirement with no accepted derived fact stays out of
    the CV and is raised as a fact request by tailor as today (REQ-17, NG6).
  - Trade-off: one extra tool-less LLM call per tailored job, in exchange for the tailored CV never
    resting on a fact the screen later rejects.
- **Check:**

```vtc-check
kind: import-boundary
mode: blocking
from: ["packages/shared/src/bots/derive.ts"]
forbid: ["apps/**"]
message: The derived-fact screen depends on no app code (AD-9).
```

```vtc-check
kind: forbidden-pattern
mode: blocking
paths: ["packages/shared/src/bots/derive.ts"]
pattern: 'from\s+["''](node:)?(fs|child_process|net|http|https)["'']'
message: The derived-fact screen is pure policy with no I/O (AD-9).
```

Check: vitest `packages/shared/src/bots/derive.test.ts` table-tests REQ-15.AC-2, REQ-26.AC-1 to AC-3, REQ-27.AC-1 to AC-4, REQ-28.AC-1; `apps/orchestrator/src/engine/derive.test.ts` covers REQ-14.AC-1/AC-2 and REQ-17.AC-1, blocking.
