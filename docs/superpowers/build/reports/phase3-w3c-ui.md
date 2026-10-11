# W3c UI report (Phase 3)

- **Merged** after 50f5d82. develop: 2,003 tests (web 245); e2e 91/91 in its worktree.
- **Screens:** Applications (table with manual-only status changes; record panel; FileViewer for every file; Export all with last export date + dataDir), Search criteria (all §7.5 fields; form defaults card; validation; versions; Saved answers card), Schedules (run now, enable, delete + 6 s Undo, modal editor), Bots + `/bots/[name]` (Apply/CV engine switch disabled; promotion/demotion cards; trust ladder mirroring the PATCH rules; memory list), Master CV (facts editor; fact requests; missing/invalid/stale states), Rooms (discussion mode, @mention autocomplete, paged history).
- **Data seam:** one `components/<area>/data.ts` per screen (interface + fixture impl + singleton). The header of each lists its routes. Follow-up: swap the singletons to W3b's `lib/api` and make the pages dynamic.
- **Requests:**
  - ui/shell → relayed to W3b: wide = max-w-6xl, TrustBadge only on Apply, focus return, tailwind-merge in `cn`.
  - API → relayed to W3a part 2: cvFile, apply-again, demotion, memory delete, promotion dismiss, master-cv versions + fact requests, criteria profiles.
- **Not built:** weekly auto-export (no API).
