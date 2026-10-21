---
id: derived-fact-card
screens: [master-cv]
uses: [badge, button, icon-button, field, input, textarea]
extends: FactCard (apps/web/components/cv/FactCard.tsx)
---

# derived-fact-card

A master fact the system added, in the same card as Ba's own facts plus a provenance line. Edited in place.

## Props

- Everything `FactCard` takes, plus `derived: { kind: "rests-on" | "implied-from", sourceIds: string[], stale: boolean }`.
- `onKeep()`, `onSourceClick(id)`.

## Anatomy

As `FactCard`: id chip, meta line (type, org, dates; org and dates come from the cited facts), text, tags, Edit and Delete icon buttons. Added: provenance line under the text with a `badge` "Added automatically" (icon plus words) and "Rests on f-12" or "Implied from f-3"; ids are link buttons that scroll to and focus the cited fact. Min text size `font.size.xs`. Flagged: a second `badge` "Source fact changed" (warn icon), the sentence "Not used in new tailor tasks until you keep or delete it.", and Keep and Delete buttons (`space.touch` high).

## Inline editing in place

Edit opens the existing editor inside the card with a 120 ms fade (no dialog, no page change). In the editor, cited ids are read-only text. Done returns to the read view; focus returns to the Edit button. The label and sources persist after an edit.

## States

| State | Treatment |
|---|---|
| default | `border` border, `surface` |
| hover | Edit/Delete icon buttons `surface-2` |
| focus | `ring-focus` on every control |
| active | `surface-3` |
| editing | 2px `brand` border, editor visible |
| flagged | `warn` 2px start border plus badge and sentence; text unchanged |
| disabled | Keep/Delete disabled while the request runs, `aria-busy` |
| loading | skeleton card |
| error | `role="alert"` line "Could not save this change. The master CV changed in another tab, so your edit was not applied. Reload the screen and edit again." |
