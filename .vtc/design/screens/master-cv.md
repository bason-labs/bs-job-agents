# Screen: master-cv (Master CV) /cv

Mode: Operate. Existing screen; the fact list, in-place fact editor (`FactCard`), "Added" bar and fact-request cards are kept. This change adds derived-fact labelling, undo for automatic additions, and a flagged state. No directions.

Reqs: REQ-14, REQ-15, REQ-17, REQ-18, REQ-19, REQ-20, REQ-26, REQ-27, REQ-28.

## Product lens

- User and job: Ba, keeping the facts the tailored CVs draw on true. The system now adds facts for him; his job is to notice them, trust or fix them, and undo them.
- Eye finds first: when the system has just added facts, the banner "Added 2 facts automatically (v15)" with Undo; otherwise the fact list as today. In the list, a derived fact is found by its "Added automatically" label before its text.
- Primary action: Undo (while offered), then Edit in place on any fact.
- Density: airy; fact cards stack in a single reading column `measure` wide inside the 12-column grid (8 columns at 1024 px and wider, full width below), leaving the right columns for the version history as today.
- Hierarchy within a derived fact: id chip and meta line (type, org, dates; REQ-15 keeps org and dates), the fact text, then a provenance line: "Added automatically", then "Rests on f-12" or "Implied from f-3". Provenance is a distinct line, so a derived fact reads differently from Ba's own even in the grayscale theme.
- Interaction model: signature interaction is inline editing in place. The pencil on a fact opens the existing editor inside the card with a 120 ms fade; Done closes it. Editing a derived fact keeps its label and sources; the sources are shown in the editor as read-only text. Delete stays inside the editor and as an icon. The flagged state offers Keep and Delete beside the fact, not in a dialog.
- Responsive priority: id, text, provenance line and the Edit button stay at 320 px; the tag chips wrap.
- Generic defaults avoided: a sparkle "AI" badge, a confidence percentage, a toast as the only record of an addition, a confirmation dialog before every change.

## Content rules

- Labels are exact: "Added automatically", "Rests on f-12", "Implied from f-3", "Source fact changed" (REQ-19, REQ-20).
- The provenance ids are links that scroll to and focus the cited fact.
- A derived fact never shows a number, year or duration that its cited facts lack; if a draft would, it is not added and appears under "Not added" with the reason, e.g. "Not added: says 10 services; f-12 says 6 services." (REQ-27); or "Not added: names title Tech Lead; f-3 says Frontend Engineer." (REQ-28).
- Undo restores the previous version's content: "Undone: back to v14." toast confirms; the banner is replaced by the plain list.
- The fact request for a requirement nothing supports (Kubernetes with no container fact, Rust from Python) stays as today (REQ-17): the request card remains and no derived fact appears.

## States

- empty: no facts yet, as today: "Your master CV has no facts yet. Add the first one: a role, a project or a skill you can stand behind." with the add-fact action.
- loading: skeleton fact cards.
- error: "Could not read the master CV. The file is missing or invalid, so nothing is shown. Fix data/master-cv.yaml or restore a version, then retry."
- success: list with derived facts labelled (f-31 CI/CD resting on f-12, f-32 Redux implied from f-3), no banner.
- undo-offered: success plus the banner with Undo (REQ-18).
- undone: after Undo, the list equals the previous version (no derived facts) and a toast reads "Undone: back to v14." (REQ-18.AC-2, REQ-26.AC-4).
- source-changed: f-31 shows "Source fact changed", is marked "Not used in new tailor tasks until you keep or delete it", with Keep and Delete.
- rejected: a collapsed "Not added (2)" region, opened, listing the rejected drafts and reasons.
- fact-request: Kubernetes fact request card with no derived fact.
- No permission: not applicable.
