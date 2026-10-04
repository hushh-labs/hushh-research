#!/usr/bin/env bash
set -euo pipefail

# Idempotently configure the *UAT-only* bounded referral-scoring queue drain.
# Landing this script or the API route never awards points, never enables
# real prize processing, and never proves a person was scored -- it only
# gives Cloud Scheduler an OIDC-authenticated way to invoke the finite
# operational drain at /api/internal/referral-scoring/drain.
#
# Mirrors deploy/drive/setup_work_drain_scheduler.sh's shape and safety
# checks exactly, scoped to this queue's own job name, service account, and
# the single backend origin it targets (there is no separate dedicated
# worker service for this queue the way Drive has one).

readonly UAT_PROJECT_ID="hushh-pda-uat"
readonly UAT_SCHEDULER_LOCATION="us-central1"
readonly UAT_JOB_NAME="referral-scoring-drain-uat"
readonly UAT_CRON="*/2 * * * *"
readonly UAT_TIMEZONE="Etc/UTC"
readonly UAT_SCHEDULER_SERVICE_ACCOUNT_NAME="referral-scoring-sched"
readonly UAT_PUBLIC_BACKEND_ORIGIN="https://api.uat.hushh.ai"

PROJECT_ID="${PROJECT_ID:-${UAT_PROJECT_ID}}"
SCHEDULER_LOCATION="${SCHEDULER_LOCATION:-${UAT_SCHEDULER_LOCATION}}"
JOB_NAME="${JOB_NAME:-${UAT_JOB_NAME}}"
CRON="${CRON:-${UAT_CRON}}"
TIMEZONE="${TIMEZONE:-${UAT_TIMEZONE}}"
SCHEDULER_SERVICE_ACCOUNT_NAME="${SCHEDULER_SERVICE_ACCOUNT_NAME:-${UAT_SCHEDULER_SERVICE_ACCOUNT_NAME}}"
SCHEDULER_SERVICE_ACCOUNT_EMAIL="${SCHEDULER_SERVICE_ACCOUNT_EMAIL:-}"
BACKEND_URL="${BACKEND_URL:-${UAT_PUBLIC_BACKEND_ORIGIN}}"
OIDC_AUDIENCE="${OIDC_AUDIENCE:-${UAT_PUBLIC_BACKEND_ORIGIN}}"

if [[ "${PROJECT_ID}" != "${UAT_PROJECT_ID}" ]]; then
  echo "This scheduler helper is limited to ${UAT_PROJECT_ID}" >&2
  exit 1
fi
if [[ "${SCHEDULER_LOCATION}" != "${UAT_SCHEDULER_LOCATION}" \
  || "${JOB_NAME}" != "${UAT_JOB_NAME}" \
  || "${CRON}" != "${UAT_CRON}" \
  || "${TIMEZONE}" != "${UAT_TIMEZONE}" \
  || "${SCHEDULER_SERVICE_ACCOUNT_NAME}" != "${UAT_SCHEDULER_SERVICE_ACCOUNT_NAME}" ]]; then
  echo "This helper only configures the reviewed UAT referral-scoring drain job" >&2
  exit 1
fi

BACKEND_URL="${BACKEND_URL%/}"
OIDC_AUDIENCE="${OIDC_AUDIENCE%/}"
if [[ "${BACKEND_URL}" != "${UAT_PUBLIC_BACKEND_ORIGIN}" || "${OIDC_AUDIENCE}" != "${UAT_PUBLIC_BACKEND_ORIGIN}" ]]; then
  echo "BACKEND_URL and OIDC_AUDIENCE must both be ${UAT_PUBLIC_BACKEND_ORIGIN}" >&2
  exit 1
fi

EXPECTED_SCHEDULER_SERVICE_ACCOUNT_EMAIL="${SCHEDULER_SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
if [[ -n "${SCHEDULER_SERVICE_ACCOUNT_EMAIL}" \
  && "${SCHEDULER_SERVICE_ACCOUNT_EMAIL}" != "${EXPECTED_SCHEDULER_SERVICE_ACCOUNT_EMAIL}" ]]; then
  echo "SCHEDULER_SERVICE_ACCOUNT_EMAIL must match SCHEDULER_SERVICE_ACCOUNT_NAME and PROJECT_ID" >&2
  exit 1
fi
SCHEDULER_SERVICE_ACCOUNT_EMAIL="${EXPECTED_SCHEDULER_SERVICE_ACCOUNT_EMAIL}"

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud is required" >&2
  exit 1
fi

if ! gcloud iam service-accounts describe "${SCHEDULER_SERVICE_ACCOUNT_EMAIL}" \
  --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${SCHEDULER_SERVICE_ACCOUNT_NAME}" \
    --project="${PROJECT_ID}" \
    --display-name="Referral scoring drain scheduler" >/dev/null
fi

# Cloud Scheduler's Google-managed service agent receives the project-scoped
# roles/cloudscheduler.serviceAgent grant when the API is enabled, which lets
# it mint an OIDC token for this client identity. Do not modify the client
# account policy here: the deployer needs actAs to attach it, but a harmless
# scheduler repair must not require service-account policy-admin privileges.

URI="${BACKEND_URL}/api/internal/referral-scoring/drain"
COMMON_ARGS=(
  --project="${PROJECT_ID}"
  --location="${SCHEDULER_LOCATION}"
  --schedule="${CRON}"
  --time-zone="${TIMEZONE}"
  --uri="${URI}"
  --http-method=POST
  --oidc-service-account-email="${SCHEDULER_SERVICE_ACCOUNT_EMAIL}"
  --oidc-token-audience="${OIDC_AUDIENCE}"
  --attempt-deadline=60s
  --max-retry-attempts=3
  --min-backoff=10s
  --max-backoff=120s
  --max-doublings=3
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
EXPECTED="ENABLED"$'\t'"${CRON}"$'\t'"${URI}"$'\t'"POST"$'\t'"${SCHEDULER_SERVICE_ACCOUNT_EMAIL}"$'\t'"${OIDC_AUDIENCE}"
if [[ "${JOB_EVIDENCE}" != "${EXPECTED}" ]]; then
  echo "Cloud Scheduler verification failed for ${JOB_NAME}" >&2
  exit 1
fi

# The job stores only a service-account identity and audience. It dispatches
# a bounded background drain; a successful attempt never means any specific
# relationship was scored or any prize was awarded.
echo "Configured and verified referral scoring drain ${JOB_NAME}: ${JOB_EVIDENCE} auth=oidc"
