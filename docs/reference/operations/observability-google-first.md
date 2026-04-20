# Google-First Observability (Governed Baseline)

## Visual Context

Canonical visual owner: [Observability Architecture Map](./observability-architecture-map.md). Use that map for the top-down system view; this page is the narrower implementation and operator contract beneath it.

This document captures the implemented Kai observability model across GA4, Firebase Analytics, direct web tagging, BigQuery export, and dashboard verification.

## Policy Defaults

These are the non-negotiable reporting rules for the current system:

1. Production is the only canonical business-reporting surface.
2. UAT is export-enabled for instrumentation validation only, not for core growth KPI reporting.
3. UAT and production share one Firebase identity plane, but pre-production analytics must not pollute production analytics.
4. The analytics sink is selected by the active web measurement ID or the native Firebase app stream, not by the auth token issuer.
5. BigQuery is the reporting source of truth; GA UI is for configuration, DebugView, and spot checks.
6. `HushhVoice` remains on the production property for now, but is explicitly excluded from Kai growth models and from the production BigQuery export link.

## Scope

- Product analytics:
  - web uses direct GA tagging through `gtag`
  - GTM-compatible `dataLayer` pushes remain available, but GTM is optional
  - native uses Firebase Analytics through the Capacitor plugin
- Growth analytics:
  - explicit `investor` and `ria` funnels
  - BigQuery-backed modeled reporting
- Operational observability:
  - frontend request instrumentation through `api_request_completed`
  - backend request correlation with `x-request-id`
  - structured backend request summaries
- Data observability:
  - Supabase health checks and structured aggregate-only summaries

## Environment and Property Topology

### Production

- GA4 property: `526603671`
- property label: `hushh-pda`
- BigQuery export link present: yes
- BigQuery link project: `hushh-pda`
- BigQuery link export mode:
  - daily export: enabled
  - streaming export: enabled

Primary Kai streams:

| Surface | Stream ID | Identifier |
| --- | --- | --- |
| Android | `13694989021` | Firebase app `1:1006304528804:android:e38e29d91ba817aecfd931` |
| iOS | `13695001361` | Firebase app `1:1006304528804:ios:eb2720b5eda7da4bcfd931` |
| Web | `13695004816` | Measurement ID `G-2PCECPSKCR` |

Extra stream present on property:

| Surface | Stream ID | Identifier | Reporting policy |
| --- | --- | --- | --- |
| HushhVoice iOS | `13702689760` | Firebase app `1:1006304528804:ios:fc1e5fd477d3f757cfd931` | Exclude from Kai growth models and from the current BigQuery export link |

### UAT

- GA4 property: `533362555`
- property label: `hushh-pda-uat`
- BigQuery export link present: yes
- BigQuery link project: `hushh-pda-uat`
- BigQuery link export mode:
  - daily export: enabled
  - streaming export: enabled

Primary Kai streams:

| Surface | Stream ID | Identifier |
| --- | --- | --- |
| iOS | `14383415557` | Firebase app `1:745506018753:ios:efea0fede200b1d1778b40` |
| Web | `14383500973` | Measurement ID `G-H1KGXGZTCF` |
| Android | `14383555179` | Firebase app `1:745506018753:android:7d6bed4640373c95778b40` |

### BigQuery target datasets

When GA4 export materializes normally, the dataset name must be:

- production: `analytics_526603671`
- uat: `analytics_533362555`

Current operator note:

- the GA Admin API confirms both BigQuery links exist
- project-side `bq ls` still needs to show the GA-managed export datasets and event tables before dashboards should be cut over
- do not point dashboards at legacy aliases like `analytics_prod` or `analytics_staging`

## Identity vs Analytics Sink

The runtime now uses one Firebase web/app configuration per environment surface. That still does not change the analytics sink.

Sink selection rules:

1. Web analytics sink is selected by the active measurement ID resolved in:
   - `hushh-webapp/lib/firebase/config.ts`
   - `hushh-webapp/lib/observability/env.ts`
2. Native analytics sink is selected by the Firebase app that is compiled into the iOS/Android build and linked to the GA4 property stream.
3. Backend auth verification uses that same Firebase project without affecting the GA4 property that receives product events.

Required proof of separation:

1. UAT web HTML must resolve `G-H1KGXGZTCF`.
2. UAT native builds must resolve the UAT Firebase app IDs above, not the production app IDs.
3. UAT validation traffic must appear in UAT DebugView and stay absent from production DebugView for the same test session.
4. Production dashboard SQL must read only from `analytics_526603671`.

See also:

- [env-and-secrets.md](./env-and-secrets.md)
- [analytics-verification-contract.md](../quality/analytics-verification-contract.md)

## Event Contract

### Canonical business events

- `growth_funnel_step_completed`
- `investor_activation_completed`
- `ria_activation_completed`

### Allowed growth params

- `journey`
- `step`
- `entry_surface`
- `auth_method`
- `portfolio_source`
- `workspace_source`
- `env`
- `platform`
- `app_version`

### Key events configured in GA4

Configured on both production and UAT:

- `investor_activation_completed`
- `ria_activation_completed`

### Event-scoped custom dimensions configured in GA4

Configured on both production and UAT:

- `journey`
- `step`
- `entry_surface`
- `auth_method`
- `portfolio_source`
- `workspace_source`
- `env`
- `platform`
- `app_version`

Custom-dimension policy:

1. Keep dimensions event-scoped unless there is a defensible reason to expand scope.
2. Do not create a custom dimension when a predefined GA dimension already exists.
3. Keep the set minimal; this is a governed reporting surface, not a dumping ground for raw metadata.

## Implemented in Code

### Frontend (`hushh-webapp`)

Shared observability surfaces:

- `lib/observability/events.ts`
- `lib/observability/schema.ts`
- `lib/observability/client.ts`
- `lib/observability/growth.ts`
- `lib/observability/route-map.ts`
- `lib/observability/adapters/web-gtm.ts`
- `lib/observability/adapters/native-firebase.ts`
- `lib/observability/request-id.ts`

Web transport:

- root layout injects `gtag` whenever a valid measurement ID exists:
  - `hushh-webapp/app/layout.tsx`
- placeholder GTM IDs and placeholder measurement IDs are rejected:
  - `hushh-webapp/lib/observability/env.ts`
- web uses direct GA tagging as the primary path and keeps `dataLayer` pushes for optional GTM compatibility:
  - `hushh-webapp/lib/observability/adapters/web-gtm.ts`

Growth emitters:

- auth:
  - `hushh-webapp/components/onboarding/AuthStep.tsx`
- vault unlock:
  - `hushh-webapp/lib/vault/vault-context.tsx`
- Kai onboarding:
  - `hushh-webapp/app/kai/onboarding/page.tsx`
- portfolio-ready:
  - `hushh-webapp/lib/kai/brokerage/use-portfolio-sources.ts`
- analysis activation:
  - `hushh-webapp/app/kai/analysis/page.tsx`
  - `hushh-webapp/components/kai/debate-stream-view.tsx`
- RIA onboarding/request/workspace activation:
  - `hushh-webapp/app/ria/onboarding/page.tsx`
  - `hushh-webapp/lib/services/ria-service.ts`
  - `hushh-webapp/components/ria/use-ria-client-workspace-state.ts`

Operational emitters:

- page views:
  - `hushh-webapp/components/observability/route-observer.tsx`
  - `hushh-webapp/lib/observability/client.ts`
- API request summaries:
  - `hushh-webapp/lib/observability/client.ts`
  - `hushh-webapp/lib/services/api-service.ts`
- Gmail/account/profile operations:
  - `hushh-webapp/lib/services/gmail-receipts-service.ts`
  - `hushh-webapp/lib/services/account-service.ts`
  - `hushh-webapp/lib/services/vault-method-service.ts`

### Backend (`consent-protocol`)

- request middleware:
  - `consent-protocol/api/middlewares/observability.py`
- server wiring:
  - `consent-protocol/server.py`
- SSE lifecycle logging:
  - `consent-protocol/api/routes/kai/stream.py`
  - `consent-protocol/api/routes/kai/portfolio.py`
- data health checks:
  - `consent-protocol/scripts/observability/supabase_data_health.py`

## Reporting Policy

### Production dashboard

Production dashboards must:

1. read only from `analytics_526603671`
2. exclude `HushhVoice` stream `13702689760`
3. use modeled SQL, not raw GA cards, for conversion and funnel KPIs

### UAT validation

UAT queries may use `analytics_533362555`, but only for:

1. instrumentation validation
2. DebugView parity checks
3. export-materialization checks
4. pre-production funnel sanity checks

UAT data must not be treated as canonical business reporting.

## Verification Contract

The maintained proof ladder lives in:

- [analytics-verification-contract.md](../quality/analytics-verification-contract.md)

Minimum repo verification:

```bash
cd hushh-webapp
npm run verify:analytics
npm run audit:analytics-sandbox
./bin/hushh docs verify
```

Sandbox audit policy:

1. `npm run audit:analytics-sandbox` is the non-reporting validation path for web transport.
2. It validates representative investor and RIA journeys locally, captures client-side dispatch latency for `dataLayer` and direct `gtag`, and writes report artifacts into `tmp/`.
3. It must be used before declaring local or pre-release analytics wiring healthy when the current build has not yet been deployed.
4. It does not replace DebugView or BigQuery checks after deployment; it only proves the pre-release transport contract without polluting GA4 numbers.

Maintained query surface:

- [ga4_growth_dashboard_queries.sql](../../../consent-protocol/scripts/observability/ga4_growth_dashboard_queries.sql)

The query layer must cover:

1. investor funnel
2. RIA funnel
3. attribution quality
4. platform mix
5. missing-step drift
6. instrumentation health rollup

## Operator-Owned Manual Surfaces

These remain manual or semi-manual even when repo-side instrumentation is correct:

1. GA4 property access management for the growth team
2. DebugView enablement on specific devices and browsers
3. BigQuery export-link creation and re-verification
4. Firebase artifact refresh if native analytics stops mapping to the expected property streams
5. final Looker Studio connection to modeled BigQuery results

## External Best-Practice Basis

These standards are aligned to official Google and Firebase guidance:

- Firebase multi-environment guidance:
  - https://firebase.google.com/docs/projects/dev-workflows/overview-environments
  - https://firebase.google.com/docs/projects/dev-workflows/general-best-practices
  - https://firebase.google.com/docs/projects/multiprojects
- GA4 BigQuery export schema and dataset naming:
  - https://support.google.com/analytics/answer/7029846
- GA4 BigQuery export setup:
  - https://support.google.com/analytics/answer/9823238
- DebugView for instrumentation validation:
  - https://firebase.google.com/docs/analytics/debugview
  - https://firebase.google.com/docs/analytics/get-started
- Event-scoped custom dimensions:
  - https://support.google.com/analytics/answer/14239696
- Event naming and reserved parameter rules:
  - https://support.google.com/analytics/answer/13316687
