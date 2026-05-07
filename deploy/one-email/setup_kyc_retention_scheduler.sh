#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-hushh-pda-uat}"
SCHEDULER_LOCATION="${SCHEDULER_LOCATION:-us-central1}"
BACKEND_URL="${BACKEND_URL:-}"
ONE_EMAIL_WATCH_RENEW_TOKEN_SECRET="${ONE_EMAIL_WATCH_RENEW_TOKEN_SECRET:-ONE_EMAIL_WATCH_RENEW_TOKEN}"
JOB_NAME="${JOB_NAME:-one-email-kyc-retention-purge-uat}"
CRON="${CRON:-37 9 * * *}"
TIMEZONE="${TIMEZONE:-America/Los_Angeles}"
OLDER_THAN_DAYS="${OLDER_THAN_DAYS:-30}"

if [[ -z "${BACKEND_URL}" ]]; then
  echo "BACKEND_URL is required, for example https://consent-protocol-...run.app" >&2
  exit 1
fi

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud is required" >&2
  exit 1
fi

TOKEN="$(gcloud secrets versions access latest \
  --project="${PROJECT_ID}" \
  --secret="${ONE_EMAIL_WATCH_RENEW_TOKEN_SECRET}")"

if [[ -z "${TOKEN}" ]]; then
  echo "Secret ${ONE_EMAIL_WATCH_RENEW_TOKEN_SECRET} is empty or inaccessible" >&2
  exit 1
fi

URI="${BACKEND_URL%/}/api/one/kyc/retention/purge?older_than_days=${OLDER_THAN_DAYS}"
HEADERS="X-Hushh-Maintenance-Token=${TOKEN},Content-Type=application/json"

if gcloud scheduler jobs describe "${JOB_NAME}" \
  --project="${PROJECT_ID}" \
  --location="${SCHEDULER_LOCATION}" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "${JOB_NAME}" \
    --project="${PROJECT_ID}" \
    --location="${SCHEDULER_LOCATION}" \
    --schedule="${CRON}" \
    --time-zone="${TIMEZONE}" \
    --uri="${URI}" \
    --http-method=POST \
    --headers="${HEADERS}" \
    --attempt-deadline=300s >/dev/null
else
  gcloud scheduler jobs create http "${JOB_NAME}" \
    --project="${PROJECT_ID}" \
    --location="${SCHEDULER_LOCATION}" \
    --schedule="${CRON}" \
    --time-zone="${TIMEZONE}" \
    --uri="${URI}" \
    --http-method=POST \
    --headers="${HEADERS}" \
    --attempt-deadline=300s >/dev/null
fi

echo "Configured Cloud Scheduler job ${JOB_NAME} -> ${URI}"
