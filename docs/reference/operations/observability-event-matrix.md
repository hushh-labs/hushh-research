# Observability Event Matrix

## Visual Context

Canonical visual owner: [Observability Architecture Map](./observability-architecture-map.md). Use that map for topology and reporting boundaries; this page is the event taxonomy and emitter map beneath it.

This matrix documents the maintained Kai observability contract:

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
| `consent_pending_loaded` | Pending consent load outcome | `result` | `hushh-webapp/lib/services/api-service.ts` | consent inbox health | GA DebugView |
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
| `ria_verification_status_changed` | RIA verification status transition | `action`, `result` | `hushh-webapp/app/ria/onboarding/page.tsx` | RIA status progression | GA DebugView |
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

## Declared but Not Currently Emitted

These events are declared in the schema, but there is no current live emitter in the web app codebase.

| Event | Current status | Next action before dashboard use |
| --- | --- | --- |
| `ria_request_blocked_policy` | declared only | add emitter or remove from contract |
| `mcp_ria_read_tool_called` | declared only | add emitter or remove from contract |

Do not build dashboard assumptions on declared-only events.
