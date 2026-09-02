#!/usr/bin/env bash
set -euo pipefail

# Configure the opted-in personal Gmail monitor. This is intentionally an
# operator-run step: committing the script never creates or broadens a Gmail
# watcher, and the job is independent of the one@hushh.ai mailbox scheduler.

PROJECT_ID="${PROJECT_ID:-hushh-pda-uat}"
SCHEDULER_LOCATION="${SCHEDULER_LOCATION:-us-central1}"
BACKEND_URL="${BACKEND_URL:-}"
JOB_NAME="${JOB_NAME:-gmail-personal-information-request-monitor-uat}"
CRON="${CRON:-*/5 * * * *}"
TIMEZONE="${TIMEZONE:-America/Los_Angeles}"
MAX_USERS="${MAX_USERS:-20}"
SCHEDULER_SERVICE_ACCOUNT_NAME="${SCHEDULER_SERVICE_ACCOUNT_NAME:-gmail-personal-monitor-scheduler}"
SCHEDULER_SERVICE_ACCOUNT_EMAIL="${SCHEDULER_SERVICE_ACCOUNT_EMAIL:-}"

if [[ -z "${BACKEND_URL}" ]]; then
  echo "BACKEND_URL is required" >&2
  exit 1
fi

if ! [[ "${MAX_USERS}" =~ ^[1-9][0-9]{0,2}$ ]] || (( MAX_USERS > 50 )); then
  echo "MAX_USERS must be an integer from 1 through 50" >&2
  exit 1
fi

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud is required" >&2
  exit 1
fi

if [[ -z "${SCHEDULER_SERVICE_ACCOUNT_EMAIL}" ]]; then
  SCHEDULER_SERVICE_ACCOUNT_EMAIL="${SCHEDULER_SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
fi

if ! gcloud iam service-accounts describe "${SCHEDULER_SERVICE_ACCOUNT_EMAIL}" \
  --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${SCHEDULER_SERVICE_ACCOUNT_NAME}" \
    --project="${PROJECT_ID}" \
    --display-name="Personal Gmail monitor scheduler" >/dev/null
fi

PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
SCHEDULER_SERVICE_AGENT="service-${PROJECT_NUMBER}@gcp-sa-cloudscheduler.iam.gserviceaccount.com"
gcloud iam service-accounts add-iam-policy-binding "${SCHEDULER_SERVICE_ACCOUNT_EMAIL}" \
  --project="${PROJECT_ID}" \
  --member="serviceAccount:${SCHEDULER_SERVICE_AGENT}" \
  --role="roles/iam.serviceAccountTokenCreator" >/dev/null

URI="${BACKEND_URL%/}/api/one/email/information-requests/scan-enabled"
BODY="{\"max_users\":${MAX_USERS}}"
COMMON_ARGS=(
  --project="${PROJECT_ID}"
  --location="${SCHEDULER_LOCATION}"
  --schedule="${CRON}"
  --time-zone="${TIMEZONE}"
  --uri="${URI}"
  --http-method=POST
  --headers="Content-Type=application/json"
  --message-body="${BODY}"
  --oidc-service-account-email="${SCHEDULER_SERVICE_ACCOUNT_EMAIL}"
  --oidc-token-audience="${BACKEND_URL%/}"
  --attempt-deadline=300s
)

if gcloud scheduler jobs describe "${JOB_NAME}" \
  --project="${PROJECT_ID}" \
  --location="${SCHEDULER_LOCATION}" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "${JOB_NAME}" "${COMMON_ARGS[@]}" >/dev/null
else
  gcloud scheduler jobs create http "${JOB_NAME}" "${COMMON_ARGS[@]}" >/dev/null
fi

JOB_EVIDENCE="$(gcloud scheduler jobs describe "${JOB_NAME}" \
  --project="${PROJECT_ID}" \
  --location="${SCHEDULER_LOCATION}" \
  --format='value(state,schedule,httpTarget.uri,httpTarget.httpMethod,httpTarget.oidcToken.serviceAccountEmail,httpTarget.oidcToken.audience)')"

if [[ "${JOB_EVIDENCE}" != ENABLED$'\t'"${CRON}"$'\t'"${URI}"$'\t'POST$'\t'"${SCHEDULER_SERVICE_ACCOUNT_EMAIL}"$'\t'"${BACKEND_URL%/}" ]]; then
  echo "Cloud Scheduler verification failed for ${JOB_NAME}" >&2
  exit 1
fi

echo "Configured and verified personal Gmail monitor ${JOB_NAME}: ${JOB_EVIDENCE}"
