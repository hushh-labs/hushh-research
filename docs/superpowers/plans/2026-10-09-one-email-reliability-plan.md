# One Email Reliability and Capability — Implementation Plan

Status: P0 safety subset implemented; remaining slices are proposed. Date: 2026-10-09. Current behavior and evidence are in the [One Email Knowledge Graph](../../reference/one/one-email-knowledge-graph.md); its F01–F07 fault edges are the intake. The [owner-approved Gmail contract](../../reference/one/gmail-owner-approved-email.md) remains the delivery authority. This plan is temporary: update the current references as later slices land and remove this artifact when it is no longer active.

## Goal and boundaries

Make the existing personal Gmail capability truthful and recoverable across read, draft, send, modify, receipt sync, disconnect, and typed Chat streaming. Keep One as the semantic decision maker, the Email specialist as a bounded read planner/interpreter, GmailReceiptsService as the OAuth/receipt owner, and the existing reviewed send and mailbox-action services as mutation authorities. The separately gated One Live Voice mail path is in scope for send recovery. This plan adds no new voice capability, second connector, universal runtime knowledge-graph router, or connection to the separate One Email KYC platform mailbox.

The checked-in code supports direct Google REST calls. Direct REST is a valid Google API integration; the gaps are error handling, state settlement, scope timing, user copy, observability, and coverage. Google recommends [incremental OAuth consent](https://developers.google.com/identity/protocols/oauth2/resources/best-practices), [reason-aware Gmail error handling and backoff](https://developers.google.com/workspace/gmail/api/guides/handle-errors), and resuming incremental sync from the [last synchronized history ID](https://developers.google.com/workspace/gmail/api/guides/sync). The repo cannot prove public-app OAuth verification or a restricted-scope security assessment; check those in the release evidence.

## Visual Map

Priority and dependency order:

~~~mermaid
flowchart LR
  graph["Current Email graph<br/>F01-F07"] --> safety["A. Settle effects and cursor"]
  graph --> privacy["B. Disconnect and stream truth"]
  safety --> provider["C. Provider errors and grants"]
  privacy --> product["D. Product semantics and copy"]
  provider --> perf["E. Measured latency work"]
  product --> perf
  perf --> release["Outcome and rollout gates"]
~~~

Fresh-main correction (2026-10-09): `gmail_receipt_cutover.py` hard-disables legacy receipt writes and sync, and migration 267 rejects those writes at the database. Slice 1 is a precondition for any later reactivation of that path, not an active UAT P0 repair. The active P0 work starts with send outcome recovery, disconnect cache clearing, stream settlement, mailbox outcome truth and OAuth error handling. Priority labels express engineering order, not measured incident counts.

### P0 implementation boundary

The first UAT change implements owner-authorized send-status reads and same-tab action-ID recovery, shared receipt cache invalidation and render gating, clean AG-UI EOF settlement, bounded Trash fanout with confirmed-count/unknown results, transient OAuth refresh preservation, bounded Gmail GET retry and 403 reason classification, read-only initial web consent with an explicit send upgrade, and an empty Mail Agent composer. Focused automated tests cover those paths. The legacy receipt sync in Slice 1 remains disabled. The P0 mailbox result is safe against blind replay, but its progress is not durable per message and batchModify acknowledgement loss is not yet reconciled against current labels. The send-status read cannot prove a Gmail send whose provider acceptance was never committed to the local ledger; that stays unknown and requires a Sent Mail check. The broader semantic evaluation, stage-level latency instrumentation, compose/modify scope upgrade, and public OAuth review remain later work. Do not treat this subset as satisfying every acceptance item below.

## Slice 1 — Preserve the committed Gmail history checkpoint before legacy sync reactivation

**Risk:** F02 is dormant while the legacy receipt writer and worker are disabled. If that path is re-enabled, a webhook stores its notification history ID in the connection before its worker commits. A generic failed run leaves the advanced ID in place; later incremental work can start after changes it never processed. A run that reaches its message cap while Gmail still returns nextPageToken, or records individual message errors, can also be marked completed and advance to the target history ID. A webhook received during an active run can be acknowledged without queueing a follow-on drain. The existing 404 history-gap branch has a bounded recovery path, so this slice targets generic failure, process interruption, incomplete pagination, individual message failure, and concurrent notifications.

**Change:** Keep the last *successfully processed* history ID as the worker start checkpoint. Store the latest *received notification* separately for coalescing and stale-notification handling, including notifications received while a run is active. Queue and restart from the committed checkpoint; advance it only after every history page and selected message in the bounded window is processed without unhandled errors and the run is durable. When a cap leaves nextPageToken or unprocessed IDs, retain a continuation or safely rescan from the older committed checkpoint; do not commit the target ID yet. A missing metadata batch result or per-message extraction failure must remain retryable or explicitly recorded as an incomplete item, not silently count as a complete interval. Preserve the existing owner/connection-generation guards. During migration, do not treat an old advanced history_id or even a completed run end_history_id as proven processed: use only a provably drained, error-free checkpoint, otherwise schedule a bounded/full reconciliation.

**Likely owners:** consent-protocol/hushh_mcp/services/gmail_receipts_service.py; its existing DB migration family and tests/services/test_gmail_receipts_service.py. Update the graph and receipt-sync reference after code lands.

**Acceptance:** With committed cursor 200, notification 210, worker failure, then notification 211 or process restart, the next worker reads from 200 and eventually commits through 211. Repeat with a message cap and nonempty nextPageToken, a missing metadata fetch, a per-message extraction error, and a notification arriving while a run is active: the checkpoint remains at 200 until all work is drained or safely reconciled, and a follow-on run is durable. Duplicate notifications do not duplicate receipts. A genuine Gmail 404 triggers the existing full-recovery behavior. Tests inspect persisted run and connection state, not only queue return values. No unreconciled connection is silently marked current.

## Slice 2 — Reconcile sends before offering another attempt

**Risk:** F01. The server fences the same send action, but a lost browser acknowledgement is currently rendered as a retryable failure. A new owner retry can mint a new idempotency key and send the message again. Gmail acceptance also does not prove final recipient delivery.

**Change:** Add an owner- and vault-authorized, privacy-safe send-action status read from gmail_owner_send_actions. Keep the original action ID attached to the visible attempt; on response loss, malformed response, proxy timeout, or reload, query that action and show recorded sent/accepted, still processing, or outcome unknown. Do not offer a fresh-key retry while the old action is unresolved. Treat ambiguous Gmail 5xx after POST as outcome_unknown; reserve definitive failed for an error known to have occurred before provider acceptance. Preserve envelope HMAC and the existing prepared-to-sending claim. For reload recovery, use a safe owner-bound recent-action lookup rather than persisting message bodies or a bearer-like action secret in browser storage. A ledger status read cannot prove Gmail accepted an action whose response was lost before a sent result was stored: retain unknown and direct the owner to Sent Mail unless a separate trustworthy provider correlation is designed and verified.

**Likely owners:** consent-protocol/hushh_mcp/services/gmail_delivery_service.py; api/routes/one/gmail_delivery.py; hushh-webapp/lib/services/email-delivery-service.ts; components/agent/email-draft-card.tsx, email-delivery-history-card.tsx agent-chat-workspace.tsx, and the mounted one-voice-mail-draft-bridge.tsx.

**Acceptance:** Fault-inject Gmail 200 followed by backend, proxy, and browser response loss separately, including a source-bound reply. The UI never labels the first attempt definitively failed, never creates a second Gmail message through its retry control, and can show the same recorded action after navigation/reload and vault unlock. When the ledger cannot prove provider acceptance, it stays unknown and blocks automatic retry. Same-action replay returns the recorded result; changed envelope remains rejected. Status responses contain no recipient, subject, body, token, or attachment content.

## Slice 3 — Clear receipt information at the shared disconnect boundary

**Risk:** F03. Backend disconnect removes Mail-derived rows, but Chat and other connector entry points clear connector status without clearing the session receipt cache. The Receipts table can hydrate and render stale rows while disconnected.

**Change:** Make the shared Gmail disconnect service/store clear the owner-scoped receipt cache and in-memory receipt projection on successful disconnect, regardless of caller. Gate table rendering on current connection and vault state as a second protection. Prevent a stale empty-server refresh from merging deleted cached rows back into state. Give all disconnect entry points one accurate explanation of local deletion and best-effort Google revocation; do not promise that the Google Account settings page changed unless confirmed.

**Likely owners:** hushh-webapp/lib/profile/gmail-connector-store.ts, lib/profile/gmail-receipts-cache.ts, lib/services/gmail-receipts-service.ts, components/gmail/gmail-receipts-page.tsx, components/agent/connector-read-receipt.tsx and other shared disconnect callers.

**Acceptance:** Disconnect from Chat, profile, connector panel, and Gmail workspace. With a previously populated cache, revisit Receipts, reload, and receive an empty server response: no receipt row is displayed or retained in sessionStorage. Account switch cannot reveal the prior owner's rows. A failed disconnect does not falsely claim server deletion. One focused UI/service test covers each distinct disconnect path without snapshotting markup.

## Slice 4 — Make stream termination explicit

**Risk:** F04. The active AG-UI client can await a terminal promise after a clean EOF that carried no RUN_FINISHED or RUN_ERROR. Email's internal planner/Gmail/interpreter hop is nonstreaming, so a slow read can look stuck even when the outer SSE connection is healthy.

**Change:** Define a terminal-event contract across the Next pass-through, FastAPI turn, and browser. If runAgent returns on EOF without a terminal event, settle the client as incomplete, stop the spinner, then query the persisted turn before offering a new attempt. Preserve intentional detach and confirmation-card behavior. Expose safe stage progress for Email planning, Gmail read, and synthesis without streaming private subjects, queries or bodies. Audit the separate personal-Gmail information-request scan SSE's complete/error/heartbeat handling against its own client; it is not the AG-UI stream.

**Likely owners:** hushh-webapp/lib/services/agent-chat-client.ts; consent-protocol/api/routes/one/agent_chat.py and hushh_mcp/one_adk/agui_turn_timing.py; nearest existing AG-UI client/server tests.

**Acceptance:** Automated streams covering normal finish, RUN_ERROR, explicit cancel, intentional card detach, socket failure, and clean truncated EOF all settle exactly once. Clean EOF cannot leave a pending spinner; history reconciliation distinguishes completed, still running, and incomplete turns. A card-detach/history test checks that one later model answer does not create a duplicate visible completion. Do not describe a deadlock or its frequency without runtime evidence.

## Slice 5 — Record mailbox effects accurately

**Risk:** F06. Per-message Trash POSTs can partly succeed before a later error, while the proposal is marked failed and the client says Gmail applied nothing. A lost batchModify acknowledgement is also ambiguous.

**Change:** Add durable per-message progress for Trash or a reconciliation operation tied to the existing exact-target proposal. Represent executed, partially executed, outcome unknown, and known failed states. Never re-run the entire target set blindly after a partial or unknown outcome. For batchModify, inspect current labels before saying the change failed after transport loss. Keep the original ten-minute review and owner confirmation boundary.

**Likely owners:** consent-protocol/hushh_mcp/services/gmail_mailbox_actions.py; api/routes/one/gmail_delivery.py; hushh-webapp/lib/services/email-delivery-service.ts and the mailbox review card.

**Acceptance:** First Trash POST succeeds and second returns 503; the owner sees a partial/unknown result, not “nothing changed.” A lost batchModify response is reconciled before retry. Proposal execution remains single-claim and cannot mutate newly matched messages without a new review.

## Slice 6 — Classify Google failures and request scopes in context

**Risks:** F05 and broad initial web consent. Current token refresh maps transient token-endpoint failures into needs_reauth, and several REST wrappers turn 403 quota/domain reasons into authorization failures.

**Change:** Make an explicit provider-error taxonomy from HTTP status and Google's error reason: invalid_grant/revocation, missing scope, domain policy, quota/rate, transient server/network failure, changed source, and unknown write outcome. Only confirmed invalid grant or revoked authority marks the connection needs_reauth. For idempotent GETs, honor Retry-After where present and use bounded jittered backoff inside the existing read deadline, with grant revalidation after waiting. Do not automatically retry send or ambiguous mutation POSTs. If concurrent refresh loses its compare-and-swap to a valid winner, re-read once and reuse that grant.

Then ship a real incremental-consent UX: initial web read requests gmail.readonly; Send requests gmail.send when the owner enters a send path; Gmail draft save requests gmail.compose; mailbox change requests gmail.modify. Handle partial grants as capability-specific states and keep web/native behavior aligned. The current combined web grant must remain until the new send path is reachable. Treat OAuth token revocation as best effort locally plus a durable retry/status path, without claiming provider revocation before evidence.

**Likely owners:** consent-protocol/hushh_mcp/services/gmail_receipts_service.py, gmail_metadata_reader.py and provider wrappers; Gmail connection UI and native Google Sign-In bridge; existing OAuth and reader tests.

**Acceptance:** Mock token refresh 429/503/timeout: connection stays usable and reports retryable. Mock invalid_grant: reconnect is required. Mock Gmail 403 rateLimitExceeded, userRateLimitExceeded, dailyLimitExceeded, domainPolicy, and missing scope: each yields the correct safe state. A denied send grant leaves reads working. A read-only new web connection does not request send; choosing Send can obtain it without disconnecting. Restricted-scope verification and assessment evidence is reviewed outside the repo before a public release.

## Slice 7 — Align the product contract and semantic acceptance

**Risks:** F07, one-operation coverage, and unrequested first-run work.

**Change:** Render metadata versus bounded body reads from the structured metadata_only result, and describe body/thread truncation accurately. Align internal capability naming and consent copy with the real body access; decide whether metadata and body are one explicitly disclosed read authority or separately granted actions before changing a scope name. Replace the first Mail Agent synthetic sample turn with an empty composer and optional suggestion, so entering the page does not run a model. Keep the dormant standalone Email chat endpoint clearly marked and either retire it through compatibility review or give it the same error/timeout contract before reactivation.

Expand semantic evaluation at the active feature-admitted path. Start with an outcome matrix for paraphrases, Hindi/Hinglish, negation, quoted or hypothetical “send,” recent/unread/sent/date searches, long threads, corrections, read-plus-draft requests, exact mailbox targets, and refusal when a grant is absent. For a later compound-read feature, plan all bounded reads from the owner's request before external mail content is exposed; allow only an editable draft suggestion after synthesis. No retrieved email instruction may choose a mutation or a recipient.

**Likely owners:** hushh-webapp/components/agent/connector-read-receipt.tsx; app/one/email/email-agent-page-client.tsx; lib/agent/email-agent-intro.ts; consent-protocol/hushh_mcp/agents/email/agent.yaml; delegated-read and first-tool evaluation fixtures.

**Acceptance:** Opening Mail Agent causes zero model or Gmail calls before the person's request. A body read is never labeled “Metadata only”; a truncated thread says what was omitted. Safety cases (negation, quoted commands, untrusted mail instructions) execute no send/modify. Each admitted read case checks final grounded answer, source refs and truncation, not merely first tool selected. Any compound behavior stays behind the same owner and review boundaries.

## Slice 8 — Optimize from stage-level evidence

**Risk:** The current 65-second Email hop and 20-second component deadlines are budgets, not observed speed. One routing, Email planning, Gmail fanout, Email interpretation and outer synthesis are serial on the critical path. Current Email-stage timing does not isolate them.

**Change:** Instrument privacy-safe phase durations and coarse outcomes for One route, Email planner, token refresh, Gmail list/fetch, interpreter, root resume, first visible status, first useful answer, review wait and final provider settlement. Report p50/p95/p99 by intent, surface and outcome, plus Gmail request count, 429/5xx, incomplete SSE, unknown send, partial modify and sync lag. Keep Gmail query, sender, subject, provider IDs, body and token out of telemetry. Use the baseline to set service objectives and decide whether simple metadata lists can use a deterministic presentation after semantic planning, while complex body interpretation remains tool-less. Reuse HTTP clients and tune per-owner concurrency only after request and 429 evidence.

**Likely owners:** consent-protocol/hushh_mcp/services/email_delegated_read.py, gmail_metadata_reader.py, gmail_receipts_service.py, one_adk/agui_turn_timing.py; active Chat client telemetry.

**Acceptance:** A dashboard or reproducible report separates model, provider, queue, review and transport wait. Privacy review confirms no mail content in traces. Record baseline p50/p95/p99 and error rates before setting or claiming a speed target; rerun the same intent set after each optimization.

## Final release gate and rollback

- Run focused fault-injection tests for slices 1–6 and active-path semantic tests for slice 7, followed by web/native automated journeys using test accounts. Do not use a person's Chrome session as the verification fixture.
- Recheck API/schema and DB migration compatibility, grant revocation, cache deletion, One conversation restore, and the separate platform KYC mailbox boundary. Update the current graph, owner-approved Gmail contract, package references and docs indexes in the same change.
- Preserve durable send and sync records through rollback. If status reconciliation is unavailable, suppress fresh-key retry and show an honest unknown state. If a new read-plan feature misroutes, disable it through the existing Email read admission switch without changing Gmail OAuth or existing receipts.
- A release claim needs evidence of one-provider-send after acknowledgement loss, no skipped history after failed sync, no visible deleted receipt after every disconnect entry, settled clean EOF, correct Google failure classes, and grounded semantic outcomes. Static inspection alone does not satisfy this gate.
