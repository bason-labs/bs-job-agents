# Screen: criteria (Search criteria) /criteria

Mode: Operate. Existing screen; inherits the product's world (Deep Sea palette, Be Vietnam Pro, rounded cards, `bg-surface` cards with `CardLabel`). No directions: this is a change inside an established product. The dealt constraints (restrained colour, geometric sans, two weights, airy 12-column grid, small radius, one soft elevation, fades of 150 ms or less, editing in place) are applied to every new element and never override an inherited one.

Reqs: REQ-1, REQ-2, REQ-3, REQ-4, REQ-7, REQ-21, REQ-22, REQ-23, REQ-24.

## Product lens

- User and job: Ba, the only user, enabling the boards to scan and checking, before a scan runs, how each board will be read and whether that is safe for his account.
- Eye finds first: the Sources card, where every source toggle now carries its access path word ("Public API", "Account API", "Browser") under its name.
- Primary action: toggle a source on or off (unchanged). Secondary: open a source's access record.
- Density: airy. Source toggles sit on the 12-column grid, 4 columns each at 1024 px and wider, 2 at 640 px, 1 at 320 px; gutter is `space.gutter`.
- Hierarchy: card label, one sentence on the order the system tries (public API, then account API, then browser), then groups of toggles. The access path word is the second line of each toggle, regular weight; the source name is strong weight.
- Interaction model: a toggle is a pressable chip (`aria-pressed`). The path word is part of the chip's accessible name ("ITviec, Account API, on"). An "Access record" text button after each chip opens the record in a drawer (state `record-open`). Nothing on this screen edits a record: records are research output.
- Responsive priority: name, path word, on/off state stay visible at 320 px; the "Access record" button wraps below the chip rather than hiding.
- Generic defaults avoided: a status-dot-only indicator (colour alone), a tooltip that holds the path word (invisible on touch), a settings table with a column per attribute.

## Content rules

- The path word is shown for every enabled and disabled source, not only enabled ones.
- Loading: chips render with their names and on/off state from the saved criteria and no path word until the sources are known (spec section 6). The path line is reserved at the same height so nothing jumps when it fills in.
- Error: "Could not load your sources. The orchestrator did not answer, so no change was made. Check that it is running on port 4100, then retry." with a Retry button. This is the screen's existing error; only the copy pattern is aligned to rule 2.
- Empty (no source enabled): "No source is switched on. A scan needs at least one. Turn on a board below; a public API board needs no browser." Primary action: the first chip receives focus.
- Illustrative data: the path words in the prototype are examples. The real paths come from the access records of REQ-22, which this design does not prejudge.

## Access record drawer (state `record-open`)

Five blocks in this order, matching REQ-22: public API and its job-read endpoints; internal web API get endpoints; apply endpoints, each tagged "Documented only, not called"; terms-of-use clauses on automated access and the account risk; chosen path. "None found" is a valid value and is written out, never left blank. A token line reads "Token: read from local secret storage. The value is never shown." The drawer has a close button, traps focus, closes on Escape, and returns focus to the "Access record" button that opened it.

## Last scan checks (REQ-3, in the drawer, state `record-open`)

REQ-3 has no screen of its own: jobs read through an API pass the same validation and de-duplication as browser jobs, so the only thing Ba can see is the outcome of those checks. The drawer ends with a block "Last scan through this path", below the access record and visibly apart from it (a record is research output; this block is scan output). It states, in words with an icon of a different shape for each, never colour alone:

- Kept: how many jobs were kept.
- Rejected: postings dropped because a required field such as the job URL was missing (REQ-3.AC-1); it says the other postings from the same response were kept.
- Merged: postings whose URL a job already in the list holds, counted once (REQ-3.AC-2).
- Failed the full description check: postings that came back as a snippet only (REQ-3.AC-3); it says a browser read fails the same check, and what to do next (open the board, read the full description, scan again).

A line above the counts says API postings pass the same output checks and de-duplication as browser postings. A count of 0 is written out ("Rejected: 0 postings"), never hidden. If no scan has run through the path, the block reads "No scan has run through this path yet, so there are no checks to show. Start a scan from Chat." Counts in the prototype are illustrative and labelled so. Success of the checks adds nothing to Chat (spec section 6: success shows nothing new); this block is the only place the counts appear.

## Failure and permission branches

- No permission state: single local user.
- A source whose chosen path needs a token that is missing is not marked on this screen; the scan notice (screen `scan-notices`) reports it at scan time (REQ-5).
