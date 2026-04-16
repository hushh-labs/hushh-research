# Google-First Observability (Implemented Baseline)


## Visual Context

Canonical visual owner: [Operations Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

This document captures the repo implementation for the GA4 + GTM + Firebase observability model with strict metadata-only payload policy.

## Scope

- Product analytics: GTM dataLayer (web), Firebase Analytics plugin (native).
- Growth analytics: two explicit funnels, `investor` and `ria`, with BigQuery-backed reporting as the dashboard source of truth.
- Operational observability: request correlation via `x-request-id`, structured backend request summaries, expected-status classification.
- Data observability: scheduled Supabase health checks.
- Environment split: exactly two analytics environments (`uat`, `production`), currently backed by the `analytics_staging` and `analytics_prod` BigQuery datasets.

## Implemented in Code

### Frontend (`hushh-webapp`)

- Shared observability module:
  - `lib/observability/events.ts`
  - `lib/observability/schema.ts`
  - `lib/observability/client.ts`
  - `lib/observability/growth.ts`
  - `lib/observability/route-map.ts`
  - `lib/observability/adapters/web-gtm.ts`
  - `lib/observability/adapters/native-firebase.ts`
  - `lib/observability/request-id.ts`
- Native Firebase analytics adapter is now implemented; web remains GTM/dataLayer and native now logs the same contract through `@capacitor-firebase/analytics`.
- GTM bootstrap wired at root layout (`app/layout.tsx`) with staging/prod container selection.
- Route-level page tracking wired globally (`components/observability/route-observer.tsx`, mounted in `app/providers.tsx`).
- Growth funnel contract added:
  - `growth_funnel_step_completed`
  - `investor_activation_completed`
  - `ria_activation_completed`
- API instrumentation in central transport (`lib/services/api-service.ts`):
  - emits `api_request_completed`
  - classifies expected status buckets
  - adds and propagates `x-request-id`
- Key funnel events added for:
  - auth (`AuthStep`)
  - vault unlock (`lib/vault/vault-context.tsx`)
  - onboarding lifecycle (`app/kai/onboarding/page.tsx`)
  - portfolio-ready detection (`lib/kai/brokerage/use-portfolio-sources.ts`)
  - analysis completion (`app/kai/analysis/page.tsx`, `components/kai/debate-stream-view.tsx`)
  - RIA onboarding/request/workspace lifecycle (`app/ria/onboarding/page.tsx`, `lib/services/ria-service.ts`, `components/ria/use-ria-client-workspace-state.ts`)
  - consent actions + pending load (`ApiService`)
  - account delete lifecycle (`lib/services/account-service.ts`)
  - vault method switch outcome (`lib/services/vault-method-service.ts`)
- Firebase config supports env-split measurement IDs (`lib/firebase/config.ts`).

### Next.js Proxy Correlation

- Request-ID utility for API routes:
  - `app/api/_utils/request-id.ts`
- Request-ID propagation and response header on high-volume routes:
  - `app/api/kai/[...path]/route.ts`
  - `app/api/pkm/[...path]/route.ts`
  - `app/api/vault/check/route.ts`
  - `app/api/vault/get/route.ts`
  - `app/api/vault/bootstrap-state/route.ts`
  - `app/api/consent/pending/route.ts`

### Backend (`consent-protocol`)

- New middleware:
  - `api/middlewares/observability.py`
- Server wiring:
  - middleware attached in `server.py`
  - OpenTelemetry bootstrap hook (`configure_opentelemetry`) added in `server.py`
- Structured request summary logs include:
  - `request_id`, `method`, `route_template`, `status_code`, `status_bucket`, `duration_ms`, `outcome_class`, `service`, `env`, `stream`
- `x-request-id` added on responses by middleware.
- Stream lifecycle logging added for long-running SSE:
  - `api/routes/kai/stream.py`
  - `api/routes/kai/portfolio.py`

### Data Observability

- Scheduled check script:
  - `consent-protocol/scripts/observability/supabase_data_health.py`
- Checks include:
  - key table counts
  - vault method coverage
  - PKM coherence (`blobs` vs `index`)
  - market cache freshness drift
  - consent audit 24h activity
- Emits one structured JSON summary log line with aggregate-only metrics.

## Growth Funnel Contract

### Investor

- `entered`
- `auth_completed`
- `vault_ready`
- `onboarding_completed`
- `portfolio_ready`
- `activated`

Terminal event:

- `investor_activation_completed`

### RIA

- `entered`
- `auth_completed`
- `profile_submitted`
- `request_created`
- `workspace_ready`
- `activated`

Terminal event:

- `ria_activation_completed`

### Allowed Growth Params

- `journey`
- `step`
- `entry_surface`
- `auth_method`
- `portfolio_source`
- `workspace_source`
- `env`
- `platform`
- `app_version`

The validator still enforces metadata-only payloads. No raw user identifiers, emails, messages, or free-form business content belong in analytics events.

## Environment Model (Two Envs)

- `NEXT_PUBLIC_APP_ENV=uat|production` (canonical)
- `NEXT_PUBLIC_OBSERVABILITY_ENV=uat|production` (legacy fallback, temporary)
- GTM IDs:
  - `NEXT_PUBLIC_GTM_ID_UAT`
  - `NEXT_PUBLIC_GTM_ID_STAGING` (legacy alias, still accepted)
  - `NEXT_PUBLIC_GTM_ID_PRODUCTION`
- Firebase measurement IDs:
  - `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID_UAT`
  - `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID_STAGING`
  - `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID_PRODUCTION`
- Client build version:
  - `NEXT_PUBLIC_CLIENT_VERSION`

## Privacy Guardrails

- Central payload validator blocks non-allowlisted keys and sensitive patterns.
- Denylist blocks raw IDs, emails, tokens, symbols, amounts, and free-form text keys.
- Payload policy is metadata-only (route IDs, status buckets, duration buckets, enums).

## CLI-First Verification

### Environment inventory

```bash
gcloud auth list
gcloud config set project hushh-pda-uat
firebase apps:list --project hushh-pda-uat
firebase apps:list --project hushh-pda
bq ls --project_id hushh-pda-uat
bq ls --project_id hushh-pda
```

### Repo verification

```bash
cd hushh-webapp
npm run verify:analytics
./bin/hushh docs verify
```

### GA Admin API inspection

```bash
ACCESS_TOKEN="$(gcloud auth print-access-token)"
curl -H "Authorization: Bearer $ACCESS_TOKEN" \
  "https://analyticsadmin.googleapis.com/v1alpha/accounts"
```

If this returns `ACCESS_TOKEN_SCOPE_INSUFFICIENT`, the current local auth token does not have Analytics Admin scopes. Re-authenticate with the required scopes or complete the remaining property-level tasks in the GA UI.

### BigQuery growth reporting

Query templates for dashboard modeling live at:

- `consent-protocol/scripts/observability/ga4_growth_dashboard_queries.sql`

Run them with:

```bash
bq query --use_legacy_sql=false < consent-protocol/scripts/observability/ga4_growth_dashboard_queries.sql
```

Replace the `{{PROJECT_ID}}` / `{{DATASET}}` placeholders first.

## Remaining Console / Admin Tasks (GCP/Firebase/GA)

The repo now supports the architecture, but these steps are still required in GCP/Firebase/GA consoles:

1. Verify the GA4 property-side access model for the growth team. Firebase IAM alone is not enough for the Looker Studio GA connector.
2. Mark `investor_activation_completed` and `ria_activation_completed` as GA4 key events in UAT and production.
3. Register only the required custom dimensions on the GA4 property (`journey`, `step`, `entry_surface`, `portfolio_source`, `workspace_source`, `app_version`).
4. Re-download mobile Firebase artifacts with analytics enabled and replace CI secrets/artifacts if native analytics still fails after `./bin/hushh bootstrap`.
5. Confirm BigQuery export into `analytics_staging` and `analytics_prod`.
6. Create Cloud Monitoring dashboards + alert policies (log/metric-based) against new structured signals.
7. Schedule the Supabase health script as a Cloud Run Job + Cloud Scheduler trigger.

## Automation Commands

### GCP observability provisioning (idempotent)

```bash
bash deploy/observability/setup_gcp_observability.sh
```

Optional email channel wiring:

```bash
OBS_ALERT_EMAIL=you@example.com bash deploy/observability/setup_gcp_observability.sh
```

What this script automates:
- required APIs
- BigQuery datasets `analytics_staging`, `analytics_prod`
- log-based metrics (`obs_request_summary_count`, `obs_unexpected_error_count`, `obs_data_health_anomaly_count`)
- Cloud Monitoring dashboard + alert policies
- Cloud Run Job for Supabase data health + Cloud Scheduler trigger

### Native Firebase artifact refresh

```bash
./bin/hushh bootstrap
```

If native analytics checks still fail after bootstrap refresh, Firebase app configs are not yet analytics-enabled and must be fixed in Firebase/GA linkage before native production builds.

## Verification Expectations

- Frontend web: GTM preview shows `observability_v2` events and ordered funnel emission.
- Frontend native: Firebase DebugView shows the same growth contract through the Capacitor analytics plugin.
- Dashboard: BigQuery queries return nonzero activation events and monotonic funnel progression.
- Backend: `x-request-id` appears on responses and `request.summary` logs remain structured in Cloud Logging.
- Data health: the Supabase health script still emits aggregate-only JSON summaries.
