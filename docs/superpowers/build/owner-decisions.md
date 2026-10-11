# Owner decisions log

Decisions that need Ba. The coordinator records the question, the recommendation, the default used while waiting, and Ba's answer.

| # | Raised | Question | Recommendation | Default while waiting | Ba's answer |
|---|---|---|---|---|---|
| E1 | 2026-10-11 (pm-phase-2.md) | **Research bot's engine.** On Codex, Research can read the whole disk, run shell commands and script Chrome with no site guard. An injected job page could exfiltrate local files. | **Option A:** run Research on Claude (reads limited to its task folder, no shell, site guard on navigation). The cost is Claude quota and sharing Claude's 2-session cap. | No change in code until Phase 4. If Ba hasn't answered before W4b's first live scan, use option A, the safer one. | pending (2026-10-11 PM3 update: on Codex, Research could also approve cards through the local API — option A applied by W4c in bot.json; W4b verifies before the first live scan unless Ba picks B/C) |
| E2 | 2026-10-11 (pm-phase-3.md) | Defer UC-24 (import facts from an old CV; Lead points Ba to the Master CV screen) and UC-13b's weekly auto-export to a later phase? | Defer both | Deferred | pending |
