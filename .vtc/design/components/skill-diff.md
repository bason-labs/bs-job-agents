---
id: skill-diff
screens: [activity]
uses: []
---

# skill-diff

Previous and new skill text, line by line, for REQ-11.

## Props

- `previous: string`, `next: string`, `label` (e.g. "source-topcv skill").

## Anatomy

A `region` labelled by `label`, ground `surface-3`, radius `radius.sm`, `font.size.xs`, monospace system stack. From 1024 px: two columns "Previous" and "New"; below: stacked. Each changed line starts with "-" (previous) or "+" (new) and is also tinted (`danger` and `ok` at low strength); unchanged lines have no sign. Lines wrap; the box scrolls vertically past 24 lines and never horizontally (wrapping instead). Line numbers are not selectable.

## States

| State | Treatment |
|---|---|
| default | as above |
| hover | none |
| focus | the region is focusable (`tabindex=0`) for keyboard scroll; `ring-focus` |
| active | none |
| disabled | not applicable |
| loading | skeleton of 6 lines |
| error | "Could not load the skill text. The file may have been removed. The entry is still recorded." |
| empty | "No text difference: the attempt was not adopted." |
