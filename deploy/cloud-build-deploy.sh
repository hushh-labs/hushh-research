#!/usr/bin/env bash
#
# GCP-native ON-DEMAND deploy orchestrator for hushh-research.
# Mirrors the mechanics of .github/workflows/deploy-uat.yml and
# deploy-production.yml, but runs entirely on GCP Cloud Build with NO GitHub
# Actions runner and NO long-lived service-account key.
#
# Auth: impersonates the SAME service account the GitHub workflow uses
#   (UAT: github-actions-uat-deployer@hushh-pda-uat).
#   The caller must hold roles/iam.serviceAccountTokenCreator on that SA.
#   The org enforces constraints/cloudbuild.useBuildServiceAccount, so a plain
#   user `gcloud builds submit` is denied — impersonation is the canonical path.
#
# ON-DEMAND ONLY: this is invoked deliberately by a human/operator. It is NOT
#   wired to push triggers. UAT/prod never auto-deploy on commit.
#
# Usage:
#   deploy/cloud-build-deploy.sh --env uat   [--sha <git-sha>] [--scope all|backend|frontend] [--skip-migrations]
#   deploy/cloud-build-deploy.sh --env prod  --sha <git-sha> --confirm-production "deploy production"
#
set -euo pipefail

# ----- defaults -----
ENV=""
SHA=""
SCOPE="all"
SKIP_MIGRATIONS="false"
CONFIRM_PRODUCTION=""
NO_IMPERSONATE="false"
REGION="us-central1"
BACKEND_SERVICE="consent-protocol"
FRONTEND_SERVICE="hushh-webapp"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) ENV="$2"; shift 2;;
    --sha) SHA="$2"; shift 2;;
    --scope) SCOPE="$2"; shift 2;;
    --skip-migrations) SKIP_MIGRATIONS="true"; shift;;
    --no-impersonate) NO_IMPERSONATE="true"; shift;;
    --confirm-production) CONFIRM_PRODUCTION="$2"; shift 2;;
    *) echo "Unknown arg: $1" >&2; exit 2;;
  esac
done

# ----- env-specific config -----
case "$ENV" in
  uat)
    PROJECT="hushh-pda-uat"
    DEPLOY_SA="github-actions-uat-deployer@hushh-pda-uat.iam.gserviceaccount.com"
    APP_FRONTEND_ORIGIN="https://uat.kai.hushh.ai"
    CLOUDSQL_INSTANCE="hushh-pda-uat:us-central1:hushh-uat-pg"
    APP_ENV="uat"
    DEPLOY_SOURCE="deploy-uat"
    ;;
  prod|production)
    ENV="prod"
    PROJECT="hushh-pda"
    DEPLOY_SA="${PROD_DEPLOY_SA:-github-actions-deployer@hushh-pda.iam.gserviceaccount.com}"
    APP_FRONTEND_ORIGIN="https://kai.hushh.ai"
    CLOUDSQL_INSTANCE="${PROD_CLOUDSQL_INSTANCE:-hushh-pda:us-central1:hushh-pg}"
    APP_ENV="production"
    DEPLOY_SOURCE="deploy-production"
    if [[ "$CONFIRM_PRODUCTION" != "deploy production" ]]; then
      echo "REFUSING prod deploy: pass --confirm-production \"deploy production\"." >&2
      exit 1
    fi
    ;;
  *)
    echo "Must pass --env uat|prod" >&2; exit 2;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ----- resolve + gate SHA -----
if [[ -z "$SHA" ]]; then
  git fetch --no-tags origin main
  SHA="$(git rev-parse origin/main)"
fi
echo "==> Deploying $ENV from SHA $SHA (scope=$SCOPE)"
bash scripts/ci/require-deploy-sha-on-main.sh "$SHA" || {
  echo "SHA gate failed — refusing deploy." >&2; exit 1; }

if [[ "$NO_IMPERSONATE" == "true" ]]; then
  IMPERSONATE=()
else
  IMPERSONATE=(--impersonate-service-account="$DEPLOY_SA")
fi
IMAGE_TAG="${ENV}-${SHA}"
RUN_ID="manual-ondemand-$(date +%Y%m%d%H%M%S)"

# ----- python runtime for ops scripts -----
PY="$REPO_ROOT/consent-protocol/.venv/bin/python"
if [[ ! -x "$PY" ]]; then
  echo "==> Creating consent-protocol venv"
  (cd consent-protocol && uv venv --python 3.13 .venv && \
     uv pip install -p .venv/bin/python -r requirements.txt >/dev/null)
fi

# ----- 1. secret sync -----
echo "==> Syncing runtime secrets"
"$PY" scripts/ops/sync_backend_runtime_secrets.py \
  --project "$PROJECT" --environment "$ENV" \
  --app-frontend-origin "$APP_FRONTEND_ORIGIN" \
  --db-host cloudsql-socket --db-port 5432 --db-name postgres \
  --db-unix-socket "/cloudsql/$CLOUDSQL_INSTANCE" \
  --cloudsql-instance-connection-name "$CLOUDSQL_INSTANCE" \
  --consent-sse-enabled true --sync-remote-enabled false \
  --developer-api-enabled true --remote-mcp-enabled true \
  --cors-allowed-origins "$APP_FRONTEND_ORIGIN" \
  --obs-data-stale-ratio-threshold 0.25 \
  --plaid-env production --plaid-client-name "Hushh Kai" \
  --plaid-country-codes US \
  --plaid-webhook-url "$APP_FRONTEND_ORIGIN/api/kai/plaid/webhook" \
  --plaid-redirect-path "/kai/plaid/oauth/return" --plaid-tx-history-days 730 \
  > "/tmp/${ENV}-backend-secret-sync.json"
"$PY" scripts/ops/sync_frontend_runtime_secrets.py \
  --project "$PROJECT" --environment "$ENV" \
  > "/tmp/${ENV}-frontend-secret-sync.json"

# ----- 2. db migrations + predeploy schema gate (backend only) -----
if [[ "$SCOPE" != "frontend" && "$SKIP_MIGRATIONS" != "true" ]]; then
  echo "==> Running DB migrations + predeploy schema gate"
  cloud-sql-proxy --address 127.0.0.1 --port 6543 "$CLOUDSQL_INSTANCE" \
    >"/tmp/${ENV}-cloud-sql-proxy.log" 2>&1 &
  PROXY_PID=$!
  trap 'kill "$PROXY_PID" >/dev/null 2>&1 || true' EXIT
  for _ in $(seq 1 40); do nc -z 127.0.0.1 6543 && break; sleep 0.25; done

  DBU="$(gcloud secrets versions access latest --secret=DB_USER --project="$PROJECT")"
  DBP="$(gcloud secrets versions access latest --secret=DB_PASSWORD --project="$PROJECT")"
  export DB_HOST=127.0.0.1 DB_PORT=6543 DB_NAME=postgres DB_USER="$DBU" DB_PASSWORD="$DBP"
  (cd "$REPO_ROOT/consent-protocol" && "$PY" db/migrate.py --release)
  "$PY" scripts/ops/db_migration_release_guard.py \
    --contract-file "consent-protocol/db/contracts/${ENV}_integrated_schema.json" \
    --report-path "/tmp/${ENV}-db-guard-predeploy.json"
  kill "$PROXY_PID" >/dev/null 2>&1 || true
  trap - EXIT
fi

# ----- 3. build + deploy backend (no-traffic) -----
if [[ "$SCOPE" == "all" || "$SCOPE" == "backend" ]]; then
  echo "==> Building + deploying backend (no-traffic revision)"
  BSUBS="_BACKEND_SERVICE=${BACKEND_SERVICE}##_REGION=${REGION}##_CLOUDSQL_INSTANCES=${CLOUDSQL_INSTANCE}"
  BSUBS="${BSUBS}##_PLAID_CLIENT_ID_SECRET=PLAID_CLIENT_ID##_PLAID_SECRET_SECRET=PLAID_SECRET##_PLAID_ACCESS_TOKEN_KEY_SECRET=PLAID_ACCESS_TOKEN_KEY"
  BSUBS="${BSUBS}##_FINNHUB_API_KEY_SECRET=FINNHUB_API_KEY##_PMP_API_KEY_SECRET=PMP_API_KEY##_NEWSAPI_KEY_SECRET=NEWSAPI_KEY"
  BSUBS="${BSUBS}##_GMAIL_OAUTH_CLIENT_ID_SECRET=GMAIL_OAUTH_CLIENT_ID##_GMAIL_OAUTH_CLIENT_SECRET_SECRET=GMAIL_OAUTH_CLIENT_SECRET##_GMAIL_OAUTH_REDIRECT_URI_SECRET=GMAIL_OAUTH_REDIRECT_URI##_GMAIL_OAUTH_TOKEN_KEY_SECRET=GMAIL_OAUTH_TOKEN_KEY"
  BSUBS="${BSUBS}##_OPENAI_API_KEY_SECRET=OPENAI_API_KEY##_VOICE_RUNTIME_CONFIG_JSON_SECRET=VOICE_RUNTIME_CONFIG_JSON##_HUSHH_DEVELOPER_TOKEN_SECRET=HUSHH_DEVELOPER_TOKEN"
  BSUBS="${BSUBS}##_HUSHH_UAT_PHONE_TEST_NUMBERS_SECRET=HUSHH_UAT_PHONE_TEST_NUMBERS##_HUSHH_UAT_PHONE_TEST_CODE_SECRET=HUSHH_UAT_PHONE_TEST_CODE##_REVIEWER_UID_SECRET=REVIEWER_UID##_REVIEWER_VAULT_PASSPHRASE_SECRET=REVIEWER_VAULT_PASSPHRASE"
  BSUBS="${BSUBS}##_RIA_INTELLIGENCE_VERIFY_BASE_URL_SECRET=RIA_INTELLIGENCE_VERIFY_BASE_URL##_ONE_EMAIL_WATCH_RENEW_TOKEN_SECRET=ONE_EMAIL_WATCH_RENEW_TOKEN##_ONE_EMAIL_ADDRESS=one@hushh.ai##_ONE_EMAIL_DELEGATED_USER=one@hushh.ai"
  BSUBS="${BSUBS}##_ONE_EMAIL_KYC_DEFAULT_SCOPE=attr.identity.*##_ONE_EMAIL_KYC_STRICT_CLIENT_ZK_ENABLED=true##_APP_REVIEW_MODE=true"
  BSUBS="${BSUBS}##_CLOUD_RUN_NO_TRAFFIC=true##_IMAGE_TAG=${IMAGE_TAG}##_DEPLOY_ENV=${ENV}##_DEPLOY_SOURCE=${DEPLOY_SOURCE}##_DEPLOY_SHA=${SHA}##_GITHUB_RUN_ID=${RUN_ID}"
  gcloud builds submit --project="$PROJECT" "${IMPERSONATE[@]}" \
    --config=deploy/backend.cloudbuild.yaml "--substitutions=^##^${BSUBS}"
fi

# ----- 4. build + deploy frontend (no-traffic) -----
if [[ "$SCOPE" == "all" || "$SCOPE" == "frontend" ]]; then
  echo "==> Building + deploying frontend (no-traffic revision)"
  FSUBS="_FRONTEND_SERVICE=${FRONTEND_SERVICE}##_REGION=${REGION}##_APP_ENV=${APP_ENV}##_CLOUD_RUN_NO_TRAFFIC=true##_IMAGE_TAG=${IMAGE_TAG}##_DEPLOY_ENV=${ENV}##_DEPLOY_SOURCE=${DEPLOY_SOURCE}##_DEPLOY_SHA=${SHA}##_GITHUB_RUN_ID=${RUN_ID}"
  gcloud builds submit --project="$PROJECT" "${IMPERSONATE[@]}" \
    --config=deploy/frontend.cloudbuild.yaml "--substitutions=^##^${FSUBS}"
fi

# ----- 5. promote traffic to 100% -----
echo "==> Promoting candidate revisions to 100% traffic"
if [[ "$SCOPE" == "all" || "$SCOPE" == "backend" ]]; then
  BE_REV="$(gcloud run services describe "$BACKEND_SERVICE" --project="$PROJECT" --region="$REGION" "${IMPERSONATE[@]}" --format='value(status.latestCreatedRevisionName)')"
  gcloud run services update-traffic "$BACKEND_SERVICE" --project="$PROJECT" --region="$REGION" "${IMPERSONATE[@]}" --to-revisions="${BE_REV}=100"
fi
if [[ "$SCOPE" == "all" || "$SCOPE" == "frontend" ]]; then
  FE_REV="$(gcloud run services describe "$FRONTEND_SERVICE" --project="$PROJECT" --region="$REGION" "${IMPERSONATE[@]}" --format='value(status.latestCreatedRevisionName)')"
  gcloud run services update-traffic "$FRONTEND_SERVICE" --project="$PROJECT" --region="$REGION" "${IMPERSONATE[@]}" --to-revisions="${FE_REV}=100"
fi

# ----- 6. verify -----
echo "==> Verifying live deployment"
BE_URL="$(gcloud run services describe "$BACKEND_SERVICE" --project="$PROJECT" --region="$REGION" "${IMPERSONATE[@]}" --format='value(status.url)')"
echo "backend health: $(curl -s -o /dev/null -w '%{http_code}' "$BE_URL/health")"
echo "frontend ($APP_FRONTEND_ORIGIN): $(curl -s -o /dev/null -w '%{http_code}' "$APP_FRONTEND_ORIGIN")"
echo "==> Deploy complete: $ENV @ $SHA"
