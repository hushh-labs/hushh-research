# Hushh Research - Cloud Build Deployment

> CI/CD deployment using Google Cloud Build. Contributor setup lives in `./bin/hushh bootstrap` plus the docs under `docs/guides/`.

---

## 🚀 Quick Deploy

UAT is the first deployment lane. Do not treat production as the initial validation target.

Recommended order:

```bash
# local validation before touching deployment
bash scripts/ci/orchestrate.sh all

# release through main; UAT follows the green main SHA
git push origin main
```

The green `main` SHA triggers [`.github/workflows/deploy-uat.yml`](../.github/workflows/deploy-uat.yml), which now:

1. opens a Cloud SQL Auth Proxy session to the UAT database
2. applies the canonical release lane with `python3 consent-protocol/db/migrate.py --release`
3. enforces the live UAT schema contract in `consent-protocol/db/schema_contract/uat_integrated_schema.json`
4. deploys backend/frontend
5. reruns the read-only UAT schema contract gate after deploy
6. runs the hosted runtime parity check

### Backend Deployment

```bash
gcloud builds submit --config=deploy/backend.cloudbuild.yaml
```

### Frontend Deployment

```bash
gcloud builds submit --config=deploy/frontend.cloudbuild.yaml
```

---

## 🧭 Runtime Profiles

Contributor onboarding should start with:

```bash
./bin/hushh bootstrap
./bin/hushh doctor --mode uat
```

Detailed profile behavior now lives in:

- [docs/guides/getting-started.md](../docs/guides/getting-started.md)
- [docs/guides/environment-model.md](../docs/guides/environment-model.md)
- [docs/guides/advanced-ops.md](../docs/guides/advanced-ops.md)

Low-level profile activation still works when you need it:

- Backend active file: `consent-protocol/.env`
- Frontend active file: `hushh-webapp/.env.local`

Runtime profile source templates and activation behavior are documented in the guides and managed through the bootstrap/profile tooling. Do not document local unpublished profile filenames here as contributor-facing contract.

`local-uatdb` backend note:

- Start the backend with `bash scripts/runtime/run_backend_local.sh local-uatdb`
  only when you explicitly need the legacy UAT-backed local backend path.
- Do not start local UAT DB access with bare `python`/`uvicorn` unless the
  proxy is already running.
- The launcher starts `cloud-sql-proxy` automatically for the UAT Cloud SQL
  instance and authenticates it from `FIREBASE_SERVICE_ACCOUNT_JSON` in the
  active backend env, or `CLOUDSQL_PROXY_CREDENTIALS_FILE` if explicitly set.
- The launcher refuses to fall back to local `gcloud`/ADC credentials for this
  path.

### Blocking vs optional validation

Blocking by default:

1. `scripts/ci/secret-scan.sh`
2. `scripts/ci/web-check.sh`
3. `scripts/ci/protocol-check.sh`
4. `scripts/ci/integration-check.sh`

Canonical executor:

- `scripts/ci/orchestrate.sh` (used by GitHub Actions stages and local entrypoints)

Optional/advisory by default:

1. `scripts/ci/docs-parity-check.sh`
2. `scripts/ci/subtree-sync-check.sh`
3. `scripts/ops/verify-env-secrets-parity.py` (release/deploy preflight)
4. Native parity checks for native release lanes

Local full run with advisory checks:

```bash
./bin/hushh ci --include-advisory
```

### UAT analytics divergence note

UAT currently includes newer analytics/auth-split expectations (`NEXT_PUBLIC_AUTH_FIREBASE_*`, measurement IDs, GTM IDs).
Production analytics key migration is deferred intentionally and should be handled as a separate release task.

---

## 📋 Prerequisites

1. **Google Cloud SDK** installed and authenticated

   ```bash
   gcloud auth login
   gcloud config set project YOUR_GCP_PROJECT
   ```

2. **Enable Required APIs**

   ```bash
   gcloud services enable cloudbuild.googleapis.com
   gcloud services enable run.googleapis.com
   gcloud services enable containerregistry.googleapis.com
   gcloud services enable secretmanager.googleapis.com
   ```

3. **Configure Secrets** (one-time setup)

   Secrets in GCP Secret Manager must match **exactly** what the code uses — no more, no less. See [docs/reference/operations/env-and-secrets.md](../docs/reference/operations/env-and-secrets.md) for the full audit and gcloud CLI.

   ```bash
   python3 scripts/ops/verify-env-secrets-parity.py \
     --project hushh-pda \
     --region us-central1 \
     --backend-service consent-protocol \
     --frontend-service hushh-webapp
   ```

   For brokerage-enabled environments such as UAT Plaid testing, include:

   ```bash
   python3 scripts/ops/verify-env-secrets-parity.py \
     --project hushh-pda-uat \
     --region us-central1 \
     --backend-service consent-protocol \
     --frontend-service hushh-webapp \
     --require-plaid
   ```

   Required backend secrets (11):

   - `SECRET_KEY`
   - `VAULT_ENCRYPTION_KEY`
   - `GOOGLE_API_KEY`
   - `FIREBASE_SERVICE_ACCOUNT_JSON`
   - `FIREBASE_AUTH_SERVICE_ACCOUNT_JSON`
   - `FRONTEND_URL`
   - `DB_USER`
   - `DB_PASSWORD`
   - `APP_REVIEW_MODE`
   - `REVIEWER_UID`

   Optional when Plaid brokerage is enabled (3):

   - `PLAID_CLIENT_ID`
   - `PLAID_SECRET`
   - `PLAID_TOKEN_ENCRYPTION_KEY`

   **Note:** `DB_HOST`, `DB_PORT`, `DB_NAME`, `CONSENT_SSE_ENABLED`, and `SYNC_REMOTE_ENABLED` are set as Cloud Run env vars (not secrets). **Do not use `DATABASE_URL`** — migrations and scripts use DB_* only (strict parity). Delete `DATABASE_URL` from Secret Manager if present.
   Plaid webhook and callback settings are runtime env vars, not dashboard secrets:
   `PLAID_ENV`, `PLAID_CLIENT_NAME`, `PLAID_COUNTRY_CODES`, `PLAID_WEBHOOK_URL`, `PLAID_REDIRECT_PATH`, `PLAID_TX_HISTORY_DAYS`.
   UAT and production use the live/shared Plaid credential set; local development stays on sandbox-only credentials.

4. **Configure production logical backup infrastructure** (GCP)

   Provision the bucket + service accounts + Cloud Run Job + Cloud Scheduler:

   ```bash
   PROJECT_ID=hushh-pda REGION=us-central1 bash deploy/backup/setup_prod_logical_backup.sh
   ```

   The setup script enforces bucket hardening (UBLA + PAP), lifecycle delete at 14 days, and soft-delete disabled for cost control.

   If the currently deployed backend image does not yet include `scripts/ops/supabase_logical_backup.py`,
   pass an explicit image override:

   ```bash
   PROJECT_ID=hushh-pda REGION=us-central1 \
   BACKUP_JOB_IMAGE=gcr.io/hushh-pda/consent-protocol:backup-job-YYYYMMDD-HHMMSS \
   bash deploy/backup/setup_prod_logical_backup.sh
   ```

   Validate backup freshness policy locally (same gate used by production deploy workflow):

   ```bash
   python3 scripts/ops/logical_backup_freshness_check.py \
     --project-id hushh-pda \
     --bucket hushh-pda-prod-db-backups \
     --prefix prod/supabase-logical \
     --max-age-hours 30 \
     --report-path /tmp/prod-backup-posture-report.json
   ```

   This checker requires ADC-capable credentials (`gcloud auth application-default login`) or a service account credential source.

---

## 🔧 Cloud Build Configuration

### Backend (`backend.cloudbuild.yaml`)

Deploys Python FastAPI backend to Cloud Run:

- Builds Docker image from `consent-protocol/Dockerfile`
- Pushes to Google Container Registry
- Deploys to `consent-protocol` service
- Uses DB host/port env wiring (optionally supports Cloud SQL Unix socket when configured)
- Injects secrets from Secret Manager
- Sets `ENVIRONMENT=production` and `GOOGLE_GENAI_USE_VERTEXAI=True` (Vertex AI for Gemini)

### Frontend (`frontend.cloudbuild.yaml`)

Deploys Next.js frontend to Cloud Run:

- Builds Docker image from `hushh-webapp/Dockerfile`
- Bakes environment variables into static build
- Pushes to Google Container Registry
- Deploys to `hushh-webapp` service
- Serves via nginx

---

## 🔄 CI/CD Setup (GitHub/GitLab)

### GitHub Actions: Deploy workflows (production + UAT)

The repo includes:

- [.github/workflows/deploy-production.yml](../.github/workflows/deploy-production.yml): manual production deploy (`workflow_dispatch`).
- [.github/workflows/deploy-uat.yml](../.github/workflows/deploy-uat.yml): auto deploy from successful `main` CI and manual dispatch.

Manual dispatch now supports `scope`:

- `all` (default): deploy backend then frontend in one run/approval
- `backend`: deploy backend only
- `frontend`: deploy frontend only

**For seamless deployment:**

1. **GitHub secret:** add `GCP_SA_KEY` (and optionally `GCP_SA_KEY_UAT`) with Cloud Build + Cloud Run + Secret Manager permissions.
2. **Branch flow:** merge to `main` for UAT rollout; use manual dispatch for production rollout from a green `main` SHA.
3. **Approval policy:** configure environment reviewers in GitHub Environments (`production`, `uat`) rather than repo code.

### CI Security Gates

- `.github/workflows/ci.yml` runs a two-part secret gate:
  - `gitleaks` over the event commit range
  - GitHub secret-scanning + Dependabot parity via authenticated API reads
- Set a repo secret like `GH_SECURITY_ALERTS_TOKEN` for CI so the workflow can read GitHub security alerts with the same fidelity as local `gh`-authenticated checks.
- Native parity checks are optional in baseline CI and enabled for native release lanes.

### Option 1: Cloud Build Triggers (Recommended)

1. **Create Backend Trigger**

   ```bash
   gcloud builds triggers create github \
     --name=deploy-backend \
     --repo-name=hushh-research \
     --repo-owner=YOUR_ORG \
     --branch-pattern=^main$ \
     --build-config=deploy/backend.cloudbuild.yaml
   ```

2. **Create Frontend Trigger**
   ```bash
   gcloud builds triggers create github \
     --name=deploy-frontend \
     --repo-name=hushh-research \
     --repo-owner=YOUR_ORG \
     --branch-pattern=^main$ \
     --build-config=deploy/frontend.cloudbuild.yaml
   ```

### Option 2: Manual Deployment

```bash
# Deploy backend
gcloud builds submit --config=deploy/backend.cloudbuild.yaml

# Deploy frontend (uses BACKEND_URL secret)
gcloud builds submit --config=deploy/frontend.cloudbuild.yaml
```

---

## 🔐 Secrets Management

All required secrets must exist in Google Cloud Secret Manager before deployment. Run the parity audit script, then create any missing secrets manually.

**Backend (10 baseline secrets):** `SECRET_KEY`, `VAULT_ENCRYPTION_KEY`, `GOOGLE_API_KEY`, `FIREBASE_SERVICE_ACCOUNT_JSON`, `FIREBASE_AUTH_SERVICE_ACCOUNT_JSON`, `FRONTEND_URL`, `DB_USER`, `DB_PASSWORD`, `APP_REVIEW_MODE`, `REVIEWER_UID`
**Backend market-data secrets when Kai market home is enabled (2):** `FINNHUB_API_KEY`, `PMP_API_KEY`
**Backend Plaid secrets when brokerage is enabled (3):** `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_TOKEN_ENCRYPTION_KEY`

**Note:** 
- `DB_HOST`, `DB_PORT`, `DB_NAME`, `CONSENT_SSE_ENABLED`, and `SYNC_REMOTE_ENABLED` are set as Cloud Run env vars (not secrets) in `backend.cloudbuild.yaml`
- Plaid Cloud Run env remains env-var based: `PLAID_ENV`, `PLAID_CLIENT_NAME`, `PLAID_COUNTRY_CODES`, `PLAID_WEBHOOK_URL`, `PLAID_REDIRECT_PATH`, `PLAID_TX_HISTORY_DAYS`
- Migrations use DB_* only (no DATABASE_URL). See docs/reference/operations/env-and-secrets.md.
- **Action required:** Create `DB_USER` and `DB_PASSWORD` secrets in Secret Manager if they don't exist:
  ```bash
  echo "your-db-username" | gcloud secrets create DB_USER --data-file=-
  echo "your-db-password" | gcloud secrets create DB_PASSWORD --data-file=-
  ```

**Frontend build-time (16 centrally-managed values):**
- `BACKEND_URL`
- `NEXT_PUBLIC_FIREBASE_API_KEY`
- `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`
- `NEXT_PUBLIC_FIREBASE_PROJECT_ID`
- `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`
- `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`
- `NEXT_PUBLIC_FIREBASE_APP_ID`
- `NEXT_PUBLIC_FIREBASE_VAPID_KEY` (web push / FCM)
- `NEXT_PUBLIC_AUTH_FIREBASE_API_KEY`
- `NEXT_PUBLIC_AUTH_FIREBASE_AUTH_DOMAIN`
- `NEXT_PUBLIC_AUTH_FIREBASE_PROJECT_ID`
- `NEXT_PUBLIC_AUTH_FIREBASE_APP_ID`
- `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID_STAGING`
- `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID_PRODUCTION`
- `NEXT_PUBLIC_GTM_ID_STAGING`
- `NEXT_PUBLIC_GTM_ID_PRODUCTION`

These Firebase values are public client config, but are still centrally injected from Secret Manager to avoid hardcoded deploy YAML values.

**Frontend runtime (server-only Next.js API handlers):**
- `FIREBASE_SERVICE_ACCOUNT_JSON`
- `FIREBASE_AUTH_SERVICE_ACCOUNT_JSON` (required for auth-split setups, e.g., UAT web using prod Firebase Auth)

See [docs/reference/operations/env-and-secrets.md](../docs/reference/operations/env-and-secrets.md) for full reference.

### Mobile Firebase Artifacts (Regulated)

- Do not commit production `GoogleService-Info.plist` or `google-services.json`.
- Store production mobile Firebase artifacts in Secret Manager:
  - `IOS_GOOGLESERVICE_INFO_PLIST_B64`
  - `ANDROID_GOOGLE_SERVICES_JSON_B64`
- Store local/release signing assets in Secret Manager too:
  - `APPLE_TEAM_ID`
  - `IOS_DEV_CERT_P12_B64`
  - `IOS_DEV_CERT_PASSWORD`
  - `IOS_DEV_PROFILE_B64`
  - `IOS_DIST_CERT_P12_B64`
  - `IOS_DIST_CERT_PASSWORD`
  - `IOS_APPSTORE_PROFILE_B64`
  - `APPSTORE_CONNECT_API_KEY_P8_B64`
  - `APPSTORE_CONNECT_KEY_ID`
  - `APPSTORE_CONNECT_ISSUER_ID`
  - `ANDROID_RELEASE_KEYSTORE_B64`
  - `ANDROID_RELEASE_KEYSTORE_PASSWORD`
  - `ANDROID_RELEASE_KEY_ALIAS`
  - `ANDROID_RELEASE_KEY_PASSWORD`
- Developers should treat the frontend runtime profile env files as the local source of truth.
- `./bin/hushh bootstrap` hydrates those native values into the local profile env files and materializes the active native sidecar under `hushh-webapp/.env.local.d/`.
- Use `cd hushh-webapp && npm run sync:mobile-firebase` to refresh the active profile env with the latest Firebase app artifacts when needed.
- Or fetch latest artifacts directly from Firebase into the local cache:
  ```bash
  cd hushh-webapp
  npm run sync:mobile-firebase
  ```
- Native build wrappers apply the generated sidecar for the build and then restore the tracked templates.
- If a developer already has real local plist/json files in the native paths or the old `.local-secrets` cache, the first sidecar materialization seeds the active profile instead of overwriting that local state.
- Release CI still injects both real artifacts into the ephemeral workspace before native build/sign.
- Run `npm run verify:mobile-firebase` with `REQUIRE_PROD_FIREBASE_ARTIFACTS=true` in release jobs to fail fast if templates were not replaced.

### Local iOS Signing (Shared Team Bootstrap)

- Do not pass around `.p12`, `.mobileprovision`, or App Store Connect API keys manually.
- Store Apple signing assets in Secret Manager and hydrate them through the active frontend runtime profile:
  ```bash
  ./bin/hushh bootstrap
  ```
- The active sidecar lives under `hushh-webapp/.env.local.d/ios/` and local iOS runs install signing material into the keychain/profile store on demand.
- Android release signing follows the same model via `hushh-webapp/.env.local.d/android/`.
- Use `cd hushh-webapp && npm run cleanup:ios-signing` to remove the local iOS sidecar and keychain artifacts when needed.

### Observability Provisioning (Automated)

Use the idempotent setup script to provision observability infra in GCP:

```bash
bash deploy/observability/setup_gcp_observability.sh
```

Optional email notification channel wiring:

```bash
OBS_ALERT_EMAIL=you@example.com bash deploy/observability/setup_gcp_observability.sh
```

### Production DB Governance Helpers

```bash
# Provision logical backup infra (idempotent)
bash deploy/backup/setup_prod_logical_backup.sh

# Execute logical backup job manually (optional pre-deploy trigger)
gcloud run jobs execute prod-supabase-logical-backup \
  --project hushh-pda \
  --region us-central1 \
  --wait

# Read-only logical backup freshness gate
python3 scripts/ops/logical_backup_freshness_check.py \
  --project-id hushh-pda \
  --bucket hushh-pda-prod-db-backups \
  --prefix prod/supabase-logical \
  --max-age-hours 30 \
  --report-path /tmp/prod-backup-posture-report.json

# Read-only migration governance + DB drift checks
python3 scripts/ops/db_migration_release_guard.py \
  --report-path /tmp/db-migration-guard-report.json

# Latest-integrated UAT schema contract gate
python3 scripts/ops/db_migration_release_guard.py \
  --contract-file consent-protocol/db/schema_contract/uat_integrated_schema.json \
  --report-path /tmp/uat-db-migration-guard-report.json

# Generate audit manifest for a production release
python3 scripts/ops/generate_migration_release_manifest.py \
  --output /tmp/prod-migration-release-manifest.json \
  --environment production
```

### Verify Secrets

```bash
python3 scripts/ops/verify-env-secrets-parity.py \
  --project hushh-pda \
  --region us-central1 \
  --backend-service consent-protocol \
  --frontend-service hushh-webapp
```

### Create Secret

```bash
echo "your-secret-value" | gcloud secrets create SECRET_NAME --data-file=-
```

### Update Secret

```bash
echo "new-value" | gcloud secrets versions add SECRET_NAME --data-file=-
```

### View Secret

```bash
gcloud secrets versions access latest --secret=SECRET_NAME
```

---

## 🌐 Update CORS

After deploying frontend, update backend's CORS:

```bash
# Get frontend URL
FRONTEND_URL=$(gcloud run services describe hushh-webapp --region=us-central1 --format="value(status.url)")

# Update backend
gcloud run services update consent-protocol \
  --region=us-central1 \
  --update-env-vars=FRONTEND_URL=$FRONTEND_URL
```

---

## 🧪 Verification

### Backend

```bash
# Health check
curl https://consent-protocol-1006304528804.us-central1.run.app/health

# Swagger docs
open https://consent-protocol-1006304528804.us-central1.run.app/docs
```

### Frontend

```bash
# Get URL
gcloud run services describe hushh-webapp --region=us-central1 --format="value(status.url)"

# Health check
curl $(gcloud run services describe hushh-webapp --region=us-central1 --format="value(status.url)")/health
```

---

## 📊 Monitoring

### View Logs

```bash
# Backend
gcloud run services logs read consent-protocol --region=us-central1 --limit=50

# Frontend
gcloud run services logs read hushh-webapp --region=us-central1 --limit=50
```

### View Services

```bash
gcloud run services list --region=us-central1
```

---

## 🔄 Rollback

```bash
# List revisions
gcloud run revisions list --service=consent-protocol --region=us-central1

# Rollback
gcloud run services update-traffic consent-protocol \
  --region=us-central1 \
  --to-revisions=REVISION_NAME=100
```

---

## 📁 File Structure

```
deploy/
├── backend.cloudbuild.yaml      # Backend Cloud Build config
├── frontend.cloudbuild.yaml     # Frontend Cloud Build config
├── backup/setup_prod_logical_backup.sh  # Logical backup infra bootstrap
├── ../scripts/ops/verify-env-secrets-parity.py  # Secrets/deploy parity audit utility
├── .env.backend.example         # Backend env vars template
├── .env.frontend.example        # Frontend env vars template
└── README.md                    # This file
```

---

## 🔧 Troubleshooting

### Build Fails

```bash
# View build logs
gcloud builds list --limit=5
gcloud builds log BUILD_ID
```

### Service Not Accessible

```bash
# Check service status
gcloud run services describe SERVICE_NAME --region=us-central1

# Check logs
gcloud run services logs read SERVICE_NAME --region=us-central1 --limit=20
```

### CORS Errors

```bash
# Verify FRONTEND_URL is set
gcloud run services describe consent-protocol --region=us-central1 --format="value(spec.template.spec.containers[0].env)"
```

---

**Last Updated**: 2026-01-09
**Version**: 2.1 (Verified Cloud Build with yfinance fix)
