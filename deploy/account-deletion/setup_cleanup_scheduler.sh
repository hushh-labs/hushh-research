#!/usr/bin/env bash
set -euo pipefail

# Idempotently configure the durable Firebase cleanup drain. The governed UAT
# workflow invokes this only after its candidate has passed release
# classification; operators may also use it for a bounded repair. Landing the
# code alone does not mutate IAM or Scheduler.

PROJECT_ID="${PROJECT_ID:-hushh-pda-uat}"
SCHEDULER_LOCATION="${SCHEDULER_LOCATION:-us-central1}"
BACKEND_URL="${BACKEND_URL:-}"
JOB_NAME="${JOB_NAME:-account-deletion-cleanup-uat}"
CRON="${CRON:-*/2 * * * *}"
TIMEZONE="${TIMEZONE:-Etc/UTC}"
BATCH_LIMIT="${BATCH_LIMIT:-10}"
SCHEDULER_SERVICE_ACCOUNT_NAME="${SCHEDULER_SERVICE_ACCOUNT_NAME:-account-deletion-cleanup}"
SCHEDULER_SERVICE_ACCOUNT_EMAIL="${SCHEDULER_SERVICE_ACCOUNT_EMAIL:-}"
OIDC_AUDIENCE="${OIDC_AUDIENCE:-${BACKEND_URL%/}}"

if [[ -z "${BACKEND_URL}" ]]; then
  echo "BACKEND_URL is required" >&2
  exit 1
fi

if (( ${#SCHEDULER_SERVICE_ACCOUNT_NAME} < 6 || ${#SCHEDULER_SERVICE_ACCOUNT_NAME} > 30 )) \
  || ! [[ "${SCHEDULER_SERVICE_ACCOUNT_NAME}" =~ ^[a-z][a-z0-9-]*[a-z0-9]$ ]]; then
  echo "SCHEDULER_SERVICE_ACCOUNT_NAME must be a valid 6-30 character Google service-account ID" >&2
  exit 1
fi

EXPECTED_SCHEDULER_SERVICE_ACCOUNT_EMAIL="${SCHEDULER_SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
if [[ -n "${SCHEDULER_SERVICE_ACCOUNT_EMAIL}" \
  && "${SCHEDULER_SERVICE_ACCOUNT_EMAIL}" != "${EXPECTED_SCHEDULER_SERVICE_ACCOUNT_EMAIL}" ]]; then
  echo "SCHEDULER_SERVICE_ACCOUNT_EMAIL must match SCHEDULER_SERVICE_ACCOUNT_NAME and PROJECT_ID" >&2
  exit 1
fi

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud is required" >&2
  exit 1
fi

if ! [[ "${BATCH_LIMIT}" =~ ^[1-9][0-9]{0,2}$ ]] || (( BATCH_LIMIT > 100 )); then
  echo "BATCH_LIMIT must be an integer from 1 through 100" >&2
  exit 1
fi

if [[ -z "${SCHEDULER_SERVICE_ACCOUNT_EMAIL}" ]]; then
  SCHEDULER_SERVICE_ACCOUNT_EMAIL="${EXPECTED_SCHEDULER_SERVICE_ACCOUNT_EMAIL}"
fi

if ! gcloud iam service-accounts describe "${SCHEDULER_SERVICE_ACCOUNT_EMAIL}" \
  --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${SCHEDULER_SERVICE_ACCOUNT_NAME}" \
    --project="${PROJECT_ID}" \
    --display-name="Account deletion cleanup scheduler" >/dev/null
fi

# Cloud Scheduler's Google-managed service agent receives the project-scoped
# roles/cloudscheduler.serviceAgent grant when the API is enabled. That role is
# what lets Scheduler mint an OIDC token for this client service account. Do not
# mutate the client account's IAM policy during an application deployment: it is
# unnecessary, requires broad iam.serviceAccounts.setIamPolicy permission, and
# would make every otherwise-safe scheduler repair depend on IAM-admin access.

URI="${BACKEND_URL%/}/api/account/deletion-cleanup/drain?limit=${BATCH_LIMIT}"
COMMON_ARGS=(
  --project="${PROJECT_ID}"
  --location="${SCHEDULER_LOCATION}"
  --schedule="${CRON}"
  --time-zone="${TIMEZONE}"
  --uri="${URI}"
  --http-method=POST
  --headers="Content-Type=application/json"
  --oidc-service-account-email="${SCHEDULER_SERVICE_ACCOUNT_EMAIL}"
  --oidc-token-audience="${OIDC_AUDIENCE}"
  --attempt-deadline=300s
  --max-retry-attempts=5
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

# The job stores only a service-account identity and audience. No reusable
# credential is present in Scheduler metadata, shell argv, or evidence.
echo "Configured and verified Cloud Scheduler job ${JOB_NAME}: ${JOB_EVIDENCE} auth=oidc"
