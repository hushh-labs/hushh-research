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
- PKM rehearsal toggles, maintainer smoke identities, and review/bypass overlays belong in maintainer-only overlays, not in the canonical contributor runtime files.
5. Runtime profile bootstrap command:

```bash
./bin/hushh bootstrap
```

This is the supported contributor entrypoint. It installs dependencies, hydrates local runtime-profile files from templates plus current cloud secrets/runtime metadata when available, and runs the profile doctor.
It does not print secret values and sets profile files to `chmod 600`.
For backend Gmail and voice, bootstrap hydrates `consent-protocol/.env` using the same key names as hosted runtime. Missing Gmail/voice cloud values are warnings by default and only become failures with `--strict`.

6. Activate the chosen runtime profile:

```bash
./bin/hushh doctor --mode local
./bin/hushh web
./bin/hushh web --mode uat
./bin/hushh web --mode prod
./bin/hushh native ios --mode uat
./bin/hushh native android --mode uat
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

Deploy workflows add Gmail and voice runtime checks with `--require-gmail --require-voice`. That enforcement stays in deploy/runtime verification and is not part of the default contributor PR CI lane.

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
3. The frontend and backend now use that same Firebase project directly; there is no separate auth-only override contract.
4. UAT and production share the live Plaid credential set; only local development should use sandbox Plaid secrets and `PLAID_ENV=sandbox`.
5. Web consent delivery uses different defaults by environment:
   - local development: `CONSENT_SSE_ENABLED=true`
   - UAT: `CONSENT_SSE_ENABLED=true`
   - production: `CONSENT_SSE_ENABLED=false` unless there is an explicit incident-response or rollout reason to enable it
6. App-review toggles, reviewer identities, bypass flags, and local test-user keys are maintainer-only overlays and are intentionally excluded from the canonical contributor runtime contract.

### Environment divergence note (current)

1. UAT and production use the same canonical frontend key shape.
2. Each deployed environment resolves one active analytics measurement ID and one active GTM ID.
3. Maintainer-only overlays are intentionally excluded from generated contributor runtime files.

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
| `APP_SIGNING_KEY` | `hushh_mcp/config.py` | Yes | Min 32 chars (64-char hex recommended); signing/state integrity only |
| `VAULT_DATA_KEY` | `hushh_mcp/config.py` | Yes | Exactly 64-char hex; vault/PKM encryption only |
| `DB_USER` | `db/connection.py`, `db/db_client.py` | Yes | |
| `DB_PASSWORD` | same | Yes | |
| `DB_HOST` | same | Yes | |
| `DB_PORT` | same | No (default 5432) | |
| `DB_NAME` | same | No (default postgres) | |
| `APP_FRONTEND_ORIGIN` | `server.py` | Yes (prod CORS fallback) | |
| `CORS_ALLOWED_ORIGINS` | `server.py` | Yes (prod recommended) | Explicit comma-separated CORS allowlist |
| `FIREBASE_ADMIN_CREDENTIALS_JSON` | `api/utils/firebase_admin.py` | Yes (auth) | |
| `GOOGLE_API_KEY` | `hushh_mcp/config.py`, services | Yes (Gemini/Vertex) | |
| `GMAIL_OAUTH_CLIENT_ID` | `hushh_mcp/services/gmail_receipts_service.py` | Yes (Gmail sync) | Gmail OAuth client id. Same key name across local, UAT, and production. |
| `GMAIL_OAUTH_CLIENT_SECRET` | `hushh_mcp/services/gmail_receipts_service.py` | Yes (Gmail sync) | Gmail OAuth client secret. Same key name across local, UAT, and production. |
| `GMAIL_OAUTH_REDIRECT_URI` | `hushh_mcp/services/gmail_receipts_service.py` | Yes (Gmail sync) | Gmail OAuth redirect URI. Same key name across local, UAT, and production. |
| `GMAIL_OAUTH_TOKEN_KEY` | `hushh_mcp/services/gmail_receipts_service.py` | Yes (Gmail sync) | Encryption key for persisted Gmail OAuth tokens. Same key name across local, UAT, and production. |
| `OPENAI_API_KEY` | `hushh_mcp/services/voice_intent_service.py` | Yes (voice) | Required for voice STT, planning, TTS, and realtime sessions. |
| `VOICE_RUNTIME_CONFIG_JSON` | `hushh_mcp/runtime_settings.py`, `api/routes/kai/voice.py`, `hushh_mcp/services/voice_intent_service.py` | Yes (voice) | Structured voice runtime config covering rollout, canary, allowlists, fail-fast policy, and model defaults. |
| `DEFAULT_CONSENT_TOKEN_EXPIRY_MS` | `hushh_mcp/config.py` | No | |
| `DEFAULT_TRUST_LINK_EXPIRY_MS` | same | No | |
| `ENVIRONMENT` | `hushh_mcp/config.py`, `api/routes/debug_firebase.py` | No | |
| `OTEL_ENABLED` | `api/middlewares/observability.py` | No | Enables OpenTelemetry export to Cloud Trace when true |
| `AGENT_ID` | `hushh_mcp/config.py` | No | |
| `HUSHH_HACKATHON` | `hushh_mcp/config.py` | No | |
| `CONSENT_TIMEOUT_SECONDS` | `mcp_modules/config.py` | No | MCP server timeout (not required for FastAPI runtime) |
| `ROOT_PATH` | `server.py` | No | |
| `GOOGLE_GENAI_USE_VERTEXAI` | Cloud Run env (Gemini SDK) | No | Set in deploy, not in .env |
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
| `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID` | `lib/observability/env.ts` | Recommended | Active GA4 measurement ID for the deployed environment |
| `NEXT_PUBLIC_GTM_ID` | `app/layout.tsx`, `lib/observability/env.ts` | Recommended | Active GTM container for the deployed environment |
| `NEXT_PUBLIC_APP_ENV` | `lib/app-env.ts`, `lib/observability/env.ts`, `app/page.tsx` | Recommended | Canonical frontend environment key (`development`, `uat`, `production`) |
| `NEXT_PUBLIC_OBSERVABILITY_ENV` | `lib/app-env.ts` | Optional legacy | Read-only fallback when `NEXT_PUBLIC_APP_ENV` is unset |
| `NEXT_PUBLIC_ENVIRONMENT_MODE` | `lib/app-env.ts` | Optional legacy | Read-only fallback when `NEXT_PUBLIC_APP_ENV` is unset |
| `NEXT_PUBLIC_OBSERVABILITY_ENABLED` / `NEXT_PUBLIC_OBSERVABILITY_DEBUG` / `NEXT_PUBLIC_OBSERVABILITY_SAMPLE_RATE` | `lib/observability/env.ts` | No | Client analytics rollout controls |
| `NEXT_PUBLIC_CONSENT_TIMEOUT_SECONDS` | `lib/constants.ts` | No | |
| `CAPACITOR_BUILD` | `next.config.ts` | Build script | |
| `BACKEND_URL` | Server-side api routes | Hosted runtime required | Canonical runtime backend origin for Next.js route handlers |
| `SESSION_SECRET` | `lib/auth/session.ts` | If session API | Server-only |
| `FIREBASE_ADMIN_CREDENTIALS_JSON` | `lib/firebase/admin.ts` | Server-side Firebase | Server-only |

---

## Backend (consent-protocol) — reference

| Variable | Required | Secret | Where set | Notes |
|----------|----------|--------|-----------|--------|
| `APP_SIGNING_KEY` | Yes | Yes | Local: `.env`; Prod: Secret Manager | 32+ chars; HMAC signing |
| `VAULT_DATA_KEY` | Yes | Yes | Local: `.env`; Prod: Secret Manager | 64-char hex |
| `DB_USER` | Yes | Yes (prod) | Local: `.env`; Prod: Secret Manager | Supabase pooler username |
| `DB_PASSWORD` | Yes | Yes (prod) | Local: `.env`; Prod: Secret Manager | DB password |
| `DB_HOST` | Yes | No | Local: `.env`; Prod: Cloud Run env | Pooler host |
| `DB_PORT` | No | No | Local: `.env`; Prod: Cloud Run env (default 5432) | |
| `DB_NAME` | No | No | Local: `.env`; Prod: Cloud Run env (default postgres) | |
| `APP_FRONTEND_ORIGIN` | Yes | Yes (prod) | Local: `.env`; Prod: Secret Manager | CORS fallback source |
| `BACKEND_RUNTIME_CONFIG_JSON` | Yes | Yes (prod) | Local: `.env`; Prod: Secret Manager | Structured runtime policy for DB socket, CORS, remote toggles, and platform settings |
| `CORS_ALLOWED_ORIGINS` | Yes (prod recommended) | No | Local: `.env`; Prod: Cloud Run env | Explicit CORS allowlist (comma-separated) |
| `GOOGLE_API_KEY` | Yes (for Gemini) | Yes | Local: `.env`; Prod: Secret Manager | Or GEMINI_API_KEY |
| `GMAIL_OAUTH_CLIENT_ID` | Yes (Gmail sync) | Yes | Local: `.env`; Hosted: Secret Manager | Same key name across local, UAT, and production. |
| `GMAIL_OAUTH_CLIENT_SECRET` | Yes (Gmail sync) | Yes | Local: `.env`; Hosted: Secret Manager | Same key name across local, UAT, and production. |
| `GMAIL_OAUTH_REDIRECT_URI` | Yes (Gmail sync) | Yes | Local: `.env`; Hosted: Secret Manager | Same key name across local, UAT, and production. |
| `GMAIL_OAUTH_TOKEN_KEY` | Yes (Gmail sync) | Yes | Local: `.env`; Hosted: Secret Manager | Same key name across local, UAT, and production. |
| `OPENAI_API_KEY` | Yes (voice) | Yes | Local: `.env`; Hosted: Secret Manager | Required for voice runtime. |
| `VOICE_RUNTIME_CONFIG_JSON` | Yes (voice) | Yes | Local: `.env`; Hosted: Secret Manager | Structured runtime config for voice rollout, fail-fast policy, and model selection. |
| `FIREBASE_ADMIN_CREDENTIALS_JSON` | Yes (auth) | Yes | Local: `.env`; Prod: Secret Manager | JSON string |
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
| `CONSENT_SSE_ENABLED` | No | No | Local: `.env`; UAT/Prod: Cloud Run env | Local + UAT should be true for web fallback validation; production stays false by default (FCM-first) |
| `SYNC_REMOTE_ENABLED` | No | No | Local: `.env`; Prod: Cloud Run env | Legacy deploy flag; keep false |
| `DEVELOPER_API_ENABLED` | No | No | Local: `.env`; Prod: Cloud Run env | Keep false in production |
| `OBS_DATA_STALE_RATIO_THRESHOLD` | No | No | Local: `.env`; Scheduler/Job env | Threshold for Supabase data-health stale-ratio anomaly |
| `DEVELOPER_REGISTRY_JSON` | Optional legacy | No | Local/non-prod env | Legacy developer registry JSON |
| `HUSHH_DEVELOPER_TOKEN` | Optional | No | Local: `.env` when needed | Self-serve developer token for stdio MCP and token-auth `/api/user/lookup` |

**CI (GitHub Actions):** Backend tests use `TESTING=true`, dummy `APP_SIGNING_KEY`, and dummy `VAULT_DATA_KEY`; no `.env` file required.

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
| `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID` | Recommended | No | `.env.local` / CI / build-arg | Active analytics measurement ID for the deployed environment |
| `NEXT_PUBLIC_GTM_ID` | Recommended | No | `.env.local` / CI / build-arg | Active GTM container for the deployed environment |
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
| `FIREBASE_ADMIN_CREDENTIALS_JSON` | Server-side Firebase | Yes | Server env only | |
| `NEXT_PUBLIC_CONSENT_TIMEOUT_SECONDS` | No | No | Optional; sync with backend | |

**CI:** Frontend build uses dummy Firebase vars and `NEXT_PUBLIC_BACKEND_URL=https://api.example.com`; no `.env.local` required.

**Prod/UAT deploy (Cloud Build):** Secret `BACKEND_URL` is passed both as a build-arg and as a Cloud Run runtime env so client and server-side route handlers stay aligned.

### Legacy/Deprecated vars

- ~~`NEXT_PUBLIC_CONSENT_API_URL`~~ - **Removed**: Use `NEXT_PUBLIC_BACKEND_URL` instead. Updated in `lib/api/consent.ts` to use `NEXT_PUBLIC_BACKEND_URL`.

---

## Secret Manager (GCP) — strict parity with code

Secret Manager must hold **exactly** the keys the code uses. No extra secrets; no missing secrets. Cloud Build injects only these.

### Backend baseline (8 secrets) — all injected by `deploy/backend.cloudbuild.yaml`

| Secret name | Env var / usage in code |
|-------------|-------------------------|
| `APP_SIGNING_KEY` | `APP_SIGNING_KEY` (hushh_mcp/config.py) |
| `VAULT_DATA_KEY` | `VAULT_DATA_KEY` (hushh_mcp/config.py) |
| `GOOGLE_API_KEY` | `GOOGLE_API_KEY` (config + Gemini/Vertex services) |
| `FIREBASE_ADMIN_CREDENTIALS_JSON` | `FIREBASE_ADMIN_CREDENTIALS_JSON` (api/utils/firebase_admin.py) |
| `APP_FRONTEND_ORIGIN` | `APP_FRONTEND_ORIGIN` (server.py CORS) |
| `BACKEND_RUNTIME_CONFIG_JSON` | `BACKEND_RUNTIME_CONFIG_JSON` (runtime settings hydration for DB socket, CORS, remote toggles, and service policy) |
| `DB_USER` | `DB_USER` (db/connection.py, db/db_client.py) |
| `DB_PASSWORD` | `DB_PASSWORD` (same) |

### Backend voice add-ons (2 secrets)

| Secret name | Env var / usage in code |
|-------------|-------------------------|
| `OPENAI_API_KEY` | `OPENAI_API_KEY` (`hushh_mcp/services/voice_intent_service.py`) |
| `VOICE_RUNTIME_CONFIG_JSON` | `VOICE_RUNTIME_CONFIG_JSON` (`hushh_mcp/runtime_settings.py`, `api/routes/kai/voice.py`) |

### Backend market-data add-ons (2 secrets)

| Secret name | Env var / usage in code |
|-------------|-------------------------|
| `FINNHUB_API_KEY` | `FINNHUB_API_KEY` (`api/routes/kai/market_insights.py`, `hushh_mcp/operons/kai/fetchers.py`) |
| `PMP_API_KEY` | `PMP_API_KEY` (`api/routes/kai/market_insights.py`, `hushh_mcp/operons/kai/fetchers.py`) |
**Not in Secret Manager (set as Cloud Run env vars in cloudbuild):** `DB_HOST`, `DB_PORT`, `DB_NAME`, `ENVIRONMENT`, `GOOGLE_GENAI_USE_VERTEXAI`, `CONSENT_SSE_ENABLED`, `SYNC_REMOTE_ENABLED`, `DEVELOPER_API_ENABLED`, `CORS_ALLOWED_ORIGINS`.

**Strict parity:** `DATABASE_URL` is not used anywhere. Migrations (`db/migrate.py`) use **DB_*** only, via `db.connection.get_database_url()`. Do **not** create or keep `DATABASE_URL` in Secret Manager; delete it if present.

### Frontend (11 centrally-managed build-time values + one server-side runtime secret)

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
| `APP_FRONTEND_ORIGIN` | `NEXT_PUBLIC_APP_URL` |
| `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID` | `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID` |
| `NEXT_PUBLIC_GTM_ID` | `NEXT_PUBLIC_GTM_ID` |

Cloud Run frontend runtime secrets (server-only Next.js API handlers):

| Secret name | Runtime env usage in code |
|-------------|---------------------------|
| `FIREBASE_ADMIN_CREDENTIALS_JSON` | `lib/firebase/admin.ts` |

### gcloud CLI: list and create only these secrets

```bash
# List existing required secrets
gcloud secrets list --project=YOUR_PROJECT_ID

# Create a missing backend secret (repeat for each of the baseline names)
gcloud secrets create APP_SIGNING_KEY --replication-policy=automatic --project=YOUR_PROJECT_ID
echo -n "your-value" | gcloud secrets versions add APP_SIGNING_KEY --data-file=- --project=YOUR_PROJECT_ID

# Create missing frontend values in Secret Manager (repeat for each of the 16 client-facing names)
gcloud secrets create BACKEND_URL --replication-policy=automatic --project=YOUR_PROJECT_ID
echo -n "https://your-backend.run.app" | gcloud secrets versions add BACKEND_URL --data-file=- --project=YOUR_PROJECT_ID
```

**Required backend 8:** `APP_SIGNING_KEY`, `VAULT_DATA_KEY`, `GOOGLE_API_KEY`, `FIREBASE_ADMIN_CREDENTIALS_JSON`, `APP_FRONTEND_ORIGIN`, `BACKEND_RUNTIME_CONFIG_JSON`, `DB_USER`, `DB_PASSWORD`.
**Required backend voice secrets when enabled:** `OPENAI_API_KEY`, `VOICE_RUNTIME_CONFIG_JSON`.
**Required backend Plaid secrets when brokerage is enabled:** `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ACCESS_TOKEN_KEY`.
**Required frontend 11:** `BACKEND_URL`, `APP_FRONTEND_ORIGIN`, `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`, `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`, `NEXT_PUBLIC_FIREBASE_APP_ID`, `NEXT_PUBLIC_FIREBASE_VAPID_KEY`, `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID`, `NEXT_PUBLIC_GTM_ID`.

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
- `hushh-webapp/ios/App/App/GoogleService-Info-README.md` (tracks the iOS Firebase plist setup workflow)

Production release process:
- Store base64-encoded production artifacts in Secret Manager:
  - `IOS_GOOGLESERVICE_INFO_PLIST_B64`
  - `ANDROID_GOOGLE_SERVICES_JSON_B64`
- Release CI decodes and overwrites template files only inside the ephemeral job workspace before native build/sign.
- Frontend runtime profile files do not carry these native artifacts. Treat them as release-only inputs, not web runtime env.
- Local native developers manage platform artifacts in the native project paths or through explicit release tooling; `./bin/hushh bootstrap` does not materialize them into the active frontend runtime profile.

Repository guard:
- CI and the bootstrap/native build flow must preserve tracked Firebase artifacts as templates and keep real release artifacts out of git.

Local iOS signing:
- Store Apple signing assets in Secret Manager or your release system of record.
- They are not part of the canonical frontend runtime profile files and should not be added back to `hushh-webapp/.env.local*`.

Local Android release signing:
- Store Android release keystore and signing values in Secret Manager or your release system of record.
- They are not part of the canonical frontend runtime profile files and should not be added back to `hushh-webapp/.env.local*`.

---

## Where variables are set

| Context | Backend | Frontend |
|---------|---------|----------|
| Local dev | `consent-protocol/.env` (from `.env.example`) | `hushh-webapp/.env.local` |
| CI | Env in workflow (dummy keys, TESTING=true) | Env in workflow (dummy Firebase, BACKEND_URL) |
| Production | Secret Manager + Cloud Run env (GOOGLE_GENAI_USE_VERTEXAI, ENVIRONMENT) | Secret Manager → build-args in Dockerfile |
