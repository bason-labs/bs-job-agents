---
id: rejected-drafts
screens: [master-cv]
uses: [card, badge]
---

# rejected-drafts

Collapsible region "Not added (N)" listing derived facts the screen rejected (REQ-27, REQ-28) and why.

## Props

- `items: {text, cites: string[], reason}[]`, `open`, `onToggle()`.

## Anatomy

Header button (`aria-expanded`, min height `space.touch`) with the count. Each item: the draft text in `muted`, "Cites f-12", and the reason as a sentence naming the unsupported value and the cited value. Nothing here can be accepted: there is no add button, because adding a rejected draft would add an invented value.

## States

| State | Treatment |
|---|---|
| default (collapsed) | header only |
| hover | `surface-2` |
| focus | `ring-focus` |
| active | `surface-3` |
| open | items shown, 120 ms fade |
| disabled, loading | not applicable |
| error | not applicable |
| empty | region is not rendered |
