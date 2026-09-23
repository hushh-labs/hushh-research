#!/usr/bin/env bash
set -euo pipefail

# Idempotently configure the *UAT-only* bounded Drive workflow sweep. Landing
# this script or the API route never enables a feature, grants document access,
# or proves a person/device received a notification. It only gives Cloud
# Scheduler an OIDC-authenticated way to invoke the finite operational drain.

readonly UAT_PROJECT_ID="hushh-pda-uat"
readonly UAT_SCHEDULER_LOCATION="us-central1"
readonly UAT_JOB_NAME="drive-work-drain-uat"
readonly UAT_CRON="*/2 * * * *"
readonly UAT_TIMEZONE="Etc/UTC"
readonly UAT_SCHEDULER_SERVICE_ACCOUNT_NAME="drive-work-drain-sched"
# The scheduler can mint a bearer token for its target. Keep that target to
# the two reviewed UAT backend origins; accepting an arbitrary HTTPS URL would
# turn this helper into an OIDC-token sender for an attacker-controlled host.
readonly UAT_PUBLIC_BACKEND_ORIGIN="https://api.uat.hushh.ai"
readonly UAT_RUNTIME_BACKEND_ORIGIN="https://consent-protocol-f2gsa4kfsq-uc.a.run.app"

PROJECT_ID="${PROJECT_ID:-${UAT_PROJECT_ID}}"
SCHEDULER_LOCATION="${SCHEDULER_LOCATION:-${UAT_SCHEDULER_LOCATION}}"
BACKEND_URL="${BACKEND_URL:-}"
JOB_NAME="${JOB_NAME:-${UAT_JOB_NAME}}"
CRON="${CRON:-${UAT_CRON}}"
TIMEZONE="${TIMEZONE:-${UAT_TIMEZONE}}"
SCHEDULER_SERVICE_ACCOUNT_NAME="${SCHEDULER_SERVICE_ACCOUNT_NAME:-${UAT_SCHEDULER_SERVICE_ACCOUNT_NAME}}"
SCHEDULER_SERVICE_ACCOUNT_EMAIL="${SCHEDULER_SERVICE_ACCOUNT_EMAIL:-}"
OIDC_AUDIENCE="${OIDC_AUDIENCE:-}"

if [[ -z "${BACKEND_URL}" || -z "${OIDC_AUDIENCE}" ]]; then
  echo "BACKEND_URL and OIDC_AUDIENCE are required" >&2
  exit 1
fi

if [[ "${PROJECT_ID}" != "${UAT_PROJECT_ID}" ]]; then
  echo "This scheduler helper is limited to ${UAT_PROJECT_ID}" >&2
  exit 1
fi

if [[ "${SCHEDULER_LOCATION}" != "${UAT_SCHEDULER_LOCATION}" \
  || "${JOB_NAME}" != "${UAT_JOB_NAME}" \
  || "${CRON}" != "${UAT_CRON}" \
  || "${TIMEZONE}" != "${UAT_TIMEZONE}" \
  || "${SCHEDULER_SERVICE_ACCOUNT_NAME}" != "${UAT_SCHEDULER_SERVICE_ACCOUNT_NAME}" ]]; then
  echo "This helper only configures the reviewed UAT Drive work-drain job" >&2
  exit 1
fi

BACKEND_URL="${BACKEND_URL%/}"
OIDC_AUDIENCE="${OIDC_AUDIENCE%/}"
if [[ "${BACKEND_URL}" != https://* || "${OIDC_AUDIENCE}" != https://* ]]; then
  echo "BACKEND_URL and OIDC_AUDIENCE must use HTTPS" >&2
  exit 1
fi
if [[ "${BACKEND_URL}" != "${OIDC_AUDIENCE}" ]]; then
  echo "OIDC_AUDIENCE must exactly match BACKEND_URL" >&2
  exit 1
fi
case "${BACKEND_URL}" in
  "${UAT_PUBLIC_BACKEND_ORIGIN}"|"${UAT_RUNTIME_BACKEND_ORIGIN}") ;;
  *)
    echo "BACKEND_URL must be an approved UAT backend origin" >&2
    exit 1
    ;;
esac

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
    --display-name="Drive work drain scheduler" >/dev/null
fi

# Cloud Scheduler's Google-managed service agent receives the project-scoped
# roles/cloudscheduler.serviceAgent grant when the API is enabled, which lets
# it mint an OIDC token for this client identity. Do not modify the client
# account policy here: the deployer needs actAs to attach it, but a harmless
# scheduler repair must not require service-account policy-admin privileges.

URI="${BACKEND_URL%/}/api/internal/drive-work/drain"
COMMON_ARGS=(
  --project="${PROJECT_ID}"
  --location="${SCHEDULER_LOCATION}"
  --schedule="${CRON}"
  --time-zone="${TIMEZONE}"
  --uri="${URI}"
  --http-method=POST
  --message-body='{}'
  --oidc-service-account-email="${SCHEDULER_SERVICE_ACCOUNT_EMAIL}"
  --oidc-token-audience="${OIDC_AUDIENCE}"
  --attempt-deadline=120s
  --max-retry-attempts=3
  --min-backoff=10s
  --max-backoff=120s
  --max-doublings=3
)

if gcloud scheduler jobs describe "${JOB_NAME}" \
  --project="${PROJECT_ID}" \
  --location="${SCHEDULER_LOCATION}" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "${JOB_NAME}" "${COMMON_ARGS[@]}" \
    --update-headers="Content-Type=application/json" >/dev/null
else
  gcloud scheduler jobs create http "${JOB_NAME}" "${COMMON_ARGS[@]}" \
    --headers="Content-Type=application/json" >/dev/null
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
# background work; a successful attempt never means a person saw a prompt or
# approved/received a document.
echo "Configured and verified Drive work drain ${JOB_NAME}: ${JOB_EVIDENCE} auth=oidc"
