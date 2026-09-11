#!/usr/bin/env bash
set -euo pipefail

# Configure the bounded One Location retention endpoint in UAT. This script is
# intentionally operator-run; landing it does not mutate Cloud Scheduler.

PROJECT_ID="${PROJECT_ID:-hushh-pda-uat}"
SCHEDULER_LOCATION="${SCHEDULER_LOCATION:-us-central1}"
BACKEND_URL="${BACKEND_URL:-}"
JOB_NAME="${JOB_NAME:-one-location-retention-purge-uat}"
CRON="${CRON:-17 * * * *}"
TIMEZONE="${TIMEZONE:-America/Los_Angeles}"
OLDER_THAN_HOURS="${OLDER_THAN_HOURS:-12}"

# The job authenticates with a per-invocation Google-signed OIDC token, not with a
# secret baked into its own configuration. What used to live here was the literal
# value of ONE_LOCATION_RETENTION_TOKEN, and `gcloud scheduler jobs describe` prints
# httpTarget.headers -- so anyone with scheduler view access could read a credential
# that authorises deleting records, it never rotated unless a human re-ran this
# script, and the identical header name on the KYC job meant one value opened both.
#
# Nothing below is a secret: a service-account email and an audience. The audience
# must equal ONE_LOCATION_RETENTION_AUDIENCE on the backend exactly -- it is
# configured on both sides from one value rather than inferred, because the job URI
# carries a query string and an inferred audience mismatches in a way that presents
# as an opaque 401 on a correctly configured job.
SCHEDULER_SERVICE_ACCOUNT="${SCHEDULER_SERVICE_ACCOUNT:-}"
OIDC_AUDIENCE="${OIDC_AUDIENCE:-${BACKEND_URL%/}}"

if [[ -z "${BACKEND_URL}" ]]; then
  echo "BACKEND_URL is required" >&2
  exit 1
fi

if [[ -z "${SCHEDULER_SERVICE_ACCOUNT}" ]]; then
  echo "SCHEDULER_SERVICE_ACCOUNT is required (the identity the job runs as)." >&2
  echo "It must be listed in ONE_LOCATION_RETENTION_SCHEDULER_SERVICE_ACCOUNTS" >&2
  echo "on the backend, and hold roles/run.invoker on the target service." >&2
  exit 1
fi

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud is required" >&2
  exit 1
fi

URI="${BACKEND_URL%/}/api/one/location/retention/purge?older_than_hours=${OLDER_THAN_HOURS}"

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

JOB_EVIDENCE="$(gcloud scheduler jobs describe "${JOB_NAME}" \
  --project="${PROJECT_ID}" \
  --location="${SCHEDULER_LOCATION}" \
  --format='value(state,schedule,httpTarget.uri)')"

EXPECTED_URI="${URI}"
if [[ "${JOB_EVIDENCE}" != ENABLED$'\t'"${CRON}"$'\t'"${EXPECTED_URI}" ]]; then
  echo "Cloud Scheduler verification failed for ${JOB_NAME}" >&2
  exit 1
fi

# Read back the identity that was actually configured. Asking gcloud to set OIDC is
# not the same as the job carrying it.
OIDC_EVIDENCE="$(gcloud scheduler jobs describe "${JOB_NAME}" \
  --project="${PROJECT_ID}" \
  --location="${SCHEDULER_LOCATION}" \
  --format='value(httpTarget.oidcToken.serviceAccountEmail)')"

if [[ "${OIDC_EVIDENCE}" != "${SCHEDULER_SERVICE_ACCOUNT}" ]]; then
  echo "Job ${JOB_NAME} is not authenticating as ${SCHEDULER_SERVICE_ACCOUNT}." >&2
  echo "Read back: '${OIDC_EVIDENCE}'" >&2
  exit 1
fi

# The point of this change is that the secret is GONE from the job, not merely that
# an OIDC token was added beside it. gcloud patches the headers map rather than
# replacing it, so a job created before this change can keep serving the old header
# indefinitely while every other check above passes.
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
