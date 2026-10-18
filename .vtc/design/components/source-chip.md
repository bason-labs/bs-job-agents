---
id: source-chip
screens: [criteria]
uses: []
extends: ToggleChips option (apps/web/components/criteria/ChipInput.tsx)
---

# source-chip

A source toggle that carries its access path. Replaces one `ToggleChips` option on the Sources card.

## Props

- `source`: slug (`remotive`, `itviec`, ...). `label`: source name. `path`: `"public-api" | "account-api" | "browser" | null` (null while loading).
- `pressed: boolean`, `onToggle()`, `disabled?`, `invalid?`.

## Anatomy

Two lines inside one `button` (`aria-pressed`): name (strong weight, `font.size.sm`), path word (regular weight, `font.size.xs`) preceded by an icon: plug for Public API, key for Account API, window for Browser. Accessible name: "<label>, <path word>". Pressed shows a check icon at the end of line 1. Min height `space.touch`, min width `space.touch`, radius `radius.md`, padding `space.3`.

## Variants and states

| State | Treatment |
|---|---|
| default (off) | `surface` fill, `border-strong` 1px border, text `fg` (name) and `muted` (path word) |
| hover | fill `surface-2`, 120 ms fade |
| focus | `ring-focus` (inherited, unlayered), never removed |
| active (pressed down) | fill `surface-3` |
| pressed (on) | `surface-2` fill, 2px `brand` border, check icon; text stays `fg`, so contrast does not depend on a gradient |
| disabled | `muted` text, `border` border, `aria-disabled`, not-allowed cursor |
| loading | path line reserved at height, shows a `surface-3` bar 6ch wide, no path word, `aria-busy` |
| error (invalid) | `danger` border plus the card's error text; the border is never the only signal |

Path words are exactly "Public API", "Account API", "Browser". Long source names wrap; the chip grows in height, never truncates.
