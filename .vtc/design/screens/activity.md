# Screen: activity (Activity log) /activity

Mode: Read. Ba understands what the system changed in his skills on its own and judges whether to trust it. New screen inside the existing shell: it takes the shell, the card and badge styles and adds one list. A "Activity" entry is added to the sidebar after "Schedules" (`lib/routes.ts`). No directions.

Reqs: REQ-8, REQ-9, REQ-10, REQ-11, REQ-12, REQ-13.

## Product lens

- User and job: Ba, checking after a notice, or at his own pace, that an automatic skill repair did what it said and touched only skill files.
- Eye finds first: the newest entry's outcome badge ("Adopted", "Not adopted", "Repairing") beside the source name.
- Primary action: expand an entry to read the difference. There is deliberately no revert button: whether Ba can revert an adopted change is open question OQ-3, and this design does not decide it.
- Density: airy; one entry per row, 12-column grid: source and outcome 3 columns, reason 6, time 3; at 640 px and below they stack in that order.
- Hierarchy: outcome, source, time, reason, then (expanded) the skill difference, then the "Not applied" list.
- Interaction model: inline expansion in place. The entry header is a button (`aria-expanded`); the difference opens under it with a 120 ms fade, no page change. The diff shows previous text and new text side by side from 1024 px, stacked below; removed lines carry a "-" and added lines a "+" sign in front, not only a colour.
- Responsive priority: source, outcome and time stay on the row at 320 px; the diff scrolls horizontally inside its own box and wraps long lines.
- Generic defaults avoided: a timeline with dots and a rail, a data table with a column per field, a log console look.

## Entry content (REQ-11)

Each entry shows: source, adoption time (`<time>` in Ba's locale and zone, ISO value in `datetime`), the reason that triggered it ("adapter broken: <reason>"), the outcome, the previous and new skill text as a difference. Not adopted entry (REQ-11.AC-2): states "Not adopted. The skill text is unchanged." and the reason it failed (validation, REQ-9.AC-2 / REQ-10). Proposed changes outside skills (REQ-13.AC-2) are listed under "Not applied" with the file name, for example "bots/research/bot.json: new allowed site", and the line "Only files under bots/research/skills/source-topcv/ changed."

REQ-12: nothing on this screen or in the shell shows the degraded-start banner after an adopted change; the success state includes the sentence "Adopted changes do not put the research bot in the degraded start state." as a visible line under the page heading so the behaviour is stated where Ba looks.

## States

- empty: "No skill changes yet. When a scan reports an adapter broken, the automatic repair is recorded here, whether it was adopted or not."
- loading: three entry skeletons.
- error: "Could not load the activity log. The orchestrator did not answer, so no entries are shown. Retry."
- success: three illustrative entries (adopted, not adopted, adopted with a change not applied).
- repairing: one entry with outcome "Repairing", the reason and a "Validation scan running" status line; no diff yet (REQ-8.AC-3: a second failure does not add a second entry).
- No permission: not applicable.
