#!/usr/bin/env bash
set -euo pipefail

# Configure the bounded One Location retention endpoint in UAT. This script is
# intentionally operator-run; landing it does not mutate Cloud Scheduler.

PROJECT_ID="${PROJECT_ID:-hushh-pda-uat}"
SCHEDULER_LOCATION="${SCHEDULER_LOCATION:-us-central1}"
BACKEND_URL="${BACKEND_URL:-}"
RETENTION_TOKEN_SECRET="${RETENTION_TOKEN_SECRET:-ONE_LOCATION_RETENTION_TOKEN}"
JOB_NAME="${JOB_NAME:-one-location-retention-purge-uat}"
CRON="${CRON:-17 * * * *}"
TIMEZONE="${TIMEZONE:-America/Los_Angeles}"
OLDER_THAN_HOURS="${OLDER_THAN_HOURS:-12}"

if [[ -z "${BACKEND_URL}" ]]; then
  echo "BACKEND_URL is required" >&2
  exit 1
fi

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud is required" >&2
  exit 1
fi

TOKEN="$(gcloud secrets versions access latest \
  --project="${PROJECT_ID}" \
  --secret="${RETENTION_TOKEN_SECRET}")"

if [[ -z "${TOKEN}" ]]; then
  echo "Retention token secret is empty or inaccessible" >&2
  exit 1
fi

URI="${BACKEND_URL%/}/api/one/location/retention/purge?older_than_hours=${OLDER_THAN_HOURS}"
HEADERS="X-Hushh-Maintenance-Token=${TOKEN},Content-Type=application/json"

COMMON_ARGS=(
  --project="${PROJECT_ID}"
  --location="${SCHEDULER_LOCATION}"
  --schedule="${CRON}"
  --time-zone="${TIMEZONE}"
  --uri="${URI}"
  --http-method=POST
  --headers="${HEADERS}"
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
  --format='value(state,schedule,httpTarget.uri)')"

EXPECTED_URI="${URI}"
if [[ "${JOB_EVIDENCE}" != ENABLED$'\t'"${CRON}"$'\t'"${EXPECTED_URI}" ]]; then
  echo "Cloud Scheduler verification failed for ${JOB_NAME}" >&2
  exit 1
fi

echo "Configured and verified Cloud Scheduler job ${JOB_NAME}: ${JOB_EVIDENCE}"
