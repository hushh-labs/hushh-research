#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
REGION="${REGION:-us-central1}"
BACKEND_SERVICE="${BACKEND_SERVICE:-consent-protocol}"
JOB_NAME="${JOB_NAME:-marketplace-investor-replenisher}"
JOB_IMAGE="${JOB_IMAGE:-}"
JOB_ENVIRONMENT="${JOB_ENVIRONMENT:-uat}"
SCHEDULER_JOB_NAME="${SCHEDULER_JOB_NAME:-marketplace-investor-replenisher-every-8h}"
SCHEDULER_LOCATION="${SCHEDULER_LOCATION:-${REGION}}"
SCHEDULER_CRON="${SCHEDULER_CRON:-0 */8 * * *}"
SCHEDULER_TIMEZONE="${SCHEDULER_TIMEZONE:-Etc/UTC}"
SCHEDULER_SA_NAME="${SCHEDULER_SA_NAME:-marketplace-inv-repl-invoker}"
TARGET_TOTAL="${MARKETPLACE_INVESTOR_TARGET_TOTAL:-100}"
TARGET_SHOWCASE="${MARKETPLACE_INVESTOR_TARGET_SHOWCASE:-50}"
RATE_LIMIT="${MARKETPLACE_INVESTOR_RATE_LIMIT_PER_SECOND:-5}"
SEC_EDGAR_USER_AGENT="${SEC_EDGAR_USER_AGENT:-Hushh RIA Marketplace Investor Replenisher contact: engineering@hushh.ai}"

if [[ -z "${PROJECT_ID}" ]]; then
  echo "ERROR: PROJECT_ID is not set and no gcloud default project is configured."
  exit 1
fi

SCHEDULER_SA_EMAIL="${SCHEDULER_SA_EMAIL:-${SCHEDULER_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: required command not found: $1"
    exit 1
  fi
}

log() {
  echo "[marketplace-replenisher-setup] $*"
}

require_cmd gcloud
require_cmd jq

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

ensure_apis() {
  log "Enabling required Google APIs"
  gcloud services enable \
    run.googleapis.com \
    cloudscheduler.googleapis.com \
    iam.googleapis.com \
    iamcredentials.googleapis.com \
    secretmanager.googleapis.com \
    --project "${PROJECT_ID}" >/dev/null
}

ensure_scheduler_sa() {
  if gcloud iam service-accounts describe "${SCHEDULER_SA_EMAIL}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
    log "Scheduler invoker service account already exists: ${SCHEDULER_SA_EMAIL}"
  else
    log "Creating scheduler invoker service account: ${SCHEDULER_SA_EMAIL}"
    gcloud iam service-accounts create "${SCHEDULER_SA_NAME}" \
      --project "${PROJECT_ID}" \
      --display-name="Marketplace investor replenisher invoker" >/dev/null
  fi

  for attempt in {1..12}; do
    if gcloud iam service-accounts describe "${SCHEDULER_SA_EMAIL}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
      break
    fi
    if [[ "${attempt}" == "12" ]]; then
      echo "ERROR: service account ${SCHEDULER_SA_EMAIL} did not become readable in time."
      exit 1
    fi
    sleep 5
  done

  log "Granting roles/run.developer to ${SCHEDULER_SA_EMAIL}"
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${SCHEDULER_SA_EMAIL}" \
    --role="roles/run.developer" \
    --quiet >/dev/null

  local project_number scheduler_agent
  project_number="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
  scheduler_agent="service-${project_number}@gcp-sa-cloudscheduler.iam.gserviceaccount.com"

  log "Granting token creator on ${SCHEDULER_SA_EMAIL} to ${scheduler_agent}"
  gcloud iam service-accounts add-iam-policy-binding "${SCHEDULER_SA_EMAIL}" \
    --project "${PROJECT_ID}" \
    --member="serviceAccount:${scheduler_agent}" \
    --role="roles/iam.serviceAccountTokenCreator" \
    --quiet >/dev/null
}

upsert_cloud_run_job() {
  local backend_json="${TMP_DIR}/backend-service.json"
  gcloud run services describe "${BACKEND_SERVICE}" \
    --project "${PROJECT_ID}" \
    --region "${REGION}" \
    --format=json > "${backend_json}"

  local image="${JOB_IMAGE}"
  if [[ -z "${image}" ]]; then
    image="$(jq -r '.spec.template.spec.containers[0].image' "${backend_json}")"
  fi

  local db_host db_port db_name db_unix_socket runtime_config_secret cloudsql_instances
  db_host="$(jq -r '[.spec.template.spec.containers[0].env[]? | select(.name=="DB_HOST") | .value // empty][0] // ""' "${backend_json}")"
  db_port="$(jq -r '[.spec.template.spec.containers[0].env[]? | select(.name=="DB_PORT") | .value // empty][0] // ""' "${backend_json}")"
  db_name="$(jq -r '[.spec.template.spec.containers[0].env[]? | select(.name=="DB_NAME") | .value // empty][0] // ""' "${backend_json}")"
  db_unix_socket="$(jq -r '[.spec.template.spec.containers[0].env[]? | select(.name=="DB_UNIX_SOCKET") | .value // empty][0] // ""' "${backend_json}")"
  runtime_config_secret="$(jq -r '[.spec.template.spec.containers[0].env[]? | select(.name=="BACKEND_RUNTIME_CONFIG_JSON") | .valueFrom.secretKeyRef.name // empty][0] // ""' "${backend_json}")"
  cloudsql_instances="$(jq -r '.spec.template.metadata.annotations["run.googleapis.com/cloudsql-instances"] // empty' "${backend_json}")"

  if [[ -z "${runtime_config_secret}" && -z "${db_host}" && -z "${db_unix_socket}" ]]; then
    echo "ERROR: Unable to detect BACKEND_RUNTIME_CONFIG_JSON or DB_HOST/DB_UNIX_SOCKET from backend service ${BACKEND_SERVICE}."
    exit 1
  fi

  local env_vars
  env_vars="ENVIRONMENT=${JOB_ENVIRONMENT},MARKETPLACE_INVESTOR_TARGET_TOTAL=${TARGET_TOTAL},MARKETPLACE_INVESTOR_TARGET_SHOWCASE=${TARGET_SHOWCASE},MARKETPLACE_INVESTOR_RATE_LIMIT_PER_SECOND=${RATE_LIMIT},SEC_EDGAR_USER_AGENT=${SEC_EDGAR_USER_AGENT}"
  if [[ -n "${db_host}" ]]; then
    env_vars="${env_vars},DB_HOST=${db_host}"
  fi
  if [[ -n "${db_port}" ]]; then
    env_vars="${env_vars},DB_PORT=${db_port}"
  fi
  if [[ -n "${db_name}" ]]; then
    env_vars="${env_vars},DB_NAME=${db_name}"
  fi
  if [[ -n "${db_unix_socket}" && "${db_unix_socket}" != "null" ]]; then
    env_vars="${env_vars},DB_UNIX_SOCKET=${db_unix_socket}"
  fi

  local cloudsql_args=()
  if [[ -n "${cloudsql_instances}" ]]; then
    cloudsql_args=(--set-cloudsql-instances "${cloudsql_instances}")
    log "Propagating Cloud SQL attachment to job: ${cloudsql_instances}"
  fi

  local secret_vars="APP_SIGNING_KEY=APP_SIGNING_KEY:latest,VAULT_DATA_KEY=VAULT_DATA_KEY:latest,DB_USER=DB_USER:latest,DB_PASSWORD=DB_PASSWORD:latest"
  if [[ -n "${runtime_config_secret}" ]]; then
    secret_vars="${secret_vars},BACKEND_RUNTIME_CONFIG_JSON=${runtime_config_secret}:latest"
  fi
  if gcloud run jobs describe "${JOB_NAME}" --project "${PROJECT_ID}" --region "${REGION}" >/dev/null 2>&1; then
    log "Updating Cloud Run Job: ${JOB_NAME}"
    gcloud run jobs update "${JOB_NAME}" \
      --project "${PROJECT_ID}" \
      --region "${REGION}" \
      --image "${image}" \
      --tasks 1 \
      --parallelism 1 \
      --max-retries 0 \
      --task-timeout 900s \
      --set-env-vars "${env_vars}" \
      --set-secrets "${secret_vars}" \
      "${cloudsql_args[@]}" \
      --command python \
      --args scripts/marketplace_investor_replenisher.py >/dev/null
  else
    log "Creating Cloud Run Job: ${JOB_NAME}"
    gcloud run jobs create "${JOB_NAME}" \
      --project "${PROJECT_ID}" \
      --region "${REGION}" \
      --image "${image}" \
      --tasks 1 \
      --parallelism 1 \
      --max-retries 0 \
      --task-timeout 900s \
      --set-env-vars "${env_vars}" \
      --set-secrets "${secret_vars}" \
      "${cloudsql_args[@]}" \
      --command python \
      --args scripts/marketplace_investor_replenisher.py >/dev/null
  fi
}

upsert_scheduler_job() {
  local uri="https://run.googleapis.com/v2/projects/${PROJECT_ID}/locations/${REGION}/jobs/${JOB_NAME}:run"

  if gcloud scheduler jobs describe "${SCHEDULER_JOB_NAME}" --project "${PROJECT_ID}" --location "${SCHEDULER_LOCATION}" >/dev/null 2>&1; then
    log "Updating Cloud Scheduler job: ${SCHEDULER_JOB_NAME}"
    gcloud scheduler jobs update http "${SCHEDULER_JOB_NAME}" \
      --project "${PROJECT_ID}" \
      --location "${SCHEDULER_LOCATION}" \
      --schedule "${SCHEDULER_CRON}" \
      --time-zone "${SCHEDULER_TIMEZONE}" \
      --uri "${uri}" \
      --http-method POST \
      --oauth-service-account-email "${SCHEDULER_SA_EMAIL}" \
      --oauth-token-scope "https://www.googleapis.com/auth/cloud-platform" \
      --message-body '{}' >/dev/null
  else
    log "Creating Cloud Scheduler job: ${SCHEDULER_JOB_NAME}"
    gcloud scheduler jobs create http "${SCHEDULER_JOB_NAME}" \
      --project "${PROJECT_ID}" \
      --location "${SCHEDULER_LOCATION}" \
      --schedule "${SCHEDULER_CRON}" \
      --time-zone "${SCHEDULER_TIMEZONE}" \
      --uri "${uri}" \
      --http-method POST \
      --oauth-service-account-email "${SCHEDULER_SA_EMAIL}" \
      --oauth-token-scope "https://www.googleapis.com/auth/cloud-platform" \
      --message-body '{}' >/dev/null
  fi
}

main() {
  log "Starting setup in project=${PROJECT_ID}, region=${REGION}, schedule='${SCHEDULER_CRON}'"
  ensure_apis
  ensure_scheduler_sa
  upsert_cloud_run_job
  upsert_scheduler_job
  log "Cloud Run Job: ${JOB_NAME}"
  log "Cloud Scheduler Job: ${SCHEDULER_JOB_NAME}"
  log "Manual seed command: gcloud run jobs execute ${JOB_NAME} --project ${PROJECT_ID} --region ${REGION} --wait"
}

main "$@"
