# W3a API part 2 report (Phase 3)

- **Merged.** develop: 2,225 tests (shared 380, orchestrator 1,437, web 408). One RoomScreen test flaked once under load; it passed 3/3 alone and on the full re-run, and W3d is stabilising it.
- **Live check:** the real server took one chat message ("what can you do?"). Lead's CLI had exactly the six `mcp__orchestrator__*` tools plus StructuredOutput, the orchestrator server connected, Lead's reply was stored, no run started, and the capability URL never appeared in the transcript. Lead's `model` is null, so it ran on the CLI default (Opus).
- **S17 MCP:** Streamable HTTP on its own 127.0.0.1 port, `POST /mcp/<token>`.
  - Per-spawn 256-bit capability; only its SHA-256 is stored; revoked in `finally`, with a TTL; every call checks the task is still running.
  - Tools: start_workflow, create_task (research only), get_status, get_result, message_user (≤ 5 per spawn), propose_workflow (≤ 2 per spawn, never runs).
  - Consult and room modes get no tools.
- **S20 chat:**
  - `POST /chat/messages` → `{ message, taskIds }`: Lead chat, consult reply (UC-25 handoff into the Lead chat), or room discussion with up to 5 mentions. Uploads are linked and described as untrusted.
  - `POST /chat/choices`; `GET /rooms` has a direct room per bot; messages carry attachments; macOS notifications (`ORCH_NOTIFY=0` turns them off).
- **Other routes:** confirm-injection; approve with `dryRun` (+ `reapproval`, nullable `applicationId`); workflow proposals (list/approve/dismiss; approve saves a new version, never runs); `GET /tasks/:id/transcript` (redacted, capped, paged); run detail `definition` + step previews; `GET /bridges`; question `answered: true`.
- **W3c's gaps:** cvFile, apply-again (failed applications only), BotView.demotion (null for now), memoryNotes with ids + delete, promotion dismiss, master-cv versions + fact requests (+ dismiss), criteria profiles.
- **README:** "Orchestrator settings" section added.
- **Engine requests → relayed to F3:** declineDomain, `removeMemoryNote` under the per-bot lock, a demotion record + reader, question `answer` field. `message.delta` streaming is not implemented (replies are posted whole).
- **Storage:** dismissals in `data/api-state.json`; proposals and master CV history as files under `data/`.
