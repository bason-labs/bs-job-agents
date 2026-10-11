# W4c report (Phase 4: prompts, master CV, imports)

- **Merged.** develop: 2,465 tests (orchestrator 1,614).
- **ROLE.md v2 for all five bots** (with lock and version bumps):
  - **Lead:** only divides work; `propose_criteria_change` / `propose_schedule`; `applyAgain` only from Ba's own words; one question at most.
  - **Research:** read-only, allowlist, LinkedIn limit of 40 page views with 3–8 s delays, stops at login/CAPTCHA, reports injections, closes its tabs.
  - **CV:** master facts only, with `factIds`; `factRequests` instead of inventing; §6.3 language rule; Figma rules checked against the real guard.
  - **QA:** checks factIds first; justification for every score; seven hard fails; reports injections.
  - **Apply:** approved domains only, with a `domain_confirm` pause; source recorded for every field; salary policies; screenshots by `ss_` id; no submit in a dry run; submits once; on injection → `needs_check`; closes its tabs.
- **E1 option A applied:** `bots/research/bot.json` engine = claude.
- **Master CV seed:** `data.example/master-cv.yaml`, 24 facts (15 with VI wording) and 5 headlines, all from `build_targeted_resumes.py` and validated by the schema.
- **Imported applications:** `data.example/imported-applications.yaml` (DEKON, SMARTBIT, YAVIET) and `scripts/import-applications.ts` (idempotent, copies and hashes the PDFs). Command: `pnpm --filter @bs-job-agents/orchestrator import:applications -- --data <dir> --file <yaml>`. README has a "First run" section.
- **Finding:** pdf.js extracts NO text from the three `*_Figma_EN.pdf` files that were actually sent, so ATS systems may not have been able to read them. By contrast, the S3b bridge export had a clean text layer.
  **Correction (2026-10-11):** wrong. The PDFs do have text; pdf.js 4 failed on Figma's embedded fonts (\"invalid font name\"). pypdf, pdfminer and pdf.js 5 read them, and the orchestrator now uses pdf.js 5 with a Figma-export regression test.
- **Handoffs:**
  - F4: the mock shows Research on Codex; check the Lead action names (both relayed).
  - Engine (F4 part B): Apply's input has no master facts (copy `master-cv.yaml` into its read folder); the CV task gets no template list.
