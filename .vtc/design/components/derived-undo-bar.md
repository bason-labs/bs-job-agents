---
id: derived-undo-bar
screens: [master-cv]
uses: [button, badge]
extends: AddedBar (apps/web/components/cv/FactDrafts.tsx)
---

# derived-undo-bar

Banner above the fact list after the system adds derived facts (REQ-18).

## Props

- `count`, `version` (the new version, e.g. 15), `previousVersion`, `onUndo()`, `undoing`.

## Anatomy

Text "Added 2 facts automatically (v15)." with a `badge` per fact id, and an Undo `button` (`space.touch`). Surface `surface-2`, border `border`, radius `radius.md`. `role="status"`.

## States

| State | Treatment |
|---|---|
| default | as above |
| hover | Undo `surface-3` |
| focus | `ring-focus` |
| active | Undo pressed fill `surface-3` |
| disabled | Undo disabled while `undoing` |
| loading | Undo label "Undoing..." with `aria-busy` |
| error | line "Could not undo. The master CV is no longer at v15, so nothing was changed. Reload the screen to see the current version." |

After success the banner is replaced by a toast "Undone: back to v14." and the list shows v14 content.
