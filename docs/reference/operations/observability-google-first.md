# Google-First Observability (Implemented Baseline)


## Visual Context

Canonical visual owner: [Operations Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

This document captures the repo implementation for the GA4 + GTM + Firebase + Deep SRE observability roadmap with strict metadata-only payload policy.

## Scope

- Product analytics: GTM dataLayer (web), Firebase Analytics plugin (native).
- Operational observability: request correlation via `x-request-id`, structured backend request summaries, expected-status classification.
- Data observability: scheduled Supabase health checks.
- Environment split: exactly two analytics environments (`staging`, `production`).

## Implemented in Code

### Frontend (`hushh-webapp`)

- Shared observability module:
  - `lib/observability/events.ts`
  - `lib/observability/schema.ts`
  - `lib/observability/client.ts`
  - `lib/observability/route-map.ts`
  - `lib/observability/adapters/web-gtm.ts`
  - `lib/observability/adapters/native-firebase.ts`
  - `lib/observability/request-id.ts`
- GTM bootstrap wired at root layout (`app/layout.tsx`) with staging/prod container selection.
- Route-level page tracking wired globally (`components/observability/route-observer.tsx`, mounted in `app/providers.tsx`).
- API instrumentation in central transport (`lib/services/api-service.ts`):
  - emits `api_request_completed`
  - classifies expected status buckets
  - adds and propagates `x-request-id`
- Key funnel events added for:
  - auth (`AuthStep`)
  - onboarding lifecycle (`app/kai/onboarding/page.tsx`)
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

## Environment Model (Two Envs)

- `NEXT_PUBLIC_APP_ENV=uat|production` (canonical)
- `NEXT_PUBLIC_OBSERVABILITY_ENV=uat|production` (legacy fallback, temporary)
- GTM IDs:
  - `NEXT_PUBLIC_GTM_ID_STAGING`
  - `NEXT_PUBLIC_GTM_ID_PRODUCTION`
- Firebase measurement IDs:
  - `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID_STAGING`
  - `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID_PRODUCTION`

## Privacy Guardrails

- Central payload validator blocks non-allowlisted keys and sensitive patterns.
- Denylist blocks raw IDs, emails, tokens, symbols, amounts, and free-form text keys.
- Payload policy is metadata-only (route IDs, status buckets, duration buckets, enums).

## Remaining Console Tasks (GCP/Firebase/GA)

The repo now supports the architecture, but these steps are still required in GCP/Firebase/GA consoles:

1. Create/verify GA4 + GTM + Firebase stream split for `staging` and `production`.
2. Re-download mobile Firebase artifacts with analytics enabled and replace CI secrets/artifacts.
3. Enable GA4 BigQuery export into `analytics_staging` and `analytics_prod` datasets.
4. Create Cloud Monitoring dashboards + alert policies (log/metric-based) against new structured signals.
5. Schedule the Supabase health script as a Cloud Run Job + Cloud Scheduler trigger.

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

## Verification

- Frontend: use GTM preview + GA4 DebugView + Firebase DebugView.
- Backend: confirm `x-request-id` on responses and structured `request.summary` logs in Cloud Logging.
- Data health: run script manually and verify JSON output/anomaly behavior.
