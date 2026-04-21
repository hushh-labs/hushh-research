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
   - `profile_picks_loaded`
   - `analysis_stream_*`
5. consent and account:
   - `consent_*`
   - `account_delete_*`
   - `profile_method_switch_result`
6. RIA:
   - `ria_onboarding_submitted`
   - `ria_verification_status_changed`
   - `ria_request_created`
   - `ria_workspace_opened`
7. Gmail:
   - `gmail_*`
8. operational:
   - `api_request_completed`

Declared-only events that should not back dashboards until they have emitters:

1. `persona_switched`
2. `marketplace_profile_viewed`
3. `ria_request_blocked_policy`
4. `mcp_ria_read_tool_called`

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
- `app_version`

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
2. Web runtime:
   - GA DebugView
   - measurement-ID presence
3. Native runtime:
   - Firebase / GA DebugView on iOS and Android
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
4. missing `journey`, `step`, `env`, or `app_version`
5. UAT traffic appearing in prod DebugView or prod export
6. `HushhVoice` appearing in Kai growth models
