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
require_cmd bq
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

  if gcloud monitoring dashboards describe "${dashboard_resource}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
    log "Replacing dashboard: ${dashboard_resource}"
    gcloud monitoring dashboards delete "${dashboard_resource}" --project "${PROJECT_ID}" --quiet >/dev/null
  else
    log "Creating dashboard: ${dashboard_resource}"
  fi

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
    log "Notification channel already exists for ${email}"
    echo "${existing}"
    return
  fi

  log "Creating email notification channel for ${email}"
  gcloud beta monitoring channels create \
    --project "${PROJECT_ID}" \
    --display-name="Observability Alerts (${email})" \
    --type=email \
    --channel-labels="email_address=${email}" \
    --format='value(name)'
}

upsert_alert_policy() {
  local template_path="$1"
  local channels_json="$2"

  local rendered="${TMP_DIR}/$(basename "${template_path}" .in).json"
  local rendered_with_channels="${rendered}.channels.json"
  render_template "${template_path}" "${rendered}"

  jq --argjson channels "${channels_json}" '.notificationChannels = $channels' "${rendered}" > "${rendered_with_channels}"

  local display_name
  display_name="$(jq -r '.displayName' "${rendered_with_channels}")"

  local existing_names
  existing_names="$(gcloud monitoring policies list \
    --project "${PROJECT_ID}" \
    --format=json | jq -r --arg name "${display_name}" '.[] | select(.displayName == $name) | .name' | head -n1)"
  local existing
  existing="$(printf '%s\n' "${existing_names}" | head -n1)"

  local duplicate_names
  duplicate_names="$(gcloud monitoring policies list \
    --project "${PROJECT_ID}" \
    --format=json | jq -r --arg name "${display_name}" '.[] | select(.displayName == $name) | .name' | tail -n +2)"
  if [[ -n "${duplicate_names}" ]]; then
    while IFS= read -r policy_name; do
      if [[ -z "${policy_name}" ]]; then
        continue
      fi
      log "Deleting duplicate alert policy: ${policy_name}"
      gcloud monitoring policies delete "${policy_name}" --project "${PROJECT_ID}" --quiet >/dev/null
    done <<< "${duplicate_names}"
  fi

  if [[ -z "${existing}" ]]; then
    log "Creating alert policy: ${display_name}"
    gcloud monitoring policies create \
      --project "${PROJECT_ID}" \
      --policy-from-file="${rendered_with_channels}" >/dev/null
    return
  fi

  local update_config="${rendered_with_channels}.update.json"

  jq --arg name "${existing}" '.name = $name' "${rendered_with_channels}" > "${update_config}"

  log "Updating alert policy: ${display_name}"
  gcloud monitoring policies update "${existing}" \
    --project "${PROJECT_ID}" \
    --policy-from-file="${update_config}" >/dev/null
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

main() {
  log "Starting setup in project=${PROJECT_ID}, region=${REGION}"

  ensure_apis

  ensure_dataset analytics_staging
  ensure_dataset analytics_prod

  upsert_log_metric "${LOG_METRICS_DIR}/obs_request_summary_count.json"
  upsert_log_metric "${LOG_METRICS_DIR}/obs_unexpected_error_count.json"
  upsert_log_metric "${LOG_METRICS_DIR}/obs_data_health_anomaly_count.json"

  upsert_dashboard

  local channels_json='[]'
  if [[ -n "${OBS_ALERT_EMAIL}" ]]; then
    local channel_name
    channel_name="$(ensure_email_channel "${OBS_ALERT_EMAIL}")"
    channels_json="$(jq -nc --arg c "${channel_name}" '[ $c ]')"
    log "Using notification channel: ${channel_name}"
  else
    log "OBS_ALERT_EMAIL not set; alert policies will be created without notification channels (Cloud Console only)."
  fi

  upsert_alert_policy "${ALERTS_DIR}/backend-5xx-policy.json.in" "${channels_json}"
  upsert_alert_policy "${ALERTS_DIR}/backend-latency-policy.json.in" "${channels_json}"
  upsert_alert_policy "${ALERTS_DIR}/unexpected-errors-policy.json.in" "${channels_json}"
  upsert_alert_policy "${ALERTS_DIR}/data-health-anomaly-policy.json.in" "${channels_json}"

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
