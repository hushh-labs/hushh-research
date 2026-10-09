# One Email Knowledge Graph

Status: current-code evidence graph, audited 2026-10-09 with implementation dispositions below. This page describes the personal Gmail surface in this checkout. It is context for people and agents, not a runtime router, permission grant, or claim of live provider acceptance. The [owner-approved delivery contract](./gmail-owner-approved-email.md) remains the delivery authority. Earlier work lives in the [reliability plan](../../superpowers/plans/2026-10-09-one-email-reliability-plan.md).

The [Email and Calendar read/voice plan](../../superpowers/plans/2026-10-09-one-email-calendar-read-voice-plan.md) records the 2026-10-09 follow-up audit and implementation wave. The fault edges below distinguish code-backed risk from observed incidents.

## Visual Map

~~~mermaid
flowchart LR
  owner["Owner"] --> entry["Mail entry / workspace"]
  entry --> chat["Typed One Chat"]
  owner --> voice["One Live Voice when enabled"]
  voice --> read
  chat --> read["Email delegated read"]
  read --> plan["Read planner"]
  plan --> gmail["Gmail REST"]
  gmail --> interpret["Tool-less interpreter"]
  interpret --> stream["One AG-UI stream"]
  stream --> owner
  chat --> draft["Editable draft"]
  voice --> draft
  draft --> send["Reviewed send ledger"]
  send --> gmail
  chat --> proposal["Mailbox proposal"]
  proposal --> execute["Owner-confirmed change"]
  execute --> gmail
  gmail --> push["Pub/Sub notification"]
  push -. disabled cutover .-> sync["Legacy watch / history sync"]
  sync -.-> gmail
  sync -.-> receipts["Existing receipt rows"]
  receipts --> cache["Browser receipt cache"]
  cache --> entry
  entry --> monitor["Opt-in information-request monitor"]
  monitor --> draft
~~~

The diagram shows capability flow. The node and edge ledger below states the authority, data, and outcome boundaries. A line in the diagram alone grants no access.

## Scope and evidence keys

- Personal Gmail uses one connection owned by GmailReceiptsService. The One Email KYC platform mailbox is a separate workflow and credential boundary; see [owner-approved delivery](./gmail-owner-approved-email.md).
- Active user paths include Mail Agent and Gmail workspace handoff to typed One Chat, and the separately gated One Live Voice mail tools. Voice reads use the delegated Email read service but reveal only status/count to the operational voice model; the owner sees the answer on screen. Voice compose/review uses an editable draft card and the owner-approved send path. The standalone Email chat API exists, but GmailChatPanel has no production mount; the Email specialist manifest's typed entry does not define the separate Live Voice tool registry.
- Google-hosted Gmail MCP adapter code exists but is gated off by HOSTED_WORKSPACE_MCP_ENROLLED = False. Current calls use Google OAuth plus Gmail REST. Feature admission and internal capability names are not Google OAuth scopes.
- The server-side receipt writer and sync worker are disabled by the `legacy_read_only` cutover. Existing receipt rows remain readable; the disabled legacy sync path is retained code, not a live UAT capability. This is separate from turn-local Gmail reads and the information-request workflow.

| Key | Checked-in evidence path |
| --- | --- |
| WEB_ENTRY | hushh-webapp/app/one/email/email-agent-page-client.tsx |
| WEB_WORKSPACE | hushh-webapp/components/gmail/gmail-receipts-page.tsx |
| WEB_CHAT | hushh-webapp/lib/services/agent-chat-client.ts |
| WEB_RECEIPT | hushh-webapp/components/agent/connector-read-receipt.tsx |
| WEB_DRAFT | hushh-webapp/components/agent/email-draft-card.tsx |
| WEB_DELIVERY | hushh-webapp/lib/services/email-delivery-service.ts |
| WEB_HISTORY | hushh-webapp/components/agent/email-delivery-history-card.tsx |
| WEB_CONNECTOR | hushh-webapp/lib/profile/gmail-connector-store.ts |
| WEB_CACHE | hushh-webapp/lib/profile/gmail-receipts-cache.ts |
| ONE | consent-protocol/hushh_mcp/one_adk/agent_tree.py |
| MANIFEST | consent-protocol/hushh_mcp/agents/email/agent.yaml |
| BRIDGE | consent-protocol/hushh_mcp/adk_bridge/email_agent.py |
| DELEGATE | consent-protocol/hushh_mcp/services/email_delegated_read.py |
| READER | consent-protocol/hushh_mcp/services/gmail_metadata_reader.py |
| OAUTH_SYNC | consent-protocol/hushh_mcp/services/gmail_receipts_service.py |
| CUTOVER | consent-protocol/hushh_mcp/services/gmail_receipt_cutover.py |
| SEND | consent-protocol/hushh_mcp/services/gmail_delivery_service.py |
| SEND_ROUTE | consent-protocol/api/routes/one/gmail_delivery.py |
| MODIFY | consent-protocol/hushh_mcp/services/gmail_mailbox_actions.py |
| CHAT_ROUTE | consent-protocol/api/routes/one/agent_chat.py |
| LEGACY | consent-protocol/api/routes/one/email_chat.py |
| MCP_GATE | consent-protocol/hushh_mcp/one_adk/governed_mcp_toolset.py |
| INFO_ROUTE | consent-protocol/api/routes/one/gmail_information_requests.py |
| VOICE_MAIL | consent-protocol/hushh_mcp/one_voice/tools/mail.py |
| VOICE_BRIDGE | hushh-webapp/components/one-voice/one-voice-mail-draft-bridge.tsx |
| VOICE_GATE | consent-protocol/hushh_mcp/one_voice/config.py |

Line references below are to these evidence paths in this audit. Recheck them when an owner changes.

## Node ledger

| ID | Kind | Current role |
| --- | --- | --- |
| U | actor | Authenticated owner, whose explicit request or UI confirmation starts each capability. |
| S1 | surface | Mail Agent and Gmail workspace entry. |
| S2 | surface | Active typed One Chat with AG-UI SSE transport. |
| S3 | surface | Editable draft and mailbox review cards. |
| S4 | surface, dormant UI | Standalone GmailChatPanel and nonstreaming Email chat API. |
| S5 | surface, gated | One Live Voice mail read and editable draft bridge; active when the Live Voice rollout gate permits. |
| G1 | deployment gate | Hosted Workspace MCP enrollment switch, currently false. |
| A1 | authority | Firebase identity plus current vault-owner token for owner-bound delivery routes. |
| A2 | authority | Typed-chat feature admission and internal Email invocation capability. |
| A3 | authority | Google OAuth grant set: gmail.readonly; gmail.send; incremental gmail.compose and gmail.modify. |
| C1 | credential store | kai_gmail_connections, encrypted access/refresh tokens, grant/account observation, sync cursor. |
| R1 | intelligence | One's semantic tool selection and outer conversation context. |
| R2 | intelligence | Email read planner: current request and owner time context, one read operation. |
| R3 | service | GmailMetadataReader: bounded, grant-rechecked Gmail read. |
| R4 | intelligence | Tool-less Email interpreter and source-reference validation. |
| R5 | runtime, reachable API | Standalone nonstreaming EmailChatService with its own encrypted chat history. |
| R6 | intelligence boundary | One Live Voice calls the same delegated read but sees a model-public status/count; mail answer text goes to the client frame. |
| P1 | provider | Google OAuth token endpoint and Gmail REST API. |
| P2 | provider adapter, dormant | Google-hosted Gmail MCP code, disabled for curated Gmail execution. |
| N1 | external ingress | Authenticated Pub/Sub webhook notification; it signals change, not a completed receipt sync. |
| W1 | action | Client-only editable draft directive and draft card. |
| W2 | action store | gmail_owner_send_actions: reviewed envelope/idempotency HMAC and send outcome. |
| W3 | action store | gmail_mailbox_action_proposals: exact-target review, claim and owner-confirmed executor. |
| Y1 | sync, dormant | Legacy Gmail watch/webhook/history worker and receipt extraction, disabled by cutover. |
| D1 | data store | Existing server-side Gmail-derived receipt rows in kai_gmail_receipts; new writes are blocked. |
| D2 | browser cache | Session-scoped receipt cache shown by the Receipts tab. |
| D3 | workflow store | Opt-in personal-Gmail information-request preferences, requests and scan state. |
| M1 | memory boundary | Owner-reviewed shopping-summary Save, separate from receipt ingestion. |
| I1 | workflow | Opt-in personal-Gmail information-request monitor, source preview and source-bound reply. |
| X1 | boundary | One Email KYC platform mailbox, outside this personal Gmail graph. |

## Typed edge ledger

| Edge | From -- relation --> To | Current contract and evidence |
| --- | --- | --- |
| E01 | U -- opens --> S1 -- hands off --> S2 | Connected Mail Agent opens typed One Chat with an empty composer; only the owner's request starts a turn. WEB_ENTRY:47-50,96-98. |
| E02 | U -- authenticates --> A1 | Delivery endpoints require matching Firebase and vault owner. SEND_ROUTE:95-105,160-188,270-308. |
| E03 | S2 -- admits --> A2 -- delegates --> R1 | Typed-only and feature-gated ask_email_agent; owner-bound bridge checks the token. ONE:790-813,1918-1931; BRIDGE:40-70. |
| E04 | R1 -- selects --> R2 | One semantically chooses Email delegation; the Email planner then selects one structured read or clarification. ONE:790-813; MANIFEST:93-118; DELEGATE:145-184. |
| E05 | R2 -- permits --> R3 -- checks --> A3/C1 | Read planner sees current request and time context, not credentials or chat history; reader observes and revalidates the grant. DELEGATE:121-159,184-202; READER:283-322. |
| E06 | R3 -- GET --> P1 | Current search/message/thread read uses users/me Gmail REST, one page and capped content. READER:29-60,337-528. |
| E07 | P1 -- bounded untrusted result --> R4 | Tool-less interpreter receives selected metadata or body text; answer source refs are checked. DELEGATE:187-225; MANIFEST:149-167. |
| E08 | R4 -- result --> R1 -- SSE --> S2 | Email hop returns structured status, truncation and sources; One's outer turn streams to the client. DELEGATE:96-118,219-225; CHAT_ROUTE:487-544; WEB_CHAT:1014-1039. |
| E09 | R1 -- proposes --> W1 -- reviewed by --> U | Draft tool creates a client-only editable card; it does not create a Gmail draft or send. ONE:1785-1861; WEB_DRAFT:337-389. |
| E10 | U -- Send click --> W2 -- executes --> P1 | Prepare binds the exact envelope and idempotency key; execute claims prepared to sending before users.messages.send. SEND_ROUTE:184-224,270-308; SEND:597-712,790-923. |
| E11 | W2 -- records --> S3 | Server states include sent, failed and outcome_unknown. A same-action, owner/vault-authorized status read lets Chat and the Voice bridge check a lost response without another send. SEND_ROUTE:413-454; WEB_DELIVERY:337-365. |
| E12 | R1 -- proposes --> W3 -- confirmed by --> U | Model may request exact mailbox targets, but only the owner's review executes archive, labels, read state or Trash. ONE:805-811; MODIFY:93-223. |
| E13 | W3 -- POST --> P1 | batchModify handles labels/read/archive; Trash uses per-message POSTs. MODIFY:194-243. |
| E14 | U -- connects --> A3 -- stored in --> C1 | Web OAuth signs state, exchanges code and encrypts tokens. Initial web read asks for gmail.readonly; reviewed send requests gmail.send separately. OAUTH_SYNC:922-1020,1148-1240,1688-1859. |
| E15 | C1 -- historically authorized --> Y1 -- read --> P1 | Legacy watch/history sync used the owner Gmail connection. The cutover disables queue and worker execution. CUTOVER:1-38; OAUTH_SYNC:4019-4033,4183-4192. |
| E24 | P1 -- watch event --> N1 -- legacy signal --> Y1 | Pub/Sub ingress is distinct from a completed sync; the disabled queue does not produce new receipt rows. CUTOVER:1-38; OAUTH_SYNC:3718-3808. |
| E16 | D1 -- projects --> D2 | Existing receipt rows remain readable and may hydrate the browser session cache. New legacy receipt writes are blocked. CUTOVER:1-38; WEB_WORKSPACE:501-560,611-641; WEB_CACHE:6-93. |
| E17 | D1 -- reviewed Save --> M1 | Receipt ingestion alone is not private memory; a shopping summary requires a separate Save control. WEB_WORKSPACE:2251-2359. |
| E18 | U -- disconnects --> C1/D1 | Backend disables connection, clears tokens and Mail-derived rows, and attempts Google token revocation. OAUTH_SYNC:2018-2027,2081-2198. |
| E19 | S4 -- JSON turn --> R5 | The authorized standalone API is nonstreaming and uses its own encrypted conversation history; its panel is not imported by a production component. LEGACY:1-56; consent-protocol/hushh_mcp/services/email_chat_service.py:174-266; hushh-webapp/components/gmail/gmail-chat-panel.tsx:44-78. |
| E20 | G1 -- disables --> P2 | MCP_GATE:129-132; consent-protocol/hushh_mcp/one_adk/workspace_mcp_tools.py:339-370. |
| E21 | X1 -- separate from --> C1/W2 | Platform KYC mailbox is not the owner's Gmail credential or personal send ledger. SEND_ROUTE:1-5; owner-approved delivery contract above. |
| E22 | S1 -- opts in to --> I1 -- persists --> D3 | Personal-Gmail information-request monitoring has separate owner-gated scan and scan-stream routes. INFO_ROUTE:246-357; consent-protocol/hushh_mcp/services/gmail_personal_information_request_service.py. This scan SSE is separate from S2's AG-UI stream. |
| E23 | I1 -- source-binds --> W1/W2 | A selected reply derives recipient/thread server-side and still needs the owner's review. INFO_ROUTE:382-445; ONE:1864-1915; SEND_ROUTE:128-157. |
| E25 | U -- speaks via --> S5 -- delegates read --> R2/R3/R4 | One Live Voice uses bounded Email delegated reads when enabled; its operational model receives a status/count receipt while the answer is shown to the owner. VOICE_GATE:116-158; VOICE_MAIL:1-63,376-430. |
| E26 | S5 -- prepares --> W1 -- owner reviews --> W2 | Voice compose/reply tools open an editable card, and the mounted bridge uses the same reviewed send ledger. Voice confirmation and Send tap are distinct steps. VOICE_MAIL:1-20; VOICE_BRIDGE:1-74; hushh-webapp/components/agent/agent-owner-gate.tsx:1-46. |

## Audited fault edges and current disposition

These are code-path findings and current mitigation boundaries, not measured production incident rates.

| ID | Edge and consequence | Current disposition / evidence |
| --- | --- | --- |
| F01 | A lost send acknowledgement previously looked retryable. | Mitigated for Chat and the mounted Voice draft bridge: pending action IDs are owner-scoped in session storage, status reads return ledger state, and unresolved attempts do not offer fresh-key retry. If Gmail accepted a POST but the server never recorded it, the state remains unknown and the owner checks Sent Mail. SEND_ROUTE:413-454; WEB_DRAFT:450-535; WEB_DELIVERY:53-130,337-365. |
| F02 | Dormant legacy path: webhook and worker cursor handling could skip unprocessed changes after failed, capped or concurrent work if receipt sync is re-enabled without redesign. The current cutover blocks receipt writes and worker execution. | Code-path inference, not an active UAT incident. CUTOVER:1-38; OAUTH_SYNC:3762-3801,3908-3910,3950-3984,4205-4216,4351-4387,4431-4455. |
| F03 | Disconnect once left receipt rows in the browser cache. | Mitigated at the shared disconnect boundary and the Receipts render gate, including owner/account changes; backend deletion remains authoritative. WEB_CONNECTOR; WEB_CACHE; WEB_WORKSPACE. |
| F04 | A clean truncated SSE EOF could leave S2 awaiting a terminal event. | Mitigated by a bounded parser grace, one incomplete settlement and SDK abort; explicit interrupt/detach remains separate. WEB_CHAT; streaming implementation guide. |
| F05 | A temporary OAuth token-endpoint failure could mark a usable connection revoked; Gmail 403 reasons were collapsed. | Transient refresh failures now preserve the grant, while invalid_grant requires reconnection. Bounded, structured 403 reasons and one deadline-bound GET retry distinguish quota, policy and permission. OAUTH_SYNC; READER; DELEGATE. |
| F06 | A partial Trash or ambiguous batchModify result could be described as no change. | Bounded Trash fanout now reports confirmed count and uncertainty; ambiguous proposals stay consumed, and client copy tells the owner to check Gmail. Durable per-message progress and post-reload reconciliation remain open in plan Slice 5. MODIFY; WEB_DELIVERY. |
| F07 | The Chat read receipt labeled bounded body reads “Metadata only”; the internal capability name remains cap.email.metadata.read. | Visible receipt copy now follows metadata_only. Internal naming and consent wording still need the contract decision in plan Slice 7. DELEGATE; WEB_RECEIPT; MANIFEST. |

| F08 | Typed positional follow-ups can target the wrong message after a new arrival. | Closed in this branch: the Email A2A bridge returns a private owner/conversation/account-bound five-minute exact-ID offer in encrypted ADK state. The semantic planner sees only positions; an invalid or absent offer clarifies instead of fetching newest. BRIDGE; DELEGATE; one_adk/agent_tree.py. |
| F09 | “Needs reply” can sound definitive without reading message meaning. | Delegated-read copy now says possible replies because the nudge is based on recent inbound metadata. Body-based semantic task classification remains open. READER; consent-protocol/hushh_mcp/services/gmail_nudges.py. |
| F10 | A valid source reference does not prove a sentence is entailed. | The interpreter is tool-less and source refs are checked, but freeform answer facts are not verified against excerpts. A cited invented amount can pass. DELEGATE:635-676. |
| F11 | Live Voice exposes overlapping mail send paths. | Negotiated tool declarations now omit legacy send/reply on review-capable clients, and the executor rejects their legacy route. Older clients retain their compatible path. one_voice/tools/registry.py; one_voice/tools/executor.py. |
| F12 | An immediate claimed send can remain sending after process cancellation. | An owner/vault-authorized status reconciliation settles a stale immediate sending row to non-retryable outcome_unknown after five minutes; it never posts to Gmail. The normal GET stays read-only. SEND; api/routes/one/gmail_delivery.py. |
| F13 | A two-phrase English draft override bypasses semantic drafting. | The substring override is removed. Draft text now follows the semantic drafting path; negated phrase regression is covered. SEND; tests/test_email_runtime.py. |
| F14 | Read breadth and speed have unverified limits. | Planner allows one operation; list/body/thread caps are bounded. Plan/fetch/analyze/interpret and Chat/Voice turn timing exist, but no p95 by intent or evidence that a 105-second budget is normal latency. DELEGATE:54-85,97-114,439-459; READER:55-60. |

## Graph invariants

1. Invocation authority A2, owner/data authority A1, and Google provider grant A3 are independent. A chat tool name cannot supply a missing grant or replace the owner's Send/modify confirmation.
2. Email from P1 is untrusted information. R2 chooses the read before R4 sees it; R4 has no tools; source refs and grant freshness are checked before a reply is released.
3. A screen card, an SSE event, or a queued sync job is not a committed provider outcome. W2, W3, and Y1 need their own authoritative settlement.
4. C1, D1 and D2 are connector credentials/cache/workflow state, not encrypted PKM memory. Only the separately reviewed M1 action can save a summary into private memory.
5. One Live Voice's separately gated mail tools are an active product path when Live Voice is enabled; the Email specialist manifest's typed-only entry does not remove them. S4 and P2 remain retained paths, not current product entrypoints.

Refresh this graph after changes to OAuth scopes, the Email manifest, Chat admission, delivery/mailbox state machines, sync cursor, cache deletion, or streaming transport. Promote completed plan work into the owning code and canonical contracts; keep this ledger about current behavior.
