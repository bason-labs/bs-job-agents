---
id: access-record-drawer
screens: [criteria]
uses: [drawer, badge, button, icon-button]
---

# access-record-drawer

Shows one board's access record (REQ-22) in the registry `drawer`, from the right on 1024 px and wider, full width below.

## Props

- `record`: `{ source, publicApi: {exists, endpoints[]}, getEndpoints[], applyEndpoints[], terms: string, accountRisk: string, chosenPath }`. Empty lists render "None found".
- `lastScan`: `{ kept, rejected: [{reason}], merged, failedSelfCheck } | null` (REQ-3). `null` renders the no-scan-yet line. A count of 0 renders as "0".
- `open`, `onClose()`, `returnFocusTo`.

## Anatomy

Heading (source name, strong weight), then five labelled blocks in the order of REQ-22. Each apply endpoint carries a `badge` "Documented only, not called". Chosen path is a `badge` with the same words as the chip. A line "Token: read from local secret storage. The value is never shown." appears for the Account API path. Surface: `surface`, elevation `soft`, border `border`, radius `radius.lg` on the open edge.

After the five record blocks and the token line, a separate block "Last scan through this path" (`data-testid="scan-checks"`) lists Kept, Rejected, Merged and Failed the full description check, each with a distinct icon and its count in words, and a sentence that API postings pass the same output checks and de-duplication as browser postings (REQ-3). Each non-zero rejection says why and what remains kept; the snippet failure says what to do next. With no scan yet: "No scan has run through this path yet, so there are no checks to show. Start a scan from Chat."

## States

| State | Treatment |
|---|---|
| default (open) | fades in 120 ms; focus moves to the heading; focus is trapped |
| hover (close button) | `surface-2` |
| focus | `ring-focus` on every control |
| active | `surface-3` on close button |
| disabled | not applicable |
| loading | five block skeletons while the record loads |
| error | "Could not load the access record. The file for this board is missing or unreadable. Close and try again." |

Escape and the close button close it and return focus to the opener. Long clause text wraps; blocks scroll inside the drawer.
