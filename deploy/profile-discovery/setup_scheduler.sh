#!/usr/bin/env bash
set -euo pipefail

# Configure the default-off UAT discovery worker. This creates or updates an
# OIDC-only scheduler identity; it does not enable profile discovery or grant
# any Firebase user cohort access.
readonly UAT_PROJECT_ID="hushh-pda-uat"
readonly UAT_LOCATION="us-central1"
readonly UAT_JOB_NAME="profile-discovery-drain-uat"
readonly UAT_SERVICE_ACCOUNT_NAME="profile-discovery-sched"
readonly UAT_PUBLIC_BACKEND_ORIGIN="https://api.uat.hushh.ai"
readonly UAT_RUNTIME_BACKEND_ORIGIN="https://consent-protocol-f2gsa4kfsq-uc.a.run.app"

PROJECT_ID="${PROJECT_ID:-${UAT_PROJECT_ID}}"
LOCATION="${LOCATION:-${UAT_LOCATION}}"
JOB_NAME="${JOB_NAME:-${UAT_JOB_NAME}}"
BACKEND_URL="${BACKEND_URL:-}"
OIDC_AUDIENCE="${OIDC_AUDIENCE:-${BACKEND_URL%/}}"
CRON="${CRON:-* * * * *}"
SCHEDULER_SERVICE_ACCOUNT_NAME="${SCHEDULER_SERVICE_ACCOUNT_NAME:-${UAT_SERVICE_ACCOUNT_NAME}}"

if [[ "${PROJECT_ID}" != "${UAT_PROJECT_ID}" || "${LOCATION}" != "${UAT_LOCATION}" \
  || "${JOB_NAME}" != "${UAT_JOB_NAME}" || "${CRON}" != "* * * * *" \
  || "${SCHEDULER_SERVICE_ACCOUNT_NAME}" != "${UAT_SERVICE_ACCOUNT_NAME}" ]]; then
  echo "This helper only configures the reviewed UAT profile-discovery worker" >&2
  exit 1
fi
if [[ -z "${BACKEND_URL}" ]]; then
  echo "BACKEND_URL is required" >&2
  exit 1
fi
BACKEND_URL="${BACKEND_URL%/}"
OIDC_AUDIENCE="${OIDC_AUDIENCE%/}"
if [[ "${BACKEND_URL}" != "${UAT_PUBLIC_BACKEND_ORIGIN}" \
  && "${BACKEND_URL}" != "${UAT_RUNTIME_BACKEND_ORIGIN}" ]]; then
  echo "BACKEND_URL must be an approved UAT backend origin" >&2
  exit 1
fi
if [[ "${OIDC_AUDIENCE}" != "${BACKEND_URL}" ]]; then
  echo "OIDC_AUDIENCE must exactly match BACKEND_URL" >&2
  exit 1
fi
if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud is required" >&2
  exit 1
fi

SERVICE_ACCOUNT_EMAIL="${SCHEDULER_SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
if ! gcloud iam service-accounts describe "${SERVICE_ACCOUNT_EMAIL}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${SCHEDULER_SERVICE_ACCOUNT_NAME}" \
    --project="${PROJECT_ID}" --display-name="Public profile discovery scheduler" >/dev/null
fi

URI="${BACKEND_URL}/api/internal/profile-discovery/drain"
COMMON_ARGS=(
  --project="${PROJECT_ID}" --location="${LOCATION}"
  --schedule="${CRON}" --time-zone="Etc/UTC"
  --uri="${URI}" --http-method=POST --message-body="{}"
  --oidc-service-account-email="${SERVICE_ACCOUNT_EMAIL}"
  --oidc-token-audience="${OIDC_AUDIENCE}"
  --attempt-deadline=240s --max-retry-attempts=3
  --min-backoff=10s --max-backoff=120s --max-doublings=3
)
if gcloud scheduler jobs describe "${JOB_NAME}" --project="${PROJECT_ID}" --location="${LOCATION}" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "${JOB_NAME}" "${COMMON_ARGS[@]}" --update-headers="Content-Type=application/json" >/dev/null
else
  gcloud scheduler jobs create http "${JOB_NAME}" "${COMMON_ARGS[@]}" --headers="Content-Type=application/json" >/dev/null
fi

EVIDENCE="$(gcloud scheduler jobs describe "${JOB_NAME}" --project="${PROJECT_ID}" --location="${LOCATION}" --format='value(state,schedule,httpTarget.uri,httpTarget.httpMethod,httpTarget.oidcToken.serviceAccountEmail,httpTarget.oidcToken.audience)')"
EXPECTED="ENABLED"$'\t'"${CRON}"$'\t'"${URI}"$'\t'"POST"$'\t'"${SERVICE_ACCOUNT_EMAIL}"$'\t'"${OIDC_AUDIENCE}"
if [[ "${EVIDENCE}" != "${EXPECTED}" ]]; then
  echo "Cloud Scheduler verification failed for ${JOB_NAME}" >&2
  exit 1
fi
echo "Configured and verified profile discovery worker ${JOB_NAME}: ${EVIDENCE} auth=oidc"
