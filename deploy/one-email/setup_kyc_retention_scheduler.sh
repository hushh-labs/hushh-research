#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-hushh-pda-uat}"
SCHEDULER_LOCATION="${SCHEDULER_LOCATION:-us-central1}"
BACKEND_URL="${BACKEND_URL:-}"
JOB_NAME="${JOB_NAME:-one-email-kyc-retention-purge-uat}"
CRON="${CRON:-37 9 * * *}"
TIMEZONE="${TIMEZONE:-America/Los_Angeles}"
OLDER_THAN_DAYS="${OLDER_THAN_DAYS:-30}"

# Authenticates with a per-invocation Google-signed OIDC token rather than a secret
# baked into the job. This job and the One Location purge job previously carried the
# SAME `X-Hushh-Maintenance-Token` header name, so one value lifted from either job
# authorised both endpoints. An OIDC token's `aud` claim binds it to one audience,
# which is the property a shared header cannot have at any secret length.
#
# Neither value below is a secret. The audience must equal
# ONE_EMAIL_WATCH_RENEW_AUDIENCE on the backend exactly; it is configured on both
# sides rather than inferred, because the job URI carries a query string and an
# inferred audience mismatches as an opaque 401 on a correct job.
SCHEDULER_SERVICE_ACCOUNT="${SCHEDULER_SERVICE_ACCOUNT:-}"
OIDC_AUDIENCE="${OIDC_AUDIENCE:-${BACKEND_URL%/}}"

if [[ -z "${BACKEND_URL}" ]]; then
  echo "BACKEND_URL is required, for example https://consent-protocol-...run.app" >&2
  exit 1
fi

if [[ -z "${SCHEDULER_SERVICE_ACCOUNT}" ]]; then
  echo "SCHEDULER_SERVICE_ACCOUNT is required (the identity the job runs as)." >&2
  echo "It must be listed in ONE_EMAIL_WATCH_RENEW_SCHEDULER_SERVICE_ACCOUNTS" >&2
  echo "on the backend, and hold roles/run.invoker on the target service." >&2
  exit 1
fi

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud is required" >&2
  exit 1
fi

URI="${BACKEND_URL%/}/api/one/kyc/retention/purge?older_than_days=${OLDER_THAN_DAYS}"

COMMON_ARGS=(
  --project="${PROJECT_ID}"
  --location="${SCHEDULER_LOCATION}"
  --schedule="${CRON}"
  --time-zone="${TIMEZONE}"
  --uri="${URI}"
  --http-method=POST
  --headers="Content-Type=application/json"
  --oidc-service-account-email="${SCHEDULER_SERVICE_ACCOUNT}"
  --oidc-token-audience="${OIDC_AUDIENCE}"
  --attempt-deadline=300s
)

if gcloud scheduler jobs describe "${JOB_NAME}" \
  --project="${PROJECT_ID}" \
  --location="${SCHEDULER_LOCATION}" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "${JOB_NAME}" "${COMMON_ARGS[@]}" >/dev/null
else
  gcloud scheduler jobs create http "${JOB_NAME}" "${COMMON_ARGS[@]}" >/dev/null
fi

# This script previously ended at "Configured ..." having verified nothing. Asking
# gcloud to configure a job is not evidence the job is configured.
JOB_EVIDENCE="$(gcloud scheduler jobs describe "${JOB_NAME}" \
  --project="${PROJECT_ID}" \
  --location="${SCHEDULER_LOCATION}" \
  --format='value(state,schedule,httpTarget.uri)')"

if [[ "${JOB_EVIDENCE}" != ENABLED$'\t'"${CRON}"$'\t'"${URI}" ]]; then
  echo "Cloud Scheduler verification failed for ${JOB_NAME}: ${JOB_EVIDENCE}" >&2
  exit 1
fi

OIDC_EVIDENCE="$(gcloud scheduler jobs describe "${JOB_NAME}" \
  --project="${PROJECT_ID}" \
  --location="${SCHEDULER_LOCATION}" \
  --format='value(httpTarget.oidcToken.serviceAccountEmail)')"

if [[ "${OIDC_EVIDENCE}" != "${SCHEDULER_SERVICE_ACCOUNT}" ]]; then
  echo "Job ${JOB_NAME} is not authenticating as ${SCHEDULER_SERVICE_ACCOUNT}." >&2
  echo "Read back: '${OIDC_EVIDENCE}'" >&2
  exit 1
fi

# gcloud patches the headers map rather than replacing it, so a job created before
# this change can keep serving the old secret while every check above passes.
HEADER_EVIDENCE="$(gcloud scheduler jobs describe "${JOB_NAME}" \
  --project="${PROJECT_ID}" \
  --location="${SCHEDULER_LOCATION}" \
  --format='value(httpTarget.headers)')"

if [[ "${HEADER_EVIDENCE}" == *"X-Hushh-Maintenance-Token"* ]]; then
  echo "Job ${JOB_NAME} still carries the X-Hushh-Maintenance-Token header." >&2
  echo "The secret remains readable to anyone with scheduler view access." >&2
  echo "Delete and re-create the job to drop it:" >&2
  echo "  gcloud scheduler jobs delete ${JOB_NAME} \\" >&2
  echo "    --project=${PROJECT_ID} --location=${SCHEDULER_LOCATION} --quiet" >&2
  echo "  then re-run this script." >&2
  exit 1
fi

echo "Configured and verified Cloud Scheduler job ${JOB_NAME}: ${JOB_EVIDENCE}"
echo "Authenticating as ${OIDC_EVIDENCE} with audience ${OIDC_AUDIENCE}; no baked token."
