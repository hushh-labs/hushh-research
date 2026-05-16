# Kai Observability Event Taxonomy and Validation Ladder

## Canonical business events

These are the dashboard-defining events:

1. `growth_funnel_step_completed`
2. `investor_activation_completed`
3. `ria_activation_completed`

They are the only events that should drive top-level funnel and conversion KPIs.

## Supporting observability events

Supporting event families:

1. navigation:
   - `page_view`
2. auth:
   - `auth_started`
   - `auth_succeeded`
   - `auth_failed`
3. onboarding and import:
   - `onboarding_*`
   - `import_*`
4. analysis:
   - `market_insights_loaded`
   - `portfolio_viewed`
   - `recommendation_viewed`
   - `profile_picks_loaded`
   - `analysis_stream_*`
5. consent and account:
   - `consent_*`
   - `account_delete_*`
   - `profile_method_switch_result`
   - `phone_verification_*`
6. RIA:
   - `persona_switched`
   - `ria_onboarding_submitted`
   - `ria_verification_status_changed`
   - `marketplace_profile_viewed`
   - `ria_request_created`
   - `ria_workspace_opened`
7. Gmail:
   - `gmail_*`
8. operational:
   - `api_request_completed`

Declared-only events that should not back dashboards until they have emitters:

1. `ria_request_blocked_policy`
2. `mcp_ria_read_tool_called`

## Parameter policy

Allowed growth parameters:

- `journey`
- `step`
- `entry_surface`
- `auth_method`
- `portfolio_source`
- `workspace_source`
- `env`
- `platform`
- `event_category`
- `app_version`

Category policy:

- `funnel` for `growth_funnel_step_completed`, `investor_activation_completed`, and `ria_activation_completed`
- `feature` for high-intent product events such as `market_insights_loaded`, `portfolio_viewed`, and `recommendation_viewed`
- `system` for request, account, consent, auth, Gmail, and runtime health events

Investor funnel steps:

- `entered`
- `auth_completed`
- `vault_ready`
- `onboarding_completed`
- `portfolio_ready`

`investor_activation_completed` is the terminal conversion event. Do not model activation as `step = activated`.

RIA funnel steps:

- `entered`
- `auth_completed`
- `profile_submitted`
- `request_created`
- `workspace_ready`

Authenticated RIA persona entry uses `auth_method = existing_session` for growth continuity and must not emit a fresh `auth_succeeded`.

Do not add:

- raw user IDs
- emails
- tokens
- prices or amounts
- free-form text
- high-entropy opaque values

## Validation ladder

1. Repo:
   - `cd hushh-webapp && npm run verify:analytics`
   - route-ID coverage must fail when any first-party app route maps to `unknown`
   - `cd hushh-webapp && npm run audit:analytics-sandbox`
   - `cd hushh-webapp && npm run smoke:analytics:uat`
   - UAT smoke must reuse the existing reviewer test fixture via `REVIEWER_UID` and `REVIEWER_VAULT_PASSPHRASE`; missing fixture data should be repaired on that user, not solved by creating another account
   - protected-route smoke transitions after login must use Next client navigation, not raw `page.goto(...)`
2. Web runtime:
   - GA DebugView
   - measurement-ID presence
3. Native runtime:
   - Firebase / GA DebugView on iOS and Android
   - UAT native validation requires TestFlight/internal-track or dev-device debug builds; current store builds are production-facing
4. Export:
   - BigQuery link exists
   - GA-managed dataset materializes
   - event tables appear
5. Reporting:
   - modeled SQL reconstructs investor and RIA funnels
   - production dashboards read only from production export

## Failure patterns to watch

1. `(direct) / (not set)` dominating tagged traffic
2. platform mix collapsing to one platform
3. activation key events flatlined at zero
4. missing `journey`, `step`, `env`, `event_category`, or `app_version`
5. UAT traffic appearing in prod DebugView or prod export
6. `HushhVoice` appearing in Kai growth models
