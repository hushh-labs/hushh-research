# Environment Variables and Secrets Reference

> Single source of truth for env vars and **strict parity** with code and GCP Secret Manager.  
> **Rule:** What is in `.env` / Secret Manager must match exactly what the code reads — no extra keys, no missing keys.


## Visual Context

Canonical visual owner: [Operations Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

See also: [deploy/README.md](../../../deploy/README.md), [consent-protocol/.env.example](../../../consent-protocol/.env.example), [hushh-webapp/.env.example](../../../hushh-webapp/.env.example), [deploy/.env.backend.example](../../../deploy/.env.backend.example), [deploy/.env.frontend.example](../../../deploy/.env.frontend.example). For FCM push notifications, see [fcm-notifications.md](../../../consent-protocol/docs/reference/fcm-notifications.md).

---

## Parity rule: code ↔ .env ↔ Secret Manager

- **Local:** `.env` (backend) and `.env.local` (frontend) must contain exactly the keys the application code reads. Use the repo `.env.example` files as the template; they are audited to match the code.
- **Production:** GCP Secret Manager must hold **exactly** the secrets the code expects — no more, no less. The Cloud Build config (`deploy/*.cloudbuild.yaml`) injects only these; do not add secrets that are not read by the code, and do not remove any that are.
- **Canonical runtime modes:** the supported frontend `local`, `uat`, and `prod` files must share one frontend key shape. The backend contributor runtime stays local-only in `consent-protocol/.env`.

## Canonical 3-environment contract

1. Backend environment identity is `ENVIRONMENT` and must be one of: `development`, `uat`, `production`.
2. Frontend environment identity is `NEXT_PUBLIC_APP_ENV` and must be one of: `development`, `uat`, `production`.
3. Legacy frontend fallback keys are read-only compatibility paths for one release cycle:
- `NEXT_PUBLIC_OBSERVABILITY_ENV`
- `NEXT_PUBLIC_ENVIRONMENT_MODE`
4. Local runtime-mode model (non-committed):
- backend template/source: `consent-protocol/.env.example` -> `consent-protocol/.env`
- frontend templates: `hushh-webapp/.env.local.local.example`, `hushh-webapp/.env.uat.local.example`, `hushh-webapp/.env.prod.local.example`
- local source files are created from templates and kept uncommitted
- active files: `consent-protocol/.env`, `hushh-webapp/.env.local`
- `NEXT_PUBLIC_PKM_UPGRADE_REHEARSAL` is local/UAT-only and should remain `false` unless you are intentionally running the Kai test-user no-write PKM rehearsal
5. Runtime profile bootstrap command:

```bash
npm run bootstrap
```

This is the supported contributor entrypoint. It installs dependencies, hydrates local runtime-profile files from templates plus current cloud secrets/runtime metadata when available, and runs the profile doctor.
It does not print secret values and sets profile files to `chmod 600`.

6. Activate the chosen runtime profile:

```bash
npm run doctor -- --mode=local
npm run web -- --mode=uat
npm run web -- --mode=prod
npm run native:ios -- --mode=uat
npm run native:android -- --mode=uat
```

Low-level activation still exists when you need it:

```bash
bash scripts/env/use_profile.sh local
bash scripts/env/use_profile.sh uat
bash scripts/env/use_profile.sh prod
```

The local UAT-backed backend launcher now runs IAM schema verification before booting. If IAM is incomplete, it exits instead of silently falling back to investor-compatibility mode.

Profile-aware frontend-only launcher:

```bash
cd hushh-webapp
npm run dev -- --mode=local
```

### One-command parity audit

```bash
python3 scripts/ops/verify-env-secrets-parity.py \
  --project hushh-pda \
  --region us-central1 \
  --backend-service consent-protocol \
  --frontend-service hushh-webapp
```

Native release preflight (adds required native Firebase and signing keys):

```bash
python3 scripts/ops/verify-env-secrets-parity.py \
  --project hushh-pda-uat \
  --require-native-artifacts
```

The script reports:
- required backend/frontend key lists
- whether each required key exists in the target project
- missing keys (if any), with non-zero exit on failure

### Runtime profile shape audit

Use this when the local profile files feel inconsistent or a new env key was added in only one place:

```bash
python3 scripts/ops/verify-runtime-profile-env-shape.py --include-runtime
```

It checks that:
- tracked backend profile templates share one canonical backend key set
- tracked frontend profile templates share one canonical frontend key set
- the real local canonical profile files and active `.env` / `.env.local` match those same shapes

### Firebase identity plane rule

1. The application uses one Firebase identity plane across `development`, `uat`, and `production`.
2. Environment separation is primarily at the database / backend runtime layer, not by changing the login provider between UAT and production.
3. The repo may intentionally use a shared Firebase auth project for login + ID-token verification while still keeping environment-specific app/runtime config elsewhere.
4. `NEXT_PUBLIC_AUTH_FIREBASE_*` and `FIREBASE_AUTH_SERVICE_ACCOUNT_JSON` are the intentional shared-auth overrides when login remains pinned to the shared auth plane.
5. When the auth override keys are set, they must stay internally aligned with the Firebase project that actually issues the web login tokens, and backend verification must use that same auth project.
6. UAT and production share the live Plaid credential set; only local development should use sandbox Plaid secrets and `PLAID_ENV=sandbox`.
7. Web consent delivery uses different defaults by environment:
   - local development: `CONSENT_SSE_ENABLED=true`
   - UAT: `CONSENT_SSE_ENABLED=true`
   - production: `CONSENT_SSE_ENABLED=false` unless there is an explicit incident-response or rollout reason to enable it
8. `ADVISORY_VERIFICATION_BYPASS_ENABLED` and `BROKER_VERIFICATION_BYPASS_ENABLED` are the capability-specific non-production bypass switches. Both must remain `false` in production.
9. `RIA_DEV_BYPASS_ENABLED` remains only as a legacy compatibility alias for advisory bypass and should not be the primary switch in new configs.

### Environment divergence note (current)

1. UAT runtime currently carries analytics keys plus optional auth-override keys (`NEXT_PUBLIC_AUTH_FIREBASE_*`).
2. Production runtime does not yet require all analytics keys until the dedicated migration step is approved.
3. Auth override keys are not accidental drift. They represent the shared-auth login plane when UAT and production intentionally use the same Firebase login provider.

### Ops-only GitHub secrets (backup/recovery governance)

These are not Cloud Run runtime secrets.

- Required: `GCP_SA_KEY` (used by production deploy and backup posture workflows to call GCP APIs)

Used by:
- `.github/workflows/deploy-production.yml`
- `.github/workflows/prod-supabase-backup-posture.yml`

---

## Audit: env vars read by code

### Backend (consent-protocol)

| Variable | Where read | Required | Notes |
|----------|------------|----------|--------|
| `SECRET_KEY` | `hushh_mcp/config.py` | Yes | Min 32 chars (64-char hex recommended) |
| `VAULT_ENCRYPTION_KEY` | `hushh_mcp/config.py` | Yes | Exactly 64-char hex |
| `DB_USER` | `db/connection.py`, `db/db_client.py` | Yes | |
| `DB_PASSWORD` | same | Yes | |
| `DB_HOST` | same | Yes | |
| `DB_PORT` | same | No (default 5432) | |
| `DB_NAME` | same | No (default postgres) | |
| `FRONTEND_URL` | `server.py` | Yes (prod CORS fallback) | |
| `CORS_ALLOWED_ORIGINS` | `server.py` | Yes (prod recommended) | Explicit comma-separated CORS allowlist |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | `api/utils/firebase_admin.py` | Yes (auth) | |
| `GOOGLE_API_KEY` | `hushh_mcp/config.py`, services | Yes (Gemini/Vertex) | |
| `DEFAULT_CONSENT_TOKEN_EXPIRY_MS` | `hushh_mcp/config.py` | No | |
| `DEFAULT_TRUST_LINK_EXPIRY_MS` | same | No | |
| `ENVIRONMENT` | `hushh_mcp/config.py`, `api/routes/debug_firebase.py` | No | |
| `OTEL_ENABLED` | `api/middlewares/observability.py` | No | Enables OpenTelemetry export to Cloud Trace when true |
| `AGENT_ID` | `hushh_mcp/config.py` | No | |
| `HUSHH_HACKATHON` | `hushh_mcp/config.py` | No | |
| `CONSENT_TIMEOUT_SECONDS` | `mcp_modules/config.py` | No | MCP server timeout (not required for FastAPI runtime) |
| `ROOT_PATH` | `server.py` | No | |
| `GOOGLE_GENAI_USE_VERTEXAI` | Cloud Run env (Gemini SDK) | No | Set in deploy, not in .env |
| `APP_REVIEW_MODE` / `HUSHH_APP_REVIEW_MODE` | `api/routes/health.py` (`/api/app-config/review-mode`) | No | Backend runtime toggle for app review login |
| `REVIEWER_UID` | `api/routes/health.py` (`POST /api/app-config/review-mode/session`) | Required when app review is enabled | Firebase UID used for custom token minting |
| `CONSENT_SSE_ENABLED` | `api/routes/sse.py` | No | Default off in production unless explicitly enabled |
| `SYNC_REMOTE_ENABLED` | deploy env (`deploy/backend.cloudbuild.yaml`) | No | Legacy deploy flag; currently not read by backend code |
| `DEVELOPER_API_ENABLED` | `server.py`, `mcp_modules/config.py` | No | Production default false; MCP developer tooling gate |
| `DEVELOPER_REGISTRY_JSON` | n/a (legacy) | Optional legacy | Legacy developer registry payload; no active backend reader |
| `HUSHH_DEVELOPER_TOKEN` | `api/routes/session.py` (`/api/user/lookup`) | Optional | Self-serve developer token for stdio MCP and token-auth developer lookups. Not part of the normal hosted runtime bootstrap. |

**Migrations/scripts:** Use **DB_*** only (same as runtime). `db/migrate.py` uses `db.connection.get_database_url()` and `get_database_ssl()`. No `DATABASE_URL` anywhere.

### Frontend (hushh-webapp)

| Variable | Where read | Required | Notes |
|----------|------------|----------|--------|
| `NEXT_PUBLIC_BACKEND_URL` | `lib/api/consent.ts`, `lib/config.ts`, api routes, etc. | Yes | Prod build: from Secret Manager `BACKEND_URL` |
| `NEXT_PUBLIC_FIREBASE_*` (6 base keys) | `lib/firebase/config.ts` | Yes | API key, auth domain, project ID, storage bucket, messaging sender ID, app ID |
| `NEXT_PUBLIC_FIREBASE_VAPID_KEY` | `lib/notifications/fcm-service.ts` | Yes (prod build) | Web FCM token registration; from Firebase Console. See [fcm-notifications.md](../../../consent-protocol/docs/reference/fcm-notifications.md). |
| `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID_UAT` / `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID_STAGING` / `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID_PRODUCTION` | `lib/firebase/config.ts` | Recommended | Use UAT + production IDs; staging key is legacy-compatible alias |
| `NEXT_PUBLIC_GTM_ID_UAT` / `NEXT_PUBLIC_GTM_ID_STAGING` / `NEXT_PUBLIC_GTM_ID_PRODUCTION` | `app/layout.tsx`, `lib/observability/env.ts` | Recommended | Use UAT + production GTM IDs; staging key is legacy-compatible alias |
| `NEXT_PUBLIC_APP_ENV` | `lib/app-env.ts`, `lib/observability/env.ts`, `app/page.tsx` | Recommended | Canonical frontend environment key (`development`, `uat`, `production`) |
| `NEXT_PUBLIC_OBSERVABILITY_ENV` | `lib/app-env.ts` | Optional legacy | Read-only fallback when `NEXT_PUBLIC_APP_ENV` is unset |
| `NEXT_PUBLIC_ENVIRONMENT_MODE` | `lib/app-env.ts` | Optional legacy | Read-only fallback when `NEXT_PUBLIC_APP_ENV` is unset |
| `NEXT_PUBLIC_OBSERVABILITY_ENABLED` / `NEXT_PUBLIC_OBSERVABILITY_DEBUG` / `NEXT_PUBLIC_OBSERVABILITY_SAMPLE_RATE` | `lib/observability/env.ts` | No | Client analytics rollout controls |
| `NEXT_PUBLIC_CONSENT_TIMEOUT_SECONDS` | `lib/constants.ts` | No | |
| `NEXT_PUBLIC_FRONTEND_URL` | `lib/config.ts` | No | |
| `CAPACITOR_BUILD` | `next.config.ts` | Build script | |
| `BACKEND_URL` | Server-side api routes | Hosted runtime required | Canonical runtime backend origin for Next.js route handlers |
| `SESSION_SECRET` | `lib/auth/session.ts` | If session API | Server-only |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | `lib/firebase/admin.ts` | Server-side Firebase | Server-only |
| `FIREBASE_AUTH_SERVICE_ACCOUNT_JSON` | `lib/firebase/admin.ts` | Shared-auth override | Server-only; if set, it should point at the same Firebase project that issued the login token being verified |

---

## Backend (consent-protocol) — reference

| Variable | Required | Secret | Where set | Notes |
|----------|----------|--------|-----------|--------|
| `SECRET_KEY` | Yes | Yes | Local: `.env`; Prod: Secret Manager | 32+ chars; HMAC signing |
| `VAULT_ENCRYPTION_KEY` | Yes | Yes | Local: `.env`; Prod: Secret Manager | 64-char hex |
| `DB_USER` | Yes | Yes (prod) | Local: `.env`; Prod: Secret Manager | Supabase pooler username |
| `DB_PASSWORD` | Yes | Yes (prod) | Local: `.env`; Prod: Secret Manager | DB password |
| `DB_HOST` | Yes | No | Local: `.env`; Prod: Cloud Run env | Pooler host |
| `DB_PORT` | No | No | Local: `.env`; Prod: Cloud Run env (default 5432) | |
| `DB_NAME` | No | No | Local: `.env`; Prod: Cloud Run env (default postgres) | |
| `FRONTEND_URL` | Yes | Yes (prod) | Local: `.env`; Prod: Secret Manager | CORS fallback source |
| `CORS_ALLOWED_ORIGINS` | Yes (prod recommended) | No | Local: `.env`; Prod: Cloud Run env | Explicit CORS allowlist (comma-separated) |
| `GOOGLE_API_KEY` | Yes (for Gemini) | Yes | Local: `.env`; Prod: Secret Manager | Or GEMINI_API_KEY |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Yes (auth) | Yes | Local: `.env`; Prod: Secret Manager | JSON string |
| `ENVIRONMENT` | No | No | Default development; Prod: Cloud Run | production / development |
| `OTEL_ENABLED` | No | No | Local: `.env`; Prod: Cloud Run env | Enables OpenTelemetry export to Cloud Trace |
| `GOOGLE_GENAI_USE_VERTEXAI` | No | No | Local: `.env`; Prod: Cloud Run env | True for Vertex AI |
| `AGENT_ID` | No | No | `.env` (default agent_hushh_default) | |
| `HUSHH_HACKATHON` | No | No | `.env` (default disabled) | |
| `DEFAULT_CONSENT_TOKEN_EXPIRY_MS` | No | No | `.env` | |
| `DEFAULT_TRUST_LINK_EXPIRY_MS` | No | No | `.env` | |
| `CONSENT_TIMEOUT_SECONDS` | No | No | `.env` / MCP config | |
| `PORT` | No | No | Optional (uvicorn/runner) | |
| `ROOT_PATH` | No | No | Optional (Swagger) | |
| `APP_REVIEW_MODE` | No | Yes (prod) | Local: `.env`; Prod: Secret Manager | Backend app-review toggle |
| `HUSHH_APP_REVIEW_MODE` | No | No | Optional alternative key | Alias toggle for app review |
| `REVIEWER_UID` | If app review | Yes (prod) | Local: `.env`; Prod: Secret Manager | Reviewer Firebase UID for custom token minting |
| `CONSENT_SSE_ENABLED` | No | No | Local: `.env`; UAT/Prod: Cloud Run env | Local + UAT should be true for web fallback validation; production stays false by default (FCM-first) |
| `SYNC_REMOTE_ENABLED` | No | No | Local: `.env`; Prod: Cloud Run env | Legacy deploy flag; keep false |
| `DEVELOPER_API_ENABLED` | No | No | Local: `.env`; Prod: Cloud Run env | Keep false in production |
| `OBS_DATA_STALE_RATIO_THRESHOLD` | No | No | Local: `.env`; Scheduler/Job env | Threshold for Supabase data-health stale-ratio anomaly |
| `DEVELOPER_REGISTRY_JSON` | Optional legacy | No | Local/non-prod env | Legacy developer registry JSON |
| `HUSHH_DEVELOPER_TOKEN` | Optional | No | Local: `.env` when needed | Self-serve developer token for stdio MCP and token-auth `/api/user/lookup` |

**CI (GitHub Actions):** Backend tests use `TESTING=true`, dummy `SECRET_KEY`, and dummy `VAULT_ENCRYPTION_KEY`; no `.env` file required.

### MCP-only vars (not required for backend API runtime)

These are used by MCP modules (`mcp_modules/`) for MCP server functionality, not by the FastAPI backend:

- `CONSENT_API_URL` - MCP server FastAPI URL (defaults to `http://localhost:8000`)
- `PRODUCTION_MODE` - MCP server production mode flag
- `DEVELOPER_API_ENABLED` - MCP view of `/api/v1/*` availability (default false in production)
- `HUSHH_DEVELOPER_TOKEN` - optional self-serve developer token for stdio MCP and token-auth lookup

**Note:** These are not required for Cloud Run backend deployment; only needed when running the MCP server locally.

---

## Frontend (hushh-webapp)

| Variable | Required | Secret | Where set | Notes |
|----------|----------|--------|-----------|--------|
| `NEXT_PUBLIC_BACKEND_URL` | Yes | No | Local: `.env.local`; Prod build: Secret Manager (BACKEND_URL) | Baked at build time |
| `NEXT_PUBLIC_FIREBASE_API_KEY` | Yes | No | Local: `.env.local`; CI: dummy; Prod: build-arg | Public |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | Yes | No | Same as above | |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | Yes | No | Same as above | |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | Yes | No | `.env.local` / CI / Prod build-arg | Required by current Cloud Build frontend manifest |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | Yes | No | Same | Required by current Cloud Build frontend manifest |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | Yes | No | Same | Required by current Cloud Build frontend manifest |
| `NEXT_PUBLIC_FIREBASE_VAPID_KEY` | Yes | No | Same | **Web push (FCM)**: VAPID key from Firebase Console -> Cloud Messaging -> Web configuration -> Key pair. Required for production build and consent push on web. See [fcm-notifications.md](../../../consent-protocol/docs/reference/fcm-notifications.md). |
| `NEXT_PUBLIC_AUTH_FIREBASE_API_KEY` | Shared-auth override | No | `.env.local` / CI / build-arg | Use when login stays on the shared auth project instead of the environment-specific app project |
| `NEXT_PUBLIC_AUTH_FIREBASE_AUTH_DOMAIN` | Shared-auth override | No | Same | Keep aligned with the same shared auth project used for login |
| `NEXT_PUBLIC_AUTH_FIREBASE_PROJECT_ID` | Shared-auth override | No | Same | Keep aligned with the same shared auth project used for login |
| `NEXT_PUBLIC_AUTH_FIREBASE_APP_ID` | Shared-auth override | No | Same | Keep aligned with the same shared auth project used for login |
| `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID_UAT` | Recommended | No | `.env.local` / CI / build-arg | Analytics measurement ID for UAT (preferred key) |
| `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID_STAGING` | Optional legacy | No | `.env.local` / CI / build-arg | Backward-compatible alias for UAT measurement ID |
| `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID_PRODUCTION` | Recommended | No | `.env.local` / CI / Prod build-arg | Analytics measurement ID for production |
| `NEXT_PUBLIC_GTM_ID_UAT` | Recommended | No | `.env.local` / CI / build-arg | GTM container for UAT (preferred key) |
| `NEXT_PUBLIC_GTM_ID_STAGING` | Optional legacy | No | `.env.local` / CI / build-arg | Backward-compatible alias for UAT GTM container |
| `NEXT_PUBLIC_GTM_ID_PRODUCTION` | Recommended | No | `.env.local` / CI / Prod build-arg | GTM container for production |
| `NEXT_PUBLIC_APP_ENV` | Recommended | No | `.env.local` / CI / build-arg | Canonical frontend environment key: `development` / `uat` / `production` |
| `NEXT_PUBLIC_OBSERVABILITY_ENV` | Optional legacy | No | `.env.local` / CI / build-arg | Read-only fallback key when `NEXT_PUBLIC_APP_ENV` is unset |
| `NEXT_PUBLIC_ENVIRONMENT_MODE` | Optional legacy | No | `.env.local` / CI / build-arg | Read-only fallback key when `NEXT_PUBLIC_APP_ENV` is unset |
| `NEXT_PUBLIC_OBSERVABILITY_ENABLED` | No | No | `.env.local` / CI / Prod build-arg | Toggle analytics emission |
| `NEXT_PUBLIC_OBSERVABILITY_DEBUG` | No | No | `.env.local` / CI / Prod build-arg | Debug logging for observability client |
| `NEXT_PUBLIC_OBSERVABILITY_SAMPLE_RATE` | No | No | `.env.local` / CI / Prod build-arg | Sampling rate (0-1) |
| `CAPACITOR_BUILD` | For native build | No | Set by npm script | true for cap:build |
| `NODE_ENV` | No | No | Set by Next.js / CI | |
| `BACKEND_URL` | Server-side | Hosted runtime required | Cloud Run runtime env or local profile value; do not leave unset in hosted environments | |
| `SESSION_SECRET` | If using session API | Yes | Server env only | Not in client |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Server-side Firebase | Yes | Server env only | |
| `FIREBASE_AUTH_SERVICE_ACCOUNT_JSON` | Auth token verification shared-auth override | No | Server env only | Falls back to `FIREBASE_SERVICE_ACCOUNT_JSON` if unset; when set, keep aligned with the Firebase project that issued the token |
| `NEXT_PUBLIC_CONSENT_TIMEOUT_SECONDS` | No | No | Optional; sync with backend | |
| `NEXT_PUBLIC_FRONTEND_URL` | No | No | Optional | |

**CI:** Frontend build uses dummy Firebase vars and `NEXT_PUBLIC_BACKEND_URL=https://api.example.com`; no `.env.local` required.

**Prod/UAT deploy (Cloud Build):** Secret `BACKEND_URL` is passed both as a build-arg and as a Cloud Run runtime env so client and server-side route handlers stay aligned.

### Legacy/Deprecated vars

- ~~`NEXT_PUBLIC_CONSENT_API_URL`~~ - **Removed**: Use `NEXT_PUBLIC_BACKEND_URL` instead. Updated in `lib/api/consent.ts` to use `NEXT_PUBLIC_BACKEND_URL`.

---

## Secret Manager (GCP) — strict parity with code

Secret Manager must hold **exactly** the keys the code uses. No extra secrets; no missing secrets. Cloud Build injects only these.

### Backend baseline (10 secrets) — all injected by `deploy/backend.cloudbuild.yaml`

| Secret name | Env var / usage in code |
|-------------|-------------------------|
| `SECRET_KEY` | `SECRET_KEY` (hushh_mcp/config.py) |
| `VAULT_ENCRYPTION_KEY` | `VAULT_ENCRYPTION_KEY` (hushh_mcp/config.py) |
| `GOOGLE_API_KEY` | `GOOGLE_API_KEY` (config + Gemini/Vertex services) |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | `FIREBASE_SERVICE_ACCOUNT_JSON` (api/utils/firebase_admin.py) |
| `FIREBASE_AUTH_SERVICE_ACCOUNT_JSON` | `FIREBASE_AUTH_SERVICE_ACCOUNT_JSON` (auth-only token verification app; falls back to FIREBASE_SERVICE_ACCOUNT_JSON if unset) |
| `FRONTEND_URL` | `FRONTEND_URL` (server.py CORS) |
| `DB_USER` | `DB_USER` (db/connection.py, db/db_client.py) |
| `DB_PASSWORD` | `DB_PASSWORD` (same) |
| `APP_REVIEW_MODE` | `APP_REVIEW_MODE` (api/routes/health.py) |
| `REVIEWER_UID` | `REVIEWER_UID` (api/routes/health.py) |

### Backend market-data add-ons (2 secrets)

| Secret name | Env var / usage in code |
|-------------|-------------------------|
| `FINNHUB_API_KEY` | `FINNHUB_API_KEY` (`api/routes/kai/market_insights.py`, `hushh_mcp/operons/kai/fetchers.py`) |
| `PMP_API_KEY` | `PMP_API_KEY` (`api/routes/kai/market_insights.py`, `hushh_mcp/operons/kai/fetchers.py`) |
**Not in Secret Manager (set as Cloud Run env vars in cloudbuild):** `DB_HOST`, `DB_PORT`, `DB_NAME`, `ENVIRONMENT`, `GOOGLE_GENAI_USE_VERTEXAI`, `CONSENT_SSE_ENABLED`, `SYNC_REMOTE_ENABLED`, `DEVELOPER_API_ENABLED`, `CORS_ALLOWED_ORIGINS`.

**Strict parity:** `DATABASE_URL` is not used anywhere. Migrations (`db/migrate.py`) use **DB_*** only, via `db.connection.get_database_url()`. Do **not** create or keep `DATABASE_URL` in Secret Manager; delete it if present.

### Frontend (16 centrally-managed build-time values + runtime auth secrets)

| Secret name | Build-arg / usage in code |
|-------------|---------------------------|
| `BACKEND_URL` | `NEXT_PUBLIC_BACKEND_URL` (baked into client) |
| `NEXT_PUBLIC_FIREBASE_API_KEY` | `NEXT_PUBLIC_FIREBASE_API_KEY` |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | `NEXT_PUBLIC_FIREBASE_PROJECT_ID` |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | `NEXT_PUBLIC_FIREBASE_APP_ID` |
| `NEXT_PUBLIC_FIREBASE_VAPID_KEY` | `NEXT_PUBLIC_FIREBASE_VAPID_KEY` (Web FCM push key) |
| `NEXT_PUBLIC_AUTH_FIREBASE_API_KEY` | `NEXT_PUBLIC_AUTH_FIREBASE_API_KEY` (auth-only web override) |
| `NEXT_PUBLIC_AUTH_FIREBASE_AUTH_DOMAIN` | `NEXT_PUBLIC_AUTH_FIREBASE_AUTH_DOMAIN` (auth-only web override) |
| `NEXT_PUBLIC_AUTH_FIREBASE_PROJECT_ID` | `NEXT_PUBLIC_AUTH_FIREBASE_PROJECT_ID` (auth-only web override) |
| `NEXT_PUBLIC_AUTH_FIREBASE_APP_ID` | `NEXT_PUBLIC_AUTH_FIREBASE_APP_ID` (auth-only web override) |
| `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID_STAGING` | `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID_STAGING` |
| `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID_PRODUCTION` | `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID_PRODUCTION` |
| `NEXT_PUBLIC_GTM_ID_STAGING` | `NEXT_PUBLIC_GTM_ID_STAGING` |
| `NEXT_PUBLIC_GTM_ID_PRODUCTION` | `NEXT_PUBLIC_GTM_ID_PRODUCTION` |

Cloud Run frontend runtime secrets (server-only Next.js API handlers):

| Secret name | Runtime env usage in code |
|-------------|---------------------------|
| `FIREBASE_SERVICE_ACCOUNT_JSON` | `lib/firebase/admin.ts` |
| `FIREBASE_AUTH_SERVICE_ACCOUNT_JSON` | `lib/firebase/admin.ts` (auth split verifier) |

### gcloud CLI: list and create only these secrets

```bash
# List existing required secrets (26 unique names in the current contract)
gcloud secrets list --project=YOUR_PROJECT_ID

# Create a missing backend secret (repeat for each of the 10 names)
gcloud secrets create SECRET_KEY --replication-policy=automatic --project=YOUR_PROJECT_ID
echo -n "your-value" | gcloud secrets versions add SECRET_KEY --data-file=- --project=YOUR_PROJECT_ID

# Create missing frontend values in Secret Manager (repeat for each of the 16 client-facing names)
gcloud secrets create BACKEND_URL --replication-policy=automatic --project=YOUR_PROJECT_ID
echo -n "https://your-backend.run.app" | gcloud secrets versions add BACKEND_URL --data-file=- --project=YOUR_PROJECT_ID
```

**Required backend 10:** `SECRET_KEY`, `VAULT_ENCRYPTION_KEY`, `GOOGLE_API_KEY`, `FIREBASE_SERVICE_ACCOUNT_JSON`, `FIREBASE_AUTH_SERVICE_ACCOUNT_JSON`, `FRONTEND_URL`, `DB_USER`, `DB_PASSWORD`, `APP_REVIEW_MODE`, `REVIEWER_UID`.
**Required backend Plaid secrets when brokerage is enabled:** `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_TOKEN_ENCRYPTION_KEY`.
**Required frontend 16:** `BACKEND_URL`, `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`, `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`, `NEXT_PUBLIC_FIREBASE_APP_ID`, `NEXT_PUBLIC_FIREBASE_VAPID_KEY`, `NEXT_PUBLIC_AUTH_FIREBASE_API_KEY`, `NEXT_PUBLIC_AUTH_FIREBASE_AUTH_DOMAIN`, `NEXT_PUBLIC_AUTH_FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_AUTH_FIREBASE_APP_ID`, `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID_STAGING`, `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID_PRODUCTION`, `NEXT_PUBLIC_GTM_ID_STAGING`, `NEXT_PUBLIC_GTM_ID_PRODUCTION`.

Operational note:
- The `NEXT_PUBLIC_AUTH_FIREBASE_*` values may intentionally differ from the primary `NEXT_PUBLIC_FIREBASE_*` values when login stays on the shared auth project. If they differ, keep the override quartet internally aligned and ensure backend auth verification uses that same shared auth project.

These Firebase values are public client config, but storing them in Secret Manager keeps deployment manifests free of hardcoded production values.

**Note:** Consent push on web uses FCM and requires `NEXT_PUBLIC_FIREBASE_VAPID_KEY`. The value comes from Firebase Console (Cloud Messaging -> Web Push certificates), and deployment should source it through Secret Manager for consistency.

**Delete if present (strict parity):** `DATABASE_URL` is not used anywhere. To remove:
```bash
gcloud secrets delete DATABASE_URL --project=YOUR_PROJECT_ID
```

Verify manually with `gcloud secrets list --project=YOUR_PROJECT_ID` and the checklist in [deploy/README.md](../../../deploy/README.md).

---

## Backup/Recovery Ops Keys

### GitHub Actions (required)

| Key | Scope | Used by | Notes |
|-----|-------|---------|-------|
| `GCP_SA_KEY` | GitHub Actions secret | `.github/workflows/deploy-production.yml`, `.github/workflows/prod-supabase-backup-posture.yml` | Service-account JSON with Cloud Run + Storage read access for backup gates |

### Cloud Run Job runtime config (required for logical backup)

| Key | Scope | Used by | Notes |
|-----|-------|---------|-------|
| `BACKUP_BUCKET` | Cloud Run Job env | `scripts/ops/supabase_logical_backup.py` | GCS bucket for backup artifacts |
| `BACKUP_PREFIX` | Cloud Run Job env | `scripts/ops/supabase_logical_backup.py`, `scripts/ops/logical_backup_freshness_check.py` | Prefix path in bucket (`prod/supabase-logical`) |
| `BACKUP_RETENTION_DAYS` | Cloud Run Job env | `scripts/ops/supabase_logical_backup.py` | Metadata + lifecycle target (default `14`) |
| `BACKUP_MAX_AGE_HOURS` | Deploy/workflow env | `scripts/ops/logical_backup_freshness_check.py` | Freshness gate threshold (default `30`) |

Validation command:

```bash
python3 scripts/ops/logical_backup_freshness_check.py \
  --project-id hushh-pda \
  --bucket hushh-pda-prod-db-backups \
  --prefix prod/supabase-logical \
  --max-age-hours 30 \
  --report-path /tmp/prod-backup-posture-report.json
```

---

## Mobile Firebase Artifacts (iOS/Android)

Committed files:
- `hushh-webapp/ios/App/App/GoogleService-Info.plist` (template only)
- `hushh-webapp/android/app/google-services.json` (template only)

Production release process:
- Store base64-encoded production artifacts in Secret Manager:
  - `IOS_GOOGLESERVICE_INFO_PLIST_B64`
  - `ANDROID_GOOGLE_SERVICES_JSON_B64`
- Local developer flow:
  - `npm run bootstrap` hydrates the native Firebase values into the selected frontend profile env file when `gcloud` access is available
  - the active profile is copied into `hushh-webapp/.env.local`
  - native artifacts are materialized next to it under `hushh-webapp/.env.local.d/`
  - native build wrappers apply the generated artifacts only for the build and then restore the tracked templates
  - if a developer already has real local plist/json files in the native paths or the old `.local-secrets` cache, the first materialization seeds the active env/sidecar instead of overwriting that local state
- Release CI decodes and overwrites template files only inside the ephemeral job workspace before native build/sign.
- Optionally fetch latest artifacts from Firebase directly into the active profile env with `cd hushh-webapp && npm run sync:mobile-firebase`.
- Run `npm run verify:mobile-firebase:release` to fail fast if templates were not replaced.
  - This release gate also enforces analytics readiness (`IS_ANALYTICS_ENABLED=true` on iOS and `services.analytics_service` present on Android).

Repository guard:
- CI runs `npm run verify:mobile-firebase` to ensure committed files remain templates (no production artifact commits, no real Firebase-style API keys).

Local iOS signing:
- Store Apple signing assets in Secret Manager and hydrate them into the frontend runtime profile files.
- `npm run bootstrap` materializes those values into `hushh-webapp/.env.local.d/ios/` on macOS when they are available.
- `ios/debug.xcconfig` and `ios/release.xcconfig` include the generated sidecar files conditionally, so clean machines can be bootstrapped without editing the tracked Xcode project state by hand.
- iOS native run wrappers self-heal on first use by preparing the active signing sidecar and local keychain/profile state automatically when it is missing.

Local Android release signing:
- Store Android release keystore and signing values in Secret Manager and hydrate them into the frontend runtime profile files.
- `npm run bootstrap` materializes the active release keystore and signing properties under `hushh-webapp/.env.local.d/android/`.
- Local release/archive flows read the generated signing properties from the active sidecar instead of a manually maintained `android/key.properties`.

---

## Where variables are set

| Context | Backend | Frontend |
|---------|---------|----------|
| Local dev | `consent-protocol/.env` (from `.env.example`) | `hushh-webapp/.env.local` |
| CI | Env in workflow (dummy keys, TESTING=true) | Env in workflow (dummy Firebase, BACKEND_URL) |
| Production | Secret Manager + Cloud Run env (GOOGLE_GENAI_USE_VERTEXAI, ENVIRONMENT) | Secret Manager → build-args in Dockerfile |
