---
id: activity-entry
screens: [activity]
uses: [card, badge, button]
---

# activity-entry

One skill repair attempt in the activity log, expandable in place.

## Props

- `id`, `source`, `at: Date`, `reason`, `outcome: "adopted" | "not-adopted" | "repairing"`, `failure?` (why not adopted), `diff: {previous: string, next: string} | null`, `notApplied: {file, change}[]`, `expanded`, `onToggle()`.

## Anatomy

`card` with a header `button` spanning the row (`aria-expanded`, `aria-controls`): outcome `badge` (icon plus word: check "Adopted", minus "Not adopted", clock "Repairing"), source name (strong), `<time>`, reason (regular, wraps). Body (when expanded): the `skill-diff`, then "Not applied" list, then for not adopted "The skill text is unchanged." Body fades in over 120 ms.

## States

| State | Treatment |
|---|---|
| default (collapsed) | `surface`, `border` |
| hover | header `surface-2` |
| focus | `ring-focus` on the header button |
| active | `surface-3` |
| expanded | chevron turns, body shown |
| disabled | not applicable |
| loading (repairing) | no body; a status line "Validation scan running" with `aria-busy` |
| error | not applicable (the list's error is the screen's) |

Header min height `space.touch`. Chevron points down/right as an icon, not colour.
