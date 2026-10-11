# Owner decisions log

Decisions that need Ba. The coordinator records the question, the recommendation, the default used while waiting, and Ba's answer.

| # | Raised | Question | Recommendation | Default while waiting | Ba's answer |
|---|---|---|---|---|---|
| E1 | 2026-10-11 (pm-phase-2.md) | **Research bot's engine.** On Codex, Research can read the whole disk, run shell commands and script Chrome with no site guard. An injected job page could exfiltrate local files. | **Option A:** run Research on Claude (reads limited to its task folder, no shell, site guard on navigation). The cost is Claude quota and sharing Claude's 2-session cap. | No change in code until Phase 4. If Ba hasn't answered before W4b's first live scan, use option A, the safer one. | **Option A confirmed** (2026-10-11): Research stays on Claude. Codex's read-only sandbox can still read the whole disk and has a shell; Claude runs with a scoped Read allowlist, no shell and the site-guard hook. QA stays on Codex (no browser; sandbox cannot reach the network or the local API, verified W4b check c). |
| E2 | 2026-10-11 (pm-phase-3.md) | Defer UC-24 (import facts from an old CV; Lead points Ba to the Master CV screen) and UC-13b's weekly auto-export to a later phase? | Defer both | Deferred | **Yes, defer both** (2026-10-11) |
| SF-2 | 2026-10-11 (pm-phase-4.md) | Narrow the dry-run gate to count only a completed form fill? | Narrow | — | **No, keep as is** (2026-10-11): any settled dry run unlocks live, even one that only reached the job page or stopped early. |
