# Screen: scan-notices (Lead chat, scan notices) /chat/lead

Mode: Read. Ba reads what happened to a scan and decides whether to act. Existing screen (the Lead thread); only a new notice card is added to it, so the thread keeps the chat world. No directions.

Reqs: REQ-5, REQ-6, REQ-10, REQ-25.

## Product lens

- User and job: Ba, after or during a scan, learning which source failed, why, and what he must do (or that he need do nothing).
- Eye finds first: the first words of the notice, "<Source> scan failed:" or "<Source> adapter broken:", in strong weight, with a failure icon beside them.
- Primary action: the one next step for that failure: "Open the activity log" (adapter broken), "Run the scan again" (transient), or none when the next step is outside the app ("Add the token to local secret storage"). The notice never offers a button that pastes a secret into the browser.
- Density: airy. One notice is one card, `measure` wide at most, one problem per card.
- Hierarchy: line 1 is the exact message from the specification (it starts with the source and ends "The other sources go on."). Line 2 under a hairline is "What you can do", the next step. The message text is not split or reworded so that it can be matched and read aloud as written.
- Interaction model: read only, plus the one action button. A notice is a live region (`role="status"`; error notices `role="alert"`).
- Responsive priority: the message and the next step; the timestamp wraps under at 320 px.
- Generic defaults avoided: a red banner across the page, a toast that vanishes, a stack trace, a modal.

## Notice copy (all four cover what happened, why, what next; rule 2)

| State | Message (specification text) | What you can do |
|---|---|---|
| missing-token | "LinkedIn scan failed: no LinkedIn token in local secret storage. The other sources go on." | "Add your LinkedIn token to local secret storage, then run the scan again. LinkedIn was not contacted." |
| token-rejected | "ITviec scan failed: the ITviec token was rejected (HTTP 401). The other sources go on." | "Renew the ITviec token in local secret storage, then run the scan again. This scan was not retried." |
| transient-failure | "Remote OK scan failed: HTTP 503 on every attempt. The other sources go on." | "Run the scan again later. Nothing is wrong with your settings." |
| adapter-broken | "TopCV adapter broken: no job cards on the results page (layout changed?)" then "Automatic repair failed: validation scan returned 0 jobs" | "TopCV keeps its previous skill and later scans still use it. Open the activity log to see the attempt." |

Token values never appear in any notice. Reasons in the prototype are illustrative examples of the specified formats.

## States

- success: the existing run summary; "success shows nothing new" (spec section 6). No new element appears.
- empty: no scan has run yet; invitation: "No scans yet. Start one from Lead; failures and repairs show up here."
- loading and error: the thread's existing skeleton and its error ("Could not load the conversation. The orchestrator did not answer. Retry.").
- No permission: not applicable.
