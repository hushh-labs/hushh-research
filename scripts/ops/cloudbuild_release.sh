#!/usr/bin/env bash
# Cloud Build fallback release driver.
#
# WHY THIS EXISTS: deploy-uat.yml and deploy-production.yml already deploy via
# `gcloud builds submit --config deploy/{backend,frontend}.cloudbuild.yaml`. What
# only exists inside GitHub Actions is the ORCHESTRATION around those two calls:
# scope resolution, secret sync, migrations, no-traffic promotion, provenance and
# parity verification, and rollback. When GitHub's runners are unavailable that
# orchestration is unreachable and releases stop, even though Cloud Build itself
# is healthy. This script reproduces that ordering from a laptop using the same
# configs, the same substitutions, and the same verification scripts.
#
# IT IS A FALLBACK, NOT A REPLACEMENT. Revisions are labelled
# _DEPLOY_SOURCE=cloudbuild-fallback-<env> rather than deploy-uat/deploy-production,
# so a fallback release is visibly distinguishable in `gcloud run revisions
# describe` and in provenance reports. Do not relabel it to impersonate the
# governed lane. Re-run the governed workflow once runners recover.
#
# AUTHORITY: hushh-pda-uat carries a deliberate IAM deny policy
# ("uat-deploy-authority-lock") that blocks cloudbuild.builds.create and
# run.services.* for every principal except the CI deployer service account.
# This script therefore CANNOT deploy UAT from a human account, and it checks for
# that up front rather than failing halfway through a release. Production
# (hushh-pda) and dev (hushh-pda-dev) have no such lock.
#
# Usage:
#   scripts/ops/cloudbuild_release.sh --env production --sha <sha> [--scope all|backend|frontend]
#
# Flags:
#   --env <production|uat|dev>  Target lane (required)
#   --sha <sha>                 Exact SHA to deploy (default: origin/main)
#   --scope <all|backend|frontend|auto>  Deploy scope (default: auto)
#   --skip-ci-check             Do not require a green GitHub check on the SHA.
#                               Intended for exactly the outage this script
#                               exists for; it is still refused unless the SHA is
#                               a real ancestor of origin/main.
#   --skip-migrations           Skip the DB migration step (backend only)
#   --dry-run                   Print the plan and the exact gcloud commands, deploy nothing
#
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

TARGET_ENV=""
DEPLOY_SHA=""
REQUESTED_SCOPE="auto"
SKIP_CI_CHECK=0
SKIP_MIGRATIONS=0
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) TARGET_ENV="$2"; shift 2 ;;
    --sha) DEPLOY_SHA="$2"; shift 2 ;;
    --scope) REQUESTED_SCOPE="$2"; shift 2 ;;
    --skip-ci-check) SKIP_CI_CHECK=1; shift ;;
    --skip-migrations) SKIP_MIGRATIONS=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '1,40p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[warn] %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m[fail] %s\033[0m\n' "$*" >&2; exit 1; }
run()  {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '\033[0;90m[dry-run] %s\033[0m\n' "$*"
  else
    "$@"
  fi
}

# ---------------------------------------------------------------- lane config
# Mirrors the env: blocks of deploy-uat.yml and deploy-production.yml.
case "$TARGET_ENV" in
  production)
    GCP_PROJECT_ID="hushh-pda"
    RUNTIME_SERVICE_ACCOUNT="consent-protocol-runtime@hushh-pda.iam.gserviceaccount.com"
    APP_FRONTEND_ORIGIN="https://one.hushh.ai"
    CONSENT_API_PUBLIC_ORIGIN="https://api.hushh.ai"
    CLOUDSQL_INSTANCE="hushh-pda:us-central1:hushh-vault-db"
    DB_UNIX_SOCKET="/cloudsql/hushh-pda:us-central1:hushh-vault-db"
    DB_NAME="hushh_vault"
    PROXY_PORT="6544"
    ;;
  uat)
    GCP_PROJECT_ID="hushh-pda-uat"
    RUNTIME_SERVICE_ACCOUNT="consent-protocol-runtime@hushh-pda-uat.iam.gserviceaccount.com"
    APP_FRONTEND_ORIGIN="https://uat.one.hushh.ai"
    CONSENT_API_PUBLIC_ORIGIN="https://api.uat.hushh.ai"
    CLOUDSQL_INSTANCE="hushh-pda-uat:us-central1:hushh-uat-pg"
    DB_UNIX_SOCKET="/cloudsql/hushh-pda-uat:us-central1:hushh-uat-pg"
    DB_NAME="postgres"
    PROXY_PORT="6543"
    ;;
  dev)
    GCP_PROJECT_ID="hushh-pda-dev"
    RUNTIME_SERVICE_ACCOUNT="consent-protocol-runtime@hushh-pda-dev.iam.gserviceaccount.com"
    APP_FRONTEND_ORIGIN="https://dev.one.hushh.ai"
    CONSENT_API_PUBLIC_ORIGIN="https://api.dev.hushh.ai"
    CLOUDSQL_INSTANCE=""
    DB_UNIX_SOCKET=""
    DB_NAME="postgres"
    PROXY_PORT="6545"
    ;;
  *)
    die "--env must be one of: production, uat, dev (got '${TARGET_ENV:-<empty>}')"
    ;;
esac

GCP_REGION="us-central1"
BACKEND_SERVICE="consent-protocol"
FRONTEND_SERVICE="hushh-webapp"
DEPLOY_SOURCE="cloudbuild-fallback-${TARGET_ENV}"
PROTOCOL_PYTHON="${REPO_ROOT}/consent-protocol/.venv/bin/python"
ARTIFACT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cloudbuild-release-XXXXXX")"

# A local driver has no github.run_id. Provenance only requires that the value
# on the revision matches what the verifier is told to expect, so a stable
# local identifier keeps the check meaningful and traceable.
RUN_ID="local-$(date +%Y%m%dT%H%M%S)"

# --------------------------------------------------------------- resolve SHA
log "Resolving deployment SHA"
git fetch --no-tags origin main >/dev/null 2>&1 || warn "Could not fetch origin/main"
if [[ -z "$DEPLOY_SHA" ]]; then
  DEPLOY_SHA="$(git rev-parse origin/main)"
fi
DEPLOY_SHA="$(git rev-parse "$DEPLOY_SHA")"
echo "Deploy SHA: $DEPLOY_SHA"

# The SHA must genuinely be on main. This guard is NOT relaxed by
# --skip-ci-check: shipping code that never landed on main is a different and
# worse failure than shipping code whose CI could not be scheduled.
if ! git merge-base --is-ancestor "$DEPLOY_SHA" origin/main; then
  die "$DEPLOY_SHA is not an ancestor of origin/main. Refusing to deploy."
fi

if [[ "$SKIP_CI_CHECK" -eq 1 ]]; then
  # --skip-ci-check waives the GitHub check, not verification itself. A local
  # gate report for this exact SHA has to stand in its place, otherwise the flag
  # would just be a way to deploy unverified code during an outage.
  GATE_REPORT="${HUSHH_GATE_REPORT_DIR:-${TMPDIR:-/tmp}}/hushh-ci-gate-${DEPLOY_SHA}.json"
  if [[ ! -f "$GATE_REPORT" ]]; then
    die "No local gate report for ${DEPLOY_SHA}.
--skip-ci-check replaces the GitHub check with a local run; it does not remove the
requirement to verify. Produce one first:

  git checkout ${DEPLOY_SHA} && scripts/ci/local-release-gate.sh

Expected report at: ${GATE_REPORT}"
  fi
  GATE_VERDICT="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["verdict"], d["complete"])' "$GATE_REPORT")"
  if [[ "$GATE_VERDICT" != "passed True" ]]; then
    die "Local gate report for ${DEPLOY_SHA} is '${GATE_VERDICT}' (need 'passed True').
A --fast or single-stage run cannot authorize a deploy. Re-run the full gate:
  scripts/ci/local-release-gate.sh"
  fi
  warn "GitHub check waived; standing on the local gate report at ${GATE_REPORT}."
else
  REQUIRED_BRANCH=main REQUIRE_CI_SUCCESS=1 \
  REQUIRED_CHECK_NAME="Main Post-Merge Smoke Gate" \
  GITHUB_REPOSITORY="hushh-labs/hushh-research" \
  GITHUB_TOKEN="${GITHUB_TOKEN:-$(gh auth token 2>/dev/null || true)}" \
    bash scripts/ci/require-deploy-sha-on-main.sh "$DEPLOY_SHA" \
    || die "SHA gate failed. If runners are queued rather than red, re-run with --skip-ci-check."
fi

# --------------------------------------------------- authority preflight
# Fail before mutating anything if this account cannot actually complete the
# release. On hushh-pda-uat the deny policy makes every role listing look
# sufficient while the real API call returns 403, so ask for effective
# permissions rather than trusting the IAM policy.
log "Checking deploy authority on ${GCP_PROJECT_ID}"
PERMS_JSON="$(curl -sS -X POST \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "Content-Type: application/json" \
  -d '{"permissions":["cloudbuild.builds.create","run.services.update","secretmanager.versions.access"]}' \
  "https://cloudresourcemanager.googleapis.com/v1/projects/${GCP_PROJECT_ID}:testIamPermissions")"

for perm in cloudbuild.builds.create run.services.update; do
  if ! grep -q "$perm" <<<"$PERMS_JSON"; then
    echo "$PERMS_JSON" >&2
    die "Missing '$perm' on ${GCP_PROJECT_ID}.
This is expected on hushh-pda-uat: the 'uat-deploy-authority-lock' deny policy
routes every UAT deploy through the CI service account by design. It is a working
control, not a misconfiguration -- do not remove it to unblock this.
Options: deploy the SHA to production/dev instead, or wait for GitHub runners and
re-run the governed deploy-uat workflow."
  fi
done
echo "Deploy authority confirmed."

run gcloud config set project "$GCP_PROJECT_ID" >/dev/null

# --------------------------------------------------- predeploy Cloud Run state
log "Capturing predeploy Cloud Run state"
describe_service() {
  gcloud run services describe "$1" --project="$GCP_PROJECT_ID" --region="$GCP_REGION" \
    --format="value($2)" 2>/dev/null || true
}
PRE_BACKEND_REVISION="$(describe_service "$BACKEND_SERVICE" 'status.traffic[0].revisionName')"
PRE_FRONTEND_REVISION="$(describe_service "$FRONTEND_SERVICE" 'status.traffic[0].revisionName')"
BACKEND_SERVICE_URL="$(describe_service "$BACKEND_SERVICE" 'status.url')"
FRONTEND_SERVICE_URL="$(describe_service "$FRONTEND_SERVICE" 'status.url')"

revision_sha() {
  [[ -z "$1" ]] && return 0
  gcloud run revisions describe "$1" --project="$GCP_PROJECT_ID" --region="$GCP_REGION" \
    --format='value(metadata.labels.deploy-sha)' 2>/dev/null || true
}
PRE_BACKEND_SHA="$(revision_sha "$PRE_BACKEND_REVISION")"
PRE_FRONTEND_SHA="$(revision_sha "$PRE_FRONTEND_REVISION")"

echo "Backend  serving: ${PRE_BACKEND_REVISION:-none} (sha ${PRE_BACKEND_SHA:-unknown})"
echo "Frontend serving: ${PRE_FRONTEND_REVISION:-none} (sha ${PRE_FRONTEND_SHA:-unknown})"

# ------------------------------------------------------------- resolve scope
log "Resolving deploy scope"
SCOPE_JSON="$(python3 scripts/ci/resolve-deploy-scope.py \
  --requested-scope "$REQUESTED_SCOPE" \
  --target-sha "$DEPLOY_SHA" \
  --backend-base-sha "$PRE_BACKEND_SHA" \
  --frontend-base-sha "$PRE_FRONTEND_SHA" \
  --json)"
echo "$SCOPE_JSON"
# json.dumps emits real booleans, so print() would yield Python's "True"/"False".
# Lowercase them into shell-comparable "true"/"false".
read_scope_flag() {
  python3 -c 'import json,sys; print(str(json.load(sys.stdin)[sys.argv[1]]).lower())' "$1" <<<"$SCOPE_JSON"
}
DEPLOY_BACKEND="$(read_scope_flag deploy_backend)"
DEPLOY_FRONTEND="$(read_scope_flag deploy_frontend)"
echo "Resolved scope -> backend=${DEPLOY_BACKEND} frontend=${DEPLOY_FRONTEND}"

if [[ "$DEPLOY_BACKEND" != "true" && "$DEPLOY_FRONTEND" != "true" ]]; then
  log "Nothing to deploy for this SHA. Exiting cleanly."
  exit 0
fi

# ------------------------------------------------------ python runtime
if [[ ! -x "$PROTOCOL_PYTHON" ]]; then
  log "Creating consent-protocol venv"
  run bash -c "cd '$REPO_ROOT/consent-protocol' && uv sync --frozen --group dev"
fi

# ------------------------------------------------------ sync runtime secrets
log "Syncing canonical hosted runtime secrets"
BACKEND_SECRET_ARGS=(
  --project "$GCP_PROJECT_ID"
  --environment "$([[ "$TARGET_ENV" == "production" ]] && echo production || echo "$TARGET_ENV")"
  --app-frontend-origin "$APP_FRONTEND_ORIGIN"
  --db-host "cloudsql-socket" --db-port "5432" --db-name "$DB_NAME"
  --db-unix-socket "$DB_UNIX_SOCKET"
  --cloudsql-instance-connection-name "$CLOUDSQL_INSTANCE"
  --sync-remote-enabled "false" --developer-api-enabled "true" --remote-mcp-enabled "true"
  --cors-allowed-origins "$APP_FRONTEND_ORIGIN"
  --obs-data-stale-ratio-threshold "0.25"
  --plaid-env "production" --plaid-client-name "Hushh Kai" --plaid-country-codes "US"
  --plaid-webhook-url "${APP_FRONTEND_ORIGIN}/api/kai/plaid/webhook"
  --plaid-redirect-path "/kai/plaid/oauth/return" --plaid-tx-history-days "730"
)
if [[ "$TARGET_ENV" == "production" ]]; then
  BACKEND_SECRET_ARGS+=(--consent-sse-enabled "false"
    --passkey-allowed-rp-ids "localhost,127.0.0.1,one.hushh.ai"
    --hushh-trusted-device-enabled "false")
else
  BACKEND_SECRET_ARGS+=(--consent-sse-enabled "true"
    --passkey-allowed-rp-ids "localhost,127.0.0.1,one.hushh.ai,uat.one.hushh.ai")
fi

run "$PROTOCOL_PYTHON" scripts/ops/sync_backend_runtime_secrets.py "${BACKEND_SECRET_ARGS[@]}" \
  > "${ARTIFACT_DIR}/runtime-secret-sync.json"
run "$PROTOCOL_PYTHON" scripts/ops/sync_frontend_runtime_secrets.py \
  --project "$GCP_PROJECT_ID" \
  --environment "$([[ "$TARGET_ENV" == "production" ]] && echo production || echo "$TARGET_ENV")" \
  > "${ARTIFACT_DIR}/frontend-runtime-secret-sync.json"

# ------------------------------------------------------------- migrations
if [[ "$DEPLOY_BACKEND" == "true" && "$SKIP_MIGRATIONS" -eq 0 && -n "$CLOUDSQL_INSTANCE" ]]; then
  log "Applying DB migrations through the Cloud SQL Auth Proxy"
  if ! command -v cloud-sql-proxy >/dev/null 2>&1; then
    die "cloud-sql-proxy is not installed. Install it with:
  curl -fsSL https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v2.18.3/cloud-sql-proxy.darwin.arm64 -o /usr/local/bin/cloud-sql-proxy && chmod +x /usr/local/bin/cloud-sql-proxy"
  fi

  if [[ "$DRY_RUN" -eq 0 ]]; then
    DB_USER="$(gcloud secrets versions access latest --secret=DB_USER --project="$GCP_PROJECT_ID")"
    DB_PASSWORD="$(gcloud secrets versions access latest --secret=DB_PASSWORD --project="$GCP_PROJECT_ID")"

    cloud-sql-proxy --address 127.0.0.1 --port "$PROXY_PORT" "$CLOUDSQL_INSTANCE" \
      > "${ARTIFACT_DIR}/cloud-sql-proxy.log" 2>&1 &
    PROXY_PID=$!
    trap 'kill "${PROXY_PID}" >/dev/null 2>&1 || true' EXIT

    python3 - "$PROXY_PORT" <<'PY'
import socket, sys, time
port = int(sys.argv[1])
deadline = time.time() + 20
while time.time() < deadline:
    with socket.socket() as sock:
        sock.settimeout(0.5)
        if sock.connect_ex(("127.0.0.1", port)) == 0:
            raise SystemExit(0)
    time.sleep(0.25)
raise SystemExit(f"Cloud SQL proxy did not bind 127.0.0.1:{port} in time")
PY

    export DB_HOST=127.0.0.1 DB_PORT="$PROXY_PORT" DB_NAME DB_USER DB_PASSWORD
    ( cd consent-protocol && "$PROTOCOL_PYTHON" db/migrate.py --release --migration-mode replay )
    "$PROTOCOL_PYTHON" scripts/ops/db_migration_release_guard.py \
      --report-path "${ARTIFACT_DIR}/db-migration-guard-predeploy.json"

    kill "$PROXY_PID" >/dev/null 2>&1 || true
    trap - EXIT
  else
    echo "[dry-run] would run cloud-sql-proxy + db/migrate.py --release against $CLOUDSQL_INSTANCE"
  fi
else
  warn "Skipping migrations (scope, --skip-migrations, or no Cloud SQL instance for this lane)."
fi

# --------------------------------------------------------------- deploy backend
# Substitutions are byte-for-byte the workflow's, except _DEPLOY_SOURCE (honest
# fallback label) and _GITHUB_RUN_ID (local run id). _CLOUD_RUN_NO_TRAFFIC=true
# is essential: it makes promotion an explicit, reversible step below.
if [[ "$DEPLOY_BACKEND" == "true" ]]; then
  log "Deploying backend via Cloud Build"
  SUBS="_BACKEND_SERVICE=${BACKEND_SERVICE}"
  SUBS="${SUBS}##_REGION=${GCP_REGION}"
  SUBS="${SUBS}##_CLOUDSQL_INSTANCES=${CLOUDSQL_INSTANCE}"
  SUBS="${SUBS}##_RUNTIME_SERVICE_ACCOUNT=${RUNTIME_SERVICE_ACCOUNT}"
  SUBS="${SUBS}##_CONSENT_API_PUBLIC_ORIGIN=${CONSENT_API_PUBLIC_ORIGIN}"
  SUBS="${SUBS}##_PLAID_CLIENT_ID_SECRET=PLAID_CLIENT_ID##_PLAID_SECRET_SECRET=PLAID_SECRET"
  SUBS="${SUBS}##_PLAID_ACCESS_TOKEN_KEY_SECRET=PLAID_ACCESS_TOKEN_KEY"
  SUBS="${SUBS}##_FINNHUB_API_KEY_SECRET=FINNHUB_API_KEY##_PMP_API_KEY_SECRET=PMP_API_KEY"
  SUBS="${SUBS}##_NEWSAPI_KEY_SECRET=NEWSAPI_KEY"
  SUBS="${SUBS}##_GMAIL_OAUTH_CLIENT_ID_SECRET=GMAIL_OAUTH_CLIENT_ID"
  SUBS="${SUBS}##_GMAIL_OAUTH_CLIENT_SECRET_SECRET=GMAIL_OAUTH_CLIENT_SECRET"
  SUBS="${SUBS}##_GMAIL_OAUTH_REDIRECT_URI_SECRET=GMAIL_OAUTH_REDIRECT_URI"
  SUBS="${SUBS}##_GMAIL_OAUTH_TOKEN_KEY_SECRET=GMAIL_OAUTH_TOKEN_KEY"
  SUBS="${SUBS}##_OPENAI_API_KEY_SECRET=OPENAI_API_KEY"
  SUBS="${SUBS}##_GOOGLE_MAPS_API_KEY_SECRET=GOOGLE_MAPS_API_KEY"
  SUBS="${SUBS}##_VOICE_RUNTIME_CONFIG_JSON_SECRET=VOICE_RUNTIME_CONFIG_JSON"
  SUBS="${SUBS}##_HUSHH_DEVELOPER_TOKEN_SECRET=HUSHH_DEVELOPER_TOKEN"
  SUBS="${SUBS}##_RIA_INTELLIGENCE_VERIFY_BASE_URL_SECRET=RIA_INTELLIGENCE_VERIFY_BASE_URL"
  SUBS="${SUBS}##_ONE_WALLET_CARD_ENABLED=true##_WALLET_PASS_PROVIDER=service"
  SUBS="${SUBS}##_WALLET_API_KEY_SECRET=WALLET_API_KEY"
  SUBS="${SUBS}##_KAI_ANALYZE_DURABLE_RUN_STORE=true"
  SUBS="${SUBS}##_CLOUD_RUN_NO_TRAFFIC=true"
  SUBS="${SUBS}##_IMAGE_TAG=${TARGET_ENV}-${DEPLOY_SHA}"
  SUBS="${SUBS}##_DEPLOY_ENV=${TARGET_ENV}##_DEPLOY_SOURCE=${DEPLOY_SOURCE}"
  SUBS="${SUBS}##_DEPLOY_SHA=${DEPLOY_SHA}##_GITHUB_RUN_ID=${RUN_ID}"

  if [[ "$TARGET_ENV" == "production" ]]; then
    SUBS="${SUBS}##_DB_POOL_MIN_SIZE=1##_DB_POOL_MAX_SIZE=4"
    SUBS="${SUBS}##_DB_SQLALCHEMY_POOL_SIZE=4##_DB_SQLALCHEMY_MAX_OVERFLOW=0"
    SUBS="${SUBS}##_CLOUD_RUN_MIN_INSTANCES=1##_CLOUD_RUN_MAX_INSTANCES=5"
    SUBS="${SUBS}##_HUSHH_PROD_PHONE_TEST_NUMBERS_SECRET=HUSHH_PROD_PHONE_TEST_NUMBERS"
    SUBS="${SUBS}##_HUSHH_PROD_PHONE_TEST_CODE_SECRET=HUSHH_PROD_PHONE_TEST_CODE"
    SUBS="${SUBS}##_HUSHH_PROD_PHONE_TEST_CHALLENGE_SECRET_SECRET=HUSHH_PROD_PHONE_TEST_CHALLENGE_SECRET"
    SUBS="${SUBS}##_HUSHH_PROD_PHONE_TEST_ENABLED=true"
  else
    # UAT runs a smaller pool and an app-review overlay; see deploy-uat.yml.
    SUBS="${SUBS}##_DB_POOL_MIN_SIZE=1##_DB_POOL_MAX_SIZE=3"
    SUBS="${SUBS}##_DB_SQLALCHEMY_POOL_SIZE=2##_DB_SQLALCHEMY_MAX_OVERFLOW=0"
    SUBS="${SUBS}##_CLOUD_RUN_MIN_INSTANCES=1##_CLOUD_RUN_MAX_INSTANCES=3"
    SUBS="${SUBS}##_APP_REVIEW_MODE=true"
    SUBS="${SUBS}##_HUSHH_UAT_PHONE_TEST_NUMBERS_SECRET=HUSHH_UAT_PHONE_TEST_NUMBERS"
    SUBS="${SUBS}##_HUSHH_UAT_PHONE_TEST_CODE_SECRET=HUSHH_UAT_PHONE_TEST_CODE"
    SUBS="${SUBS}##_REVIEWER_UID_SECRET=REVIEWER_UID"
    SUBS="${SUBS}##_REVIEWER_VAULT_PASSPHRASE_SECRET=REVIEWER_VAULT_PASSPHRASE"
  fi

  run gcloud builds submit \
    --project="$GCP_PROJECT_ID" \
    --config=deploy/backend.cloudbuild.yaml \
    "--substitutions=^##^${SUBS}"

  run bash scripts/ci/cloudrun-retention.sh "$BACKEND_SERVICE" "$GCP_REGION" 3 || true
fi

# -------------------------------------------------------------- deploy frontend
if [[ "$DEPLOY_FRONTEND" == "true" ]]; then
  log "Deploying frontend via Cloud Build"
  run gcloud builds submit \
    --project="$GCP_PROJECT_ID" \
    --config=deploy/frontend.cloudbuild.yaml \
    "--substitutions=_FRONTEND_SERVICE=${FRONTEND_SERVICE},_REGION=${GCP_REGION},_APP_ENV=${TARGET_ENV},_ONE_WALLET_CARD_ENABLED=true,_CLOUD_RUN_NO_TRAFFIC=true,_IMAGE_TAG=${TARGET_ENV}-${DEPLOY_SHA},_DEPLOY_ENV=${TARGET_ENV},_DEPLOY_SOURCE=${DEPLOY_SOURCE},_DEPLOY_SHA=${DEPLOY_SHA},_GITHUB_RUN_ID=${RUN_ID}"

  run bash scripts/ci/cloudrun-retention.sh "$FRONTEND_SERVICE" "$GCP_REGION" 10 || true
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  log "Dry run complete. Nothing was deployed."
  exit 0
fi

# ------------------------------------------------------- candidate + identity
log "Resolving candidate revisions"
CAND_BACKEND="$(describe_service "$BACKEND_SERVICE" 'status.latestCreatedRevisionName')"
CAND_FRONTEND="$(describe_service "$FRONTEND_SERVICE" 'status.latestCreatedRevisionName')"
echo "Backend candidate:  ${CAND_BACKEND:-n/a}"
echo "Frontend candidate: ${CAND_FRONTEND:-n/a}"

if [[ "$DEPLOY_BACKEND" == "true" ]]; then
  bash scripts/ci/assert-cloud-run-runtime-identity.sh \
    "$GCP_PROJECT_ID" "$GCP_REGION" "$CAND_BACKEND" "$RUNTIME_SERVICE_ACCOUNT" \
    || die "Backend candidate is not running as ${RUNTIME_SERVICE_ACCOUNT}. Not promoting."
fi

# ---------------------------------------------------------- promote traffic
# Everything above deployed with --no-traffic, so live traffic is still on the
# predeploy revisions until this point.
log "Promoting candidate revisions to traffic"
if [[ "$DEPLOY_BACKEND" == "true" ]]; then
  gcloud run services update-traffic "$BACKEND_SERVICE" \
    --project="$GCP_PROJECT_ID" --region="$GCP_REGION" \
    --to-revisions="${CAND_BACKEND}=100"
fi
if [[ "$DEPLOY_FRONTEND" == "true" ]]; then
  gcloud run services update-traffic "$FRONTEND_SERVICE" \
    --project="$GCP_PROJECT_ID" --region="$GCP_REGION" \
    --to-revisions="${CAND_FRONTEND}=100"
fi

# -------------------------------------------------------------- verification
RELEASE_FAILED=0
BACKEND_FAILED=0
FRONTEND_FAILED=0

log "Verifying deployment provenance"
if [[ "$DEPLOY_BACKEND" == "true" ]]; then
  "$PROTOCOL_PYTHON" scripts/ci/verify-cloudrun-revision-provenance.py \
    --project "$GCP_PROJECT_ID" --region "$GCP_REGION" --service "$BACKEND_SERVICE" \
    --expected-env "$TARGET_ENV" --expected-source "$DEPLOY_SOURCE" \
    --expected-sha "$DEPLOY_SHA" --expected-run-id "$RUN_ID" \
    --report-path "${ARTIFACT_DIR}/backend-provenance.json" \
    || { warn "Backend provenance failed"; BACKEND_FAILED=1; RELEASE_FAILED=1; }
fi
if [[ "$DEPLOY_FRONTEND" == "true" ]]; then
  "$PROTOCOL_PYTHON" scripts/ci/verify-cloudrun-revision-provenance.py \
    --project "$GCP_PROJECT_ID" --region "$GCP_REGION" --service "$FRONTEND_SERVICE" \
    --expected-env "$TARGET_ENV" --expected-source "$DEPLOY_SOURCE" \
    --expected-sha "$DEPLOY_SHA" --expected-run-id "$RUN_ID" \
    --report-path "${ARTIFACT_DIR}/frontend-provenance.json" \
    || { warn "Frontend provenance failed"; FRONTEND_FAILED=1; RELEASE_FAILED=1; }
fi

log "Verifying runtime env parity"
PARITY_ARGS=(--project "$GCP_PROJECT_ID" --region "$GCP_REGION"
  --backend-service "$BACKEND_SERVICE" --frontend-service "$FRONTEND_SERVICE"
  --require-plaid --require-market-data --require-gmail --require-voice
  --assert-runtime-env-contract
  --report-path "${ARTIFACT_DIR}/runtime-parity.json")
[[ "$TARGET_ENV" == "production" ]] && PARITY_ARGS+=(--require-connected-systems --require-prod-phone-test)
[[ "$TARGET_ENV" == "uat" ]] && PARITY_ARGS+=(--require-one-email --require-reviewer-smoke)

if ! "$PROTOCOL_PYTHON" scripts/ops/verify-env-secrets-parity.py "${PARITY_ARGS[@]}"; then
  warn "Runtime parity failed on the first attempt; retrying after 20s"
  sleep 20
  "$PROTOCOL_PYTHON" scripts/ops/verify-env-secrets-parity.py "${PARITY_ARGS[@]}" \
    || { warn "Runtime parity failed"; RELEASE_FAILED=1; }
fi

log "Running post-deploy HTTP health gates"
if [[ "$DEPLOY_BACKEND" == "true" && -n "$BACKEND_SERVICE_URL" ]]; then
  bash scripts/ci/cloudrun-http-health.sh "$BACKEND_SERVICE_URL" "/health" 5 30 5 200 \
    || { warn "Backend health gate failed"; BACKEND_FAILED=1; RELEASE_FAILED=1; }
fi
if [[ "$DEPLOY_FRONTEND" == "true" && -n "$FRONTEND_SERVICE_URL" ]]; then
  bash scripts/ci/cloudrun-http-health.sh "$FRONTEND_SERVICE_URL" "/" 3 30 5 200 \
    || { warn "Frontend health gate failed"; FRONTEND_FAILED=1; RELEASE_FAILED=1; }
fi

# ------------------------------------------------------------------ rollback
STATUS="healthy"
if [[ "$RELEASE_FAILED" -eq 1 ]]; then
  STATUS="blocked"
  ROLLED_BACK=1
  if [[ "$BACKEND_FAILED" -eq 1 && -n "$PRE_BACKEND_REVISION" ]]; then
    log "Rolling backend back to $PRE_BACKEND_REVISION"
    GCP_PROJECT_ID="$GCP_PROJECT_ID" bash scripts/ci/cloudrun-rollback.sh \
      "$BACKEND_SERVICE" "$GCP_REGION" "$PRE_BACKEND_REVISION" || ROLLED_BACK=0
  fi
  if [[ "$FRONTEND_FAILED" -eq 1 && -n "$PRE_FRONTEND_REVISION" ]]; then
    log "Rolling frontend back to $PRE_FRONTEND_REVISION"
    GCP_PROJECT_ID="$GCP_PROJECT_ID" bash scripts/ci/cloudrun-rollback.sh \
      "$FRONTEND_SERVICE" "$GCP_REGION" "$PRE_FRONTEND_REVISION" || ROLLED_BACK=0
  fi
  [[ "$ROLLED_BACK" -eq 1 ]] && STATUS="rolled_back"
fi

# -------------------------------------------------------------- status record
FINAL_BACKEND="$(describe_service "$BACKEND_SERVICE" 'status.traffic[0].revisionName')"
FINAL_FRONTEND="$(describe_service "$FRONTEND_SERVICE" 'status.traffic[0].revisionName')"

STATUS="$STATUS" ENVIRONMENT="$TARGET_ENV" SHA="$DEPLOY_SHA" RUN_ID="$RUN_ID" \
SOURCE="$DEPLOY_SOURCE" ARTIFACT_DIR="$ARTIFACT_DIR" \
PRE_B="$PRE_BACKEND_REVISION" PRE_F="$PRE_FRONTEND_REVISION" \
CAND_B="$CAND_BACKEND" CAND_F="$CAND_FRONTEND" \
FIN_B="$FINAL_BACKEND" FIN_F="$FINAL_FRONTEND" \
python3 - <<'PY'
import json, os
from pathlib import Path
payload = {
    "status": os.environ["STATUS"],
    "environment": os.environ["ENVIRONMENT"],
    "sha": os.environ["SHA"],
    "deploy_source": os.environ["SOURCE"],
    "run_id": os.environ["RUN_ID"],
    "lane": "cloudbuild-fallback",
    "predeploy": {"backend": os.environ["PRE_B"], "frontend": os.environ["PRE_F"]},
    "candidate": {"backend": os.environ["CAND_B"], "frontend": os.environ["CAND_F"]},
    "final": {"backend": os.environ["FIN_B"], "frontend": os.environ["FIN_F"]},
}
out = Path(os.environ["ARTIFACT_DIR"]) / "release-status.json"
out.write_text(json.dumps(payload, indent=2), encoding="utf-8")
print(json.dumps(payload, indent=2))
PY

log "Artifacts: ${ARTIFACT_DIR}"
echo "Backend  serving: ${FINAL_BACKEND:-none}"
echo "Frontend serving: ${FINAL_FRONTEND:-none}"

if [[ "$STATUS" != "healthy" ]]; then
  die "Release ended '${STATUS}'. Investigate before redeploying."
fi
log "Release healthy. New revisions are serving traffic."
