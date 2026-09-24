# Observability Event Matrix

## Visual Context

Canonical visual owner: [Observability Architecture Map](./observability-architecture-map.md). Use that map for topology and reporting boundaries; this page is the event taxonomy and emitter map beneath it.

This matrix documents the maintained One-platform observability contract:

1. what each event means
2. which params are required
3. where it is emitted
4. where it is consumed
5. how it is verified

Every emitted observability event carries centrally added shared params:

- `env`
- `platform`
- `event_category`

`event_category` is one of `funnel`, `feature`, or `system`.

## Navigation and Auth

| Event | Business purpose | Required params | Primary emitter | Destination use | Proof path |
| --- | --- | --- | --- | --- | --- |
| `page_view` | Route-level navigation baseline for web and native shells | `route_id` | `hushh-webapp/components/observability/route-observer.tsx`, `hushh-webapp/lib/observability/client.ts` | GA DebugView, route sanity, dashboard context joins | `npm run verify:analytics`, GA DebugView |
| `auth_started` | Start of Google / Apple / reviewer / redirect auth flow | `action` | `hushh-webapp/components/onboarding/AuthStep.tsx` | auth funnel drop-off and login friction | GA DebugView, auth flow smoke |
| `auth_succeeded` | Successful fresh auth completion | `action`, `result` | `hushh-webapp/components/onboarding/AuthStep.tsx` | auth success tracking, growth step support signal | GA DebugView, investor/RIA walkthrough |
| `auth_failed` | Auth failure with coarse error class only | `action`, `result` | `hushh-webapp/components/onboarding/AuthStep.tsx` | auth error rate and failure-mode visibility | GA DebugView, manual failure test |

## Kai Onboarding, Import, and Analysis

| Event | Business purpose | Required params | Primary emitter | Destination use | Proof path |
| --- | --- | --- | --- | --- | --- |
| `onboarding_started` | Entered Kai onboarding flow | `source` | `hushh-webapp/app/kai/onboarding/page.tsx` | onboarding session start | GA DebugView |
| `onboarding_step_completed` | Preference or persona step completion result | `action`, `result` | `hushh-webapp/app/kai/onboarding/page.tsx` | step-level friction and abandon points | GA DebugView |
| `onboarding_completed` | Final onboarding completion or skip | `action`, `result` | `hushh-webapp/app/kai/onboarding/page.tsx` | supporting signal for investor funnel | GA DebugView, funnel SQL |
| `import_upload_started` | Portfolio import upload started | `result` | `hushh-webapp/lib/services/api-service.ts` | import-start baseline and drop-off | GA DebugView |
| `import_parse_completed` | Portfolio import parse finished | `result` | `hushh-webapp/lib/services/api-service.ts`, `hushh-webapp/components/kai/kai-flow.tsx` | parse success/error rate | GA DebugView |
| `import_quality_gate_passed` | Import passed validation | `result` | `hushh-webapp/lib/services/api-service.ts`, `hushh-webapp/components/kai/kai-flow.tsx` | portfolio quality signal | GA DebugView |
| `import_quality_gate_failed` | Import failed validation | `result` | `hushh-webapp/lib/services/api-service.ts`, `hushh-webapp/components/kai/kai-flow.tsx` | import quality failures | GA DebugView |
| `import_save_completed` | Parsed import save result | `result` | `hushh-webapp/lib/services/api-service.ts`, `hushh-webapp/components/kai/kai-flow.tsx` | save completion baseline | GA DebugView |
| `market_insights_loaded` | Market insights baseline load health | `result` | `hushh-webapp/lib/services/api-service.ts` | latency/status quality | GA DebugView, API health checks |
| `portfolio_viewed` | Usable portfolio state rendered to the user | `result`, `portfolio_source` | `hushh-webapp/components/kai/views/dashboard-master-view.tsx` | high-intent product engagement and platform mix | `npm run verify:analytics`, sandbox audit, BigQuery feature query |
| `recommendation_viewed` | Final recommendation visible to the user | `result`, `portfolio_source` | `hushh-webapp/app/kai/analysis/page.tsx` | high-intent product engagement and investor activation support | `npm run verify:analytics`, sandbox audit, BigQuery feature query |
| `profile_picks_loaded` | Profile picks load health | `result` | `hushh-webapp/lib/services/api-service.ts` | product readiness and latency | GA DebugView |
| `analysis_stream_started` | Analysis stream session started | `result` | `hushh-webapp/lib/services/api-service.ts` | analysis start rate | GA DebugView |
| `analysis_stream_terminal_decision` | Stream reached final terminal decision | `result` | `hushh-webapp/components/kai/debate-stream-view.tsx` | product completion and investor activation support | GA DebugView, investor funnel validation |
| `analysis_stream_aborted` | Stream ended through an expected early-stop path | `result` | `hushh-webapp/lib/services/api-service.ts` | controlled abort rate | GA DebugView |
| `analysis_stream_error` | Stream ended with an error | `result` | `hushh-webapp/lib/services/api-service.ts` | analysis failure rate | GA DebugView |

## Consent, Vault, and Account Operations

| Event | Business purpose | Required params | Primary emitter | Destination use | Proof path |
| --- | --- | --- | --- | --- | --- |
| `consent_pending_loaded` | Pending consent load outcome | `result`, `load_surface`, `pending_count_bucket` | `hushh-webapp/lib/services/api-service.ts` | consent inbox health; separates an ignored queue from an empty one, and a real screen view from the unlock warm prefetch | GA DebugView |
| `consent_action_submitted` | Approve / deny / revoke submitted | `action`, `result` | `hushh-webapp/lib/services/api-service.ts` | consent action attempts | GA DebugView |
| `consent_action_result` | Approve / deny / revoke resolved | `action`, `result` | `hushh-webapp/lib/services/api-service.ts` | consent action success/failure outcomes | GA DebugView |
| `profile_method_switch_result` | Vault/profile method switch outcome | `result` | `hushh-webapp/lib/services/vault-method-service.ts` | vault/profile migration health | GA DebugView |
| `phone_verification_started` | Phone verification challenge started | `action`, `result` | `hushh-webapp/components/auth/phone-verification-flow.tsx` | phone mandate health without phone values | GA DebugView |
| `phone_verification_completed` | Phone verification challenge completed | `action`, `result` | `hushh-webapp/components/auth/phone-verification-flow.tsx` | phone mandate completion and error rate without phone values | GA DebugView |
| `account_delete_requested` | Account deletion requested | `result` | `hushh-webapp/lib/services/account-service.ts` | destructive-flow baseline | GA DebugView |
| `account_delete_completed` | Account deletion final outcome | `result`, `status_bucket` | `hushh-webapp/lib/services/account-service.ts` | destructive-flow completion and errors | GA DebugView |

## RIA Lifecycle

| Event | Business purpose | Required params | Primary emitter | Destination use | Proof path |
| --- | --- | --- | --- | --- | --- |
| `persona_switched` | App persona switch surface selected investor or RIA | `action`, `result` | `hushh-webapp/components/app-ui/top-app-bar.tsx` | RIA top-of-funnel continuity for authenticated users | GA DebugView, RIA funnel SQL |
| `ria_onboarding_submitted` | RIA onboarding form submitted | `result` | `hushh-webapp/app/ria/onboarding/page.tsx` | RIA onboarding start/completion quality | GA DebugView |
| `ria_verification_status_changed` | Verification decision returned for an RIA onboarding submission | `action` (status reached), `result` (`expected_error` on rejection) | `hushh-webapp/lib/observability/ria-events.ts` via `hushh-webapp/app/ria/onboarding/page.tsx` | RIA verification outcome rate; distinguishes a submitted profile from an approved one | `npm run verify:analytics`, GA DebugView |
| `marketplace_profile_viewed` | Marketplace RIA profile rendered usable public profile state | `action`, `result` | `hushh-webapp/app/marketplace/ria/page-client.tsx` | marketplace high-intent engagement | GA DebugView, feature engagement SQL |
| `ria_request_created` | RIA request creation result | `result` | `hushh-webapp/lib/services/ria-service.ts` | RIA request creation KPI support | GA DebugView, RIA funnel SQL |
| `ria_workspace_opened` | RIA client workspace opened | `result` | `hushh-webapp/components/ria/use-ria-client-workspace-state.ts` | workspace readiness and activation support | GA DebugView, RIA funnel SQL |

## Gmail and Receipt Operations

| Event | Business purpose | Required params | Primary emitter | Destination use | Proof path |
| --- | --- | --- | --- | --- | --- |
| `gmail_connect_started` | Gmail connect flow started | `action`, `result` | `hushh-webapp/lib/services/gmail-receipts-service.ts` | Gmail onboarding baseline | GA DebugView |
| `gmail_connect_result` | Gmail connect start/complete result | `action`, `result` | `hushh-webapp/lib/services/gmail-receipts-service.ts` | Gmail connection quality | GA DebugView |
| `gmail_disconnect_result` | Gmail disconnect outcome | `result` | `hushh-webapp/lib/services/gmail-receipts-service.ts` | disconnect success/error rate | GA DebugView |
| `gmail_sync_requested` | Manual Gmail sync requested | `action`, `result` | `hushh-webapp/lib/services/gmail-receipts-service.ts` | sync request volume | GA DebugView |
| `gmail_sync_result` | Gmail sync queue/already-running result | `action`, `result` | `hushh-webapp/lib/services/gmail-receipts-service.ts` | sync queue health | GA DebugView |
| `gmail_receipts_loaded` | Receipt list load result | `result` | `hushh-webapp/lib/services/gmail-receipts-service.ts` | receipts UX quality | GA DebugView |

## One feature-action observability (rollout contract)

These are deliberate *feature* actions, not proof that a specialist AI agent was invoked. Each event carries only a fixed `route_id`, bounded `action`, and `result`. The common adapter adds environment and platform. No memory text/domain, card data or reveal, calendar contents, KYC scopes, counterparty, workflow ID, email, or error message may be sent. Count distinct account IDs only when GA4 actually receives a stable User-ID; device/browser counts remain a separate diagnostic.

| Event | Bounded actions | Emitter | Dashboard interpretation |
| --- | --- | --- | --- |
| `one_memory_action` | `capture_prepared`, `capture_saved`, `detail_edited`, `detail_deleted`, `export_saved`, `auto_save_changed` | Memory workspace after a completed action | Memory adoption and action mix; a prepared review is not a save |
| `one_wallet_action` | `card_added`, `card_deleted` | Owner Wallet workspace after service success | Card-management activity, never card contents or reveal count |
| `one_calendar_action` | `connected`, `disconnected`, `chat_opened` | Calendar owner workspace, or the verified same-window OAuth callback when no popup attempt exists | Connector adoption and assistance handoffs; opening chat is not an agent answer |
| `one_kyc_action` | `access_approved`, `access_denied`, `redraft_completed`, `reply_sent`, `reply_rejected`, `workflow_refreshed` | One KYC workflow after the corresponding confirmed operation | KYC workflow progress; reply sent is counted even if subsequent encrypted PKM writeback fails |
| `one_crm_action` | `record_created`, `record_updated`, `record_deleted` | Development-only Connected Systems workspace after confirmed mutations | Developer diagnostics only; excluded from the production founder and One capability KPIs |

These emitters are in the client release. Until a representative event is observed in the selected GA4 export, the dashboard shows **not yet measured**, not zero. iOS needs a shipped native build before new client events appear from public iPhones. CRM / Connected Systems remains feature-flagged and development-only, so it is not presented as a production customer KPI.

The owned `consent-protocol/scripts/observability/ga4_growth_dashboard_queries.sql` feature-engagement, platform-mix, health, and freshness queries include the four production feature-action events. They group the bounded action and result and report device/browser identifiers separately from identified accounts. `one_crm_action` is deliberately absent from those production queries.

The web route observer now runs inside validated auth context and binds the analytics ID before a route view. This removes one known ordering risk, but historical web account coverage cannot be retroactively repaired. Verify the user-ID field on a fresh signed-in UAT journey and in the subsequent BigQuery export before calling the web user total complete.

## One Location Behaviour

One Location reporting combines web, iOS, and Android into one product total.
The `platform` context remains attached only so operators can prove that every
supported surface is flowing; it is not a separate product scorecard. Counts
are device/browser analytics until account identity is consistently bound on
all three surfaces.

| Event | Business purpose | Required params | Primary emitter | Destination use | Proof path |
| --- | --- | --- | --- | --- | --- |
| `one_location_share_confirmed` | Live-location share outcome | `route_id`, `result`, selected/success/failure counts, duration bucket | `hushh-webapp/lib/observability/location-events.ts` | combined Location feature adoption and technical success | `npm run verify:analytics`, metrics Location drill-down |
| `one_location_check_in_completed` | One-off Check-In outcome distinct from live sharing | `route_id`, `result`, selected/success/failure counts, `circle_targeted` | One Location Check-In flow | Check-In adoption and reliability | `npm run verify:analytics`, metrics Location drill-down |
| `one_location_check_out_completed` | Confirmed end of an active nearby Check-In; excludes failed or no-op checkout attempts | `route_id`, `result=success` | One Location nearby Check-In flow, after server checkout confirmation | Check-Out completion and journey reporting | nearby Check-In component tests, observability schema test, metrics Location drill-down |
| `one_location_sos_triggered` | Save My Soul/SMS outcome without location, message, or recipient data | `route_id`, `result`, aggregate reach counts, `has_note` | One Location SMS flow | safety-feature adoption and delivery failures | `npm run verify:analytics`, metrics Location drill-down |
| `one_location_request_sent` | Request Location send outcome | `route_id`, `result`, aggregate selected/success/failure counts, `has_note` | One Location request composer | request adoption and send reliability | `npm run verify:analytics`, metrics Location drill-down |
| `one_location_contact_signal_synced` | Contact-sync result | `route_id`, `result`, source, count bucket, aggregate match/invite counts | `hushh-webapp/lib/contacts/use-contact-sync.ts` | contact-sync completion and quality | contact-sync tests, metrics Location drill-down |
| `one_location_public_link_created` | Public live-location link creation | `route_id`, `result`, duration bucket, clipboard flag, active count | One Location Links flow | public-sharing creation and failure rate | `npm run verify:analytics`, metrics Location drill-down |
| `one_location_circle_invite_created` | Invite-to-One link creation | `route_id`, `result`, duration bucket, clipboard flag, active count | One Location invite flow | invitation adoption and failure rate | `npm run verify:analytics`, metrics Location drill-down |
| `one_location_circle_created` | Named Circle creation and type mix | `route_id`, `result`, `circle_kind` | One Location and Connect Circles | Circles created in-range by Family/Friends/Custom | Circle tests, metrics Location drill-down |
| `one_location_journey_action` | Cross-surface Connect, invitations, Circles, request fulfilment, public/share views, and nearby Check-In results | `route_id`, `action`, `result`, `entry_surface`, `target_type`; optional low-cardinality kind/count bucket | shared Location observability helper, contact-sync/invitation hooks, Connect Circles, consent actions, public-link view, nearby Check-In | combined end-to-end journey reach, Circle engagement, and successful/failed nearby Check-Ins | `npm run verify:analytics`, schema privacy test, targeted Connect/Circle/nearby Check-In tests |

The journey event must never contain IDs, Circle names, contact values,
coordinates, invite codes, public tokens, messages, or other free text. The
allowlist is enforced in `hushh-webapp/lib/observability/schema.ts`; the
dashboard receives only BigQuery aggregates. Newly added journey rows render as
“measuring after rollout” until this event is observed in the production export.

## Growth Funnel Canonical Events

| Event | Business purpose | Required params | Primary emitter | Destination use | Proof path |
| --- | --- | --- | --- | --- | --- |
| `growth_funnel_step_completed` | Canonical step transition for `investor` and `ria` journeys | `journey`, `step`, `app_version`, `event_category` | `hushh-webapp/lib/observability/growth.ts` via `AuthStep`, `vault-context`, `kai/onboarding`, `use-portfolio-sources`, `ria-service`, `ria/onboarding`, `use-ria-client-workspace-state` | GA DebugView, BigQuery funnels, dashboard | `npm run verify:analytics`, DebugView, BigQuery funnel query |
| `investor_activation_completed` | Canonical investor conversion event | `journey`, `app_version`, `event_category` | `hushh-webapp/lib/observability/growth.ts` via `hushh-webapp/app/kai/analysis/page.tsx` | GA key event, BigQuery production dashboard | `npm run verify:analytics`, GA key-event checks, BigQuery query |
| `ria_activation_completed` | Canonical RIA conversion event | `journey`, `app_version`, `event_category` | `hushh-webapp/lib/observability/growth.ts` via `hushh-webapp/components/ria/use-ria-client-workspace-state.ts`, `hushh-webapp/app/ria/onboarding/page.tsx` | GA key event, BigQuery production dashboard | `npm run verify:analytics`, GA key-event checks, BigQuery query |

Standard investor `step` values:

- `entered`
- `auth_completed`
- `vault_ready`
- `onboarding_completed`
- `portfolio_ready`

`investor_activation_completed` is the terminal conversion and is not emitted as `step = activated`.

Standard RIA `step` values:

- `entered`
- `auth_completed`
- `profile_submitted`
- `request_created`
- `workspace_ready`

Authenticated RIA persona entry uses `auth_method = existing_session` for growth funnel continuity and must not be counted as a fresh `auth_succeeded`.

Growth-parameter policy:

- optional params:
  - `entry_surface`
  - `auth_method`
  - `portfolio_source`
  - `workspace_source`
- shared context params added centrally:
  - `env`
  - `platform`
  - `event_category`
- allowed values are governed in:
  - `hushh-webapp/lib/observability/events.ts`
  - `hushh-webapp/lib/observability/schema.ts`

## API and Runtime Health

| Event | Business purpose | Required params | Primary emitter | Destination use | Proof path |
| --- | --- | --- | --- | --- | --- |
| `api_request_completed` | Central API health signal with normalized route and status buckets | `endpoint_template`, `http_method`, `result`, `status_bucket`, `duration_ms_bucket` | `hushh-webapp/lib/observability/client.ts`, called from `hushh-webapp/lib/services/api-service.ts` | request health, expected/unexpected failure classification, dashboard health rollups | `npm run verify:analytics`, GA DebugView, BigQuery instrumentation-health query |

## Cache Performance and UX Readiness

These events are metadata-only. They must never include raw user IDs, emails, PKM payloads, workflow IDs, cache keys, prompts, portfolio values, or decrypted data.

| Event | Business purpose | Required params | Primary emitter | Destination use | Proof path |
| --- | --- | --- | --- | --- | --- |
| `route_readiness_completed` | Measures whether a route reached usable UI through the best safe cache path or a blocking loader | `route_id`, `result`, `render_path`, `cache_tier`, `resource_class`, `duration_ms_bucket`, `blocking_loader_shown`, `stale_rendered` | Route resource hooks and cache-aware screen shells via `hushh-webapp/lib/observability/client.ts` | warm-cache UX, loader exposure, route readiness KPI | `npm run verify:analytics`, `npm run audit:cache-coherence` |
| `cache_resource_resolved` | Measures cache hit, stale-hit, miss, locked, or unsafe resolution without exposing cache keys | `resource_class`, `cache_tier`, `freshness`, `result`, `duration_ms_bucket` | Resource services and shared cache wrappers via `hushh-webapp/lib/observability/client.ts` | cache tier health, stale rate, miss rate, footprint trend | `npm run verify:analytics` |
| `route_refresh_completed` | Measures background refresh outcome after stale render, focus, manual refresh, mutation, or warmup | `route_id`, `resource_class`, `refresh_trigger`, `result`, `duration_ms_bucket` | Route resource hooks and domain services via `hushh-webapp/lib/observability/client.ts` | refresh reliability, retry pressure, loader avoidance | `npm run verify:analytics`, `npm run audit:cache-coherence` |
| `warmup_completed` | Measures route/resource warmup completion by safe cache tier | `resource_class`, `cache_tier`, `warm_priority`, `result`, `duration_ms_bucket` | Unlock warmup and route-adjacent warmers via `hushh-webapp/lib/observability/client.ts` | warmup usefulness, cold unlock friction, over-warm detection | `npm run verify:analytics` |

## Agent PKM Reliability

These events contain bounded aggregate buckets only. They must never include decrypted PKM facts, domains, scopes, prompts, identifiers, recipient labels, or error messages.

| Event | Business purpose | Required params | Primary emitter | Destination use | Proof path |
| --- | --- | --- | --- | --- | --- |
| `agent_pkm_context_resolved` | Proves that an Agent turn received selected local PKM context and reports whether selection clipped or omitted unsafe nodes | `context_mode`, fact-count buckets, `context_clipped`, `inventory_only`, `safety_omitted`, `duration_ms_bucket` | `hushh-webapp/components/agent/agent-chat-workspace.tsx` | cold-unlock readiness, retrieval coverage, clipping trend | `npm run verify:analytics` |
| `agent_pkm_context_unavailable` | Counts turns deliberately stopped before the model receives empty PKM context | `result`, bounded `reason` | `hushh-webapp/components/agent/agent-chat-workspace.tsx` | context-free personal-turn prevention | `npm run verify:analytics` |
| `agent_pkm_save_confirmation_completed` | Measures user-confirmed PKM save completion without identifying what was saved or shared | `result`, saved/failed count buckets, `has_active_recipients` | `hushh-webapp/components/agent/agent-chat-workspace.tsx` | save-confirmation completion and sharing-impact reliability | `npm run verify:analytics` |

## Declared but Not Currently Emitted

These events are declared in the schema, but there is no current live emitter in the web app codebase.

| Event | Current status | Next action before dashboard use |
| --- | --- | --- |
| `ria_request_blocked_policy` | declared only | add emitter or remove from contract. No policy-block path exists on the RIA request flow today, so emitting it would mean inventing the concept first. |
| `mcp_ria_read_tool_called` | declared only | add emitter or remove from contract. This is a server-side MCP concern; the web client cannot emit it, and no emitter exists in `consent-protocol` either. |

Do not build dashboard assumptions on declared-only events.
