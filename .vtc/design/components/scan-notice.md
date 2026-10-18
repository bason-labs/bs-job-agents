---
id: scan-notice
screens: [scan-notices]
uses: [card, badge, button]
---

# scan-notice

One Lead notice for one source's scan or repair failure, in the chat thread.

## Props

- `kind`: `"missing-token" | "token-rejected" | "transient-failure" | "adapter-broken"`.
- `source`, `message` (specified text), `repairMessage?` (second line, "Automatic repair failed: <reason>"), `nextStep`, `action?: {label, href | onClick}`, `at: Date`.

## Anatomy

`card` with `border` border, radius `radius.md`, no shadow, max width `space.measure`. Row 1: failure icon (triangle) and message in regular weight with the leading "<Source> scan failed:" or "<Source> adapter broken:" in strong weight. Optional row 2: repair message. Hairline. Row 3: "What you can do" (strong, `font.size.xs`) and the next step; the action `button` (secondary variant) when the step is inside the app. Time in `muted`, `<time>`.

## States

| State | Treatment |
|---|---|
| default | as above, `role="alert"` for failures |
| hover | applies to the action button only: `surface-2` |
| focus | `ring-focus` on the action button; the card is not focusable |
| active | action button `surface-3` |
| disabled | action button disabled while the action runs |
| loading | action button shows "Starting..." and `aria-busy` |
| error | if the action fails, a line under the button: "Could not start the scan. The orchestrator did not answer. Try again." |

The token value, any URL query and any response body are never rendered. The `danger` colour is only on the icon and a 2px start border; text is `fg`.
