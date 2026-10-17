#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_METRICS_DIR="${SCRIPT_DIR}/log-metrics"
ALERTS_DIR="${SCRIPT_DIR}/alerts"
DASHBOARD_TEMPLATE="${SCRIPT_DIR}/dashboard-observability.json.in"

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
REGION="${REGION:-us-central1}"
BQ_LOCATION="${BQ_LOCATION:-US}"
BACKEND_SERVICE="${BACKEND_SERVICE:-consent-protocol}"
FRONTEND_SERVICE="${FRONTEND_SERVICE:-hushh-webapp}"
DATA_HEALTH_JOB_NAME="${DATA_HEALTH_JOB_NAME:-obs-db-data-health}"
DATA_HEALTH_JOB_IMAGE="${DATA_HEALTH_JOB_IMAGE:-}"
DATA_HEALTH_ENVIRONMENT="${DATA_HEALTH_ENVIRONMENT:-production}"
SCHEDULER_JOB_NAME="${SCHEDULER_JOB_NAME:-obs-db-data-health-every-30m}"
SCHEDULER_LOCATION="${SCHEDULER_LOCATION:-${REGION}}"
SCHEDULER_CRON="${SCHEDULER_CRON:-*/30 * * * *}"
SCHEDULER_TIMEZONE="${SCHEDULER_TIMEZONE:-Etc/UTC}"
OBS_ALERT_EMAIL="${OBS_ALERT_EMAIL:-}"
OBS_SCHEDULER_SA_NAME="${OBS_SCHEDULER_SA_NAME:-obs-scheduler-invoker}"
OBS_SCHEDULER_SA_EMAIL="${OBS_SCHEDULER_SA_EMAIL:-${OBS_SCHEDULER_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com}"
DASHBOARD_ID="${DASHBOARD_ID:-hushh-observability-managed}"
SQL_INSTANCE="${SQL_INSTANCE:-}"
OBS_COMMERCE_ONLY="${OBS_COMMERCE_ONLY:-false}"
OBS_COMMERCE_ENABLED="${OBS_COMMERCE_ENABLED:-false}"
OBS_COMMERCE_RUNTIME_SA_EMAIL="${OBS_COMMERCE_RUNTIME_SA_EMAIL:-}"
PROTOCOL_PYTHON="${PROTOCOL_PYTHON:-${SCRIPT_DIR}/../../consent-protocol/.venv/bin/python}"

if [[ -z "${PROJECT_ID}" ]]; then
  echo "ERROR: PROJECT_ID is not set and no gcloud default project is configured."
  exit 1
fi

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: required command not found: $1"
    exit 1
  fi
}

log() {
  echo "[observability-setup] $*"
}

require_cmd gcloud
if [[ "${OBS_COMMERCE_ONLY}" != "true" ]]; then
  require_cmd bq
fi
require_cmd jq

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

render_template() {
  local src="$1"
  local dst="$2"
  sed \
    -e "s|__PROJECT_ID__|${PROJECT_ID}|g" \
    -e "s|__REGION__|${REGION}|g" \
    -e "s|__BACKEND_SERVICE__|${BACKEND_SERVICE}|g" \
    -e "s|__FRONTEND_SERVICE__|${FRONTEND_SERVICE}|g" \
    "$src" > "$dst"
}

ensure_apis() {
  log "Enabling required Google APIs"
  gcloud services enable \
    bigquery.googleapis.com \
    monitoring.googleapis.com \
    logging.googleapis.com \
    run.googleapis.com \
    cloudscheduler.googleapis.com \
    iam.googleapis.com \
    iamcredentials.googleapis.com \
    cloudtrace.googleapis.com \
    --project "${PROJECT_ID}" >/dev/null
}

ensure_dataset() {
  local dataset="$1"
  if bq --project_id="${PROJECT_ID}" show --dataset "${PROJECT_ID}:${dataset}" >/dev/null 2>&1; then
    log "BigQuery dataset already exists: ${dataset}"
    return
  fi

  log "Creating BigQuery dataset: ${dataset}"
  bq --project_id="${PROJECT_ID}" --location="${BQ_LOCATION}" mk --dataset "${PROJECT_ID}:${dataset}" >/dev/null
}

upsert_log_metric() {
  local config_path="$1"
  local metric_name
  metric_name="$(jq -r '.name' "${config_path}")"

  if gcloud logging metrics describe "${metric_name}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
    log "Updating log-based metric: ${metric_name}"
    gcloud logging metrics update "${metric_name}" \
      --config-from-file="${config_path}" \
      --project "${PROJECT_ID}" >/dev/null
    return
  fi

  log "Creating log-based metric: ${metric_name}"
  gcloud logging metrics create "${metric_name}" \
    --config-from-file="${config_path}" \
    --project "${PROJECT_ID}" >/dev/null
}

upsert_dashboard() {
  local rendered="${TMP_DIR}/dashboard.json"
  local dashboard_resource="projects/${PROJECT_ID}/dashboards/${DASHBOARD_ID}"

  render_template "${DASHBOARD_TEMPLATE}" "${rendered}"
  # The caller chooses an isolated dashboard; never create the template's
  # shared dashboard when a different id was explicitly requested.
  jq --arg name "${dashboard_resource}" '.name = $name' "${rendered}" > "${rendered}.scoped"
  mv "${rendered}.scoped" "${rendered}"
  if [[ "${OBS_COMMERCE_ENABLED}" != "true" && "${OBS_COMMERCE_ONLY}" != "true" ]]; then
    jq '.gridLayout.widgets |= map(select(.title | startswith("Scope Commerce:") | not))' \
      "${rendered}" > "${rendered}.scoped"
    mv "${rendered}.scoped" "${rendered}"
  fi

  if gcloud monitoring dashboards describe "${dashboard_resource}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
    local etag
    etag="$(gcloud monitoring dashboards describe "${dashboard_resource}" --project "${PROJECT_ID}" --format=json | jq -r '.etag // empty')"
    if [[ -z "${etag}" ]]; then
      echo "ERROR: dashboard etag unavailable; refusing unsafe replacement" >&2
      return 1
    fi
    jq --arg etag "${etag}" '.etag = $etag' "${rendered}" > "${rendered}.update"
    log "Updating dashboard: ${dashboard_resource}"
    gcloud monitoring dashboards update "${dashboard_resource}" \
      --config-from-file="${rendered}.update" \
      --project "${PROJECT_ID}" >/dev/null
    return
  fi

  log "Creating dashboard: ${dashboard_resource}"
  gcloud monitoring dashboards create \
    --config-from-file="${rendered}" \
    --project "${PROJECT_ID}" >/dev/null
}

ensure_email_channel() {
  local email="$1"
  local existing

  existing="$(gcloud beta monitoring channels list \
    --project "${PROJECT_ID}" \
    --filter="type=\"email\" AND labels.email_address=\"${email}\"" \
    --format='value(name)' \
    --limit=1)"

  if [[ -n "${existing}" ]]; then
    log "Notification channel already exists for ${email}" >&2
    echo "${existing}"
    return
  fi

  log "Creating email notification channel for ${email}" >&2
  gcloud beta monitoring channels create \
    --project "${PROJECT_ID}" \
    --display-name="Observability Alerts (${email})" \
    --type=email \
    --channel-labels="email_address=${email}" \
    --format='value(name)'
}

ensure_scheduler_sa() {
  if gcloud iam service-accounts describe "${OBS_SCHEDULER_SA_EMAIL}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
    log "Scheduler invoker service account already exists: ${OBS_SCHEDULER_SA_EMAIL}"
  else
    log "Creating scheduler invoker service account: ${OBS_SCHEDULER_SA_EMAIL}"
    gcloud iam service-accounts create "${OBS_SCHEDULER_SA_NAME}" \
      --project "${PROJECT_ID}" \
      --display-name="Observability Scheduler Invoker" >/dev/null
  fi

  log "Granting roles/run.developer to ${OBS_SCHEDULER_SA_EMAIL}"
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${OBS_SCHEDULER_SA_EMAIL}" \
    --role="roles/run.developer" \
    --quiet >/dev/null

  local project_number
  project_number="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
  local scheduler_agent="service-${project_number}@gcp-sa-cloudscheduler.iam.gserviceaccount.com"

  log "Granting token creator on ${OBS_SCHEDULER_SA_EMAIL} to ${scheduler_agent}"
  gcloud iam service-accounts add-iam-policy-binding "${OBS_SCHEDULER_SA_EMAIL}" \
    --project "${PROJECT_ID}" \
    --member="serviceAccount:${scheduler_agent}" \
    --role="roles/iam.serviceAccountTokenCreator" \
    --quiet >/dev/null
}

set_data_health_job() {
  local backend_json="${TMP_DIR}/backend-service.json"
  gcloud run services describe "${BACKEND_SERVICE}" \
    --project "${PROJECT_ID}" \
    --region "${REGION}" \
    --format=json > "${backend_json}"

  local image
  if [[ -n "${DATA_HEALTH_JOB_IMAGE}" ]]; then
    image="${DATA_HEALTH_JOB_IMAGE}"
  else
    image="$(jq -r '.spec.template.spec.containers[0].image' "${backend_json}")"
  fi

  local db_host db_port db_name db_unix_socket stale_threshold
  db_host="$(jq -r '.spec.template.spec.containers[0].env[] | select(.name=="DB_HOST") | .value' "${backend_json}" | head -n1)"
  db_port="$(jq -r '.spec.template.spec.containers[0].env[] | select(.name=="DB_PORT") | .value' "${backend_json}" | head -n1)"
  db_name="$(jq -r '.spec.template.spec.containers[0].env[] | select(.name=="DB_NAME") | .value' "${backend_json}" | head -n1)"
  db_unix_socket="$(jq -r '.spec.template.spec.containers[0].env[] | select(.name=="DB_UNIX_SOCKET") | .value' "${backend_json}" | head -n1)"
  stale_threshold="$(jq -r '.spec.template.spec.containers[0].env[] | select(.name=="OBS_DATA_STALE_RATIO_THRESHOLD") | .value' "${backend_json}" | head -n1)"
  local cloudsql_instances
  cloudsql_instances="$(jq -r '.spec.template.metadata.annotations["run.googleapis.com/cloudsql-instances"] // empty' "${backend_json}")"
  local cloudsql_args=()
  if [[ -n "${cloudsql_instances}" ]]; then
    cloudsql_args=(--set-cloudsql-instances "${cloudsql_instances}")
    log "Propagating Cloud SQL attachment to job: ${cloudsql_instances}"
  fi

  if [[ -z "${db_host}" || -z "${db_port}" || -z "${db_name}" ]]; then
    echo "ERROR: Unable to detect DB_HOST/DB_PORT/DB_NAME from backend service ${BACKEND_SERVICE}."
    exit 1
  fi

  if [[ -z "${stale_threshold}" || "${stale_threshold}" == "null" ]]; then
    stale_threshold="0.25"
  fi

  local env_vars="ENVIRONMENT=${DATA_HEALTH_ENVIRONMENT},DB_HOST=${db_host},DB_PORT=${db_port},DB_NAME=${db_name},OBS_DATA_STALE_RATIO_THRESHOLD=${stale_threshold}"
  if [[ -n "${db_unix_socket}" && "${db_unix_socket}" != "null" ]]; then
    env_vars="${env_vars},DB_UNIX_SOCKET=${db_unix_socket}"
  fi
  local secret_vars="DB_USER=DB_USER:latest,DB_PASSWORD=DB_PASSWORD:latest"

  if gcloud run jobs describe "${DATA_HEALTH_JOB_NAME}" --project "${PROJECT_ID}" --region "${REGION}" >/dev/null 2>&1; then
    log "Updating Cloud Run Job: ${DATA_HEALTH_JOB_NAME}"
    gcloud run jobs update "${DATA_HEALTH_JOB_NAME}" \
      --project "${PROJECT_ID}" \
      --region "${REGION}" \
      --image "${image}" \
      --tasks 1 \
      --parallelism 1 \
      --max-retries 0 \
      --task-timeout 300s \
      --set-env-vars "${env_vars}" \
      --set-secrets "${secret_vars}" \
      "${cloudsql_args[@]}" \
      --command python \
      --args scripts/observability/db_data_health.py >/dev/null
  else
    log "Creating Cloud Run Job: ${DATA_HEALTH_JOB_NAME}"
    gcloud run jobs create "${DATA_HEALTH_JOB_NAME}" \
      --project "${PROJECT_ID}" \
      --region "${REGION}" \
      --image "${image}" \
      --tasks 1 \
      --parallelism 1 \
      --max-retries 0 \
      --task-timeout 300s \
      --set-env-vars "${env_vars}" \
      --set-secrets "${secret_vars}" \
      "${cloudsql_args[@]}" \
      --command python \
      --args scripts/observability/db_data_health.py >/dev/null
  fi
}

set_scheduler_job() {
  local uri="https://run.googleapis.com/v2/projects/${PROJECT_ID}/locations/${REGION}/jobs/${DATA_HEALTH_JOB_NAME}:run"

  if gcloud scheduler jobs describe "${SCHEDULER_JOB_NAME}" --project "${PROJECT_ID}" --location "${SCHEDULER_LOCATION}" >/dev/null 2>&1; then
    log "Updating Cloud Scheduler job: ${SCHEDULER_JOB_NAME}"
    gcloud scheduler jobs update http "${SCHEDULER_JOB_NAME}" \
      --project "${PROJECT_ID}" \
      --location "${SCHEDULER_LOCATION}" \
      --schedule "${SCHEDULER_CRON}" \
      --time-zone "${SCHEDULER_TIMEZONE}" \
      --uri "${uri}" \
      --http-method POST \
      --oauth-service-account-email "${OBS_SCHEDULER_SA_EMAIL}" \
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
      --oauth-service-account-email "${OBS_SCHEDULER_SA_EMAIL}" \
      --oauth-token-scope "https://www.googleapis.com/auth/cloud-platform" \
      --message-body '{}' >/dev/null
  fi
}

setup_commerce_monitoring() {
  if [[ ! "${OBS_COMMERCE_RUNTIME_SA_EMAIL}" =~ ^[a-z][a-z0-9-]+@${PROJECT_ID}\.iam\.gserviceaccount\.com$ ]]; then
    echo "ERROR: an exact project-owned backend runtime identity is required" >&2
    return 1
  fi
  gcloud iam service-accounts describe "${OBS_COMMERCE_RUNTIME_SA_EMAIL}" --project "${PROJECT_ID}" >/dev/null
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${OBS_COMMERCE_RUNTIME_SA_EMAIL}" \
    --role="roles/monitoring.metricWriter" --quiet >/dev/null
  "${PROTOCOL_PYTHON}" "${SCRIPT_DIR}/scope_commerce_monitoring.py" --project "${PROJECT_ID}"
}

main() {
  log "Starting setup in project=${PROJECT_ID}, region=${REGION}"

  if [[ "${OBS_COMMERCE_ONLY}" == "true" ]]; then
    gcloud services enable monitoring.googleapis.com --project "${PROJECT_ID}" >/dev/null
    setup_commerce_monitoring
    python3 "${SCRIPT_DIR}/reconcile_capacity.py" --apply --commerce-only --console-only \
      --project "${PROJECT_ID}" --backend-service "${BACKEND_SERVICE}" --dashboard-id "${DASHBOARD_ID}"
    log "Commerce monitoring configured with Cloud Console alerts; no analytics or scheduler changes."
    return
  fi

  ensure_apis

  ensure_dataset analytics_staging
  ensure_dataset analytics_prod

  if [[ -z "${SQL_INSTANCE}" ]]; then
    local cloudsql_attachment
    cloudsql_attachment="$(gcloud run services describe "${BACKEND_SERVICE}" \
      --project "${PROJECT_ID}" --region "${REGION}" --format=json \
      | jq -r '.spec.template.metadata.annotations["run.googleapis.com/cloudsql-instances"] // empty')"
    if [[ "${cloudsql_attachment}" != *,* && "${cloudsql_attachment}" == *:*:* ]]; then
      SQL_INSTANCE="${cloudsql_attachment##*:}"
    else
      echo "ERROR: Set SQL_INSTANCE explicitly; expected one Cloud SQL attachment on ${BACKEND_SERVICE}." >&2
      exit 1
    fi
  fi
  local email_args=()
  local commerce_args=()
  if [[ "${OBS_COMMERCE_ENABLED}" == "true" ]]; then
    setup_commerce_monitoring
    commerce_args=(--include-commerce)
  fi
  if [[ -n "${OBS_ALERT_EMAIL}" ]]; then
    email_args=(--email "${OBS_ALERT_EMAIL}")
  fi
  python3 "${SCRIPT_DIR}/reconcile_capacity.py" --apply \
    --project "${PROJECT_ID}" --sql-instance "${SQL_INSTANCE}" \
    --backend-service "${BACKEND_SERVICE}" --frontend-service "${FRONTEND_SERVICE}" \
    --dashboard-id "${DASHBOARD_ID}" "${email_args[@]}" "${commerce_args[@]}"

  ensure_scheduler_sa
  set_data_health_job
  set_scheduler_job

  log "Completed observability automation setup."
  log "BigQuery datasets: analytics_staging, analytics_prod"
  log "Cloud Run Job: ${DATA_HEALTH_JOB_NAME}"
  log "Cloud Run Job ENVIRONMENT: ${DATA_HEALTH_ENVIRONMENT}"
  log "Cloud Scheduler Job: ${SCHEDULER_JOB_NAME}"
}

main "$@"
