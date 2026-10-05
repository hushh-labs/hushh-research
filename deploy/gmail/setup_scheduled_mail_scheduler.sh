#!/usr/bin/env bash
set -euo pipefail

# Idempotently configure the *UAT-only* scheduled-mail drain. Landing this
# script never sends mail or enables the drain: the backend route answers 404
# unless MAIL_SCHEDULED_DRAIN_ENABLED=true, and every send it fires was
# confirmed by the owner when they scheduled it. Production has no job.
# DRY_RUN=1 validates the inputs and prints the gcloud commands without
# calling gcloud.
#
# MAIL_SCHEDULED_DRAIN_ENABLED is the kill switch and the single source of
# truth for the job's state. The UAT deploy passes the same repository variable
# (vars.MAIL_SCHEDULED_DRAIN_ENABLED_UAT, default true) that opens the drain
# route. Exactly "true" creates or updates the job and resumes it if paused, so
# a manual pause is overwritten by the next deploy. Any other value pauses an
# existing job and never creates one.

readonly UAT_PROJECT_ID="hushh-pda-uat"
readonly UAT_SCHEDULER_LOCATION="us-central1"
readonly UAT_JOB_NAME="mail-scheduled-send-uat"
readonly UAT_CRON="* * * * *"
readonly UAT_TIMEZONE="Etc/UTC"
readonly UAT_SCHEDULER_SERVICE_ACCOUNT_NAME="mail-scheduled-send"
# The scheduler mints a bearer token for its target. Keep that target to the
# reviewed UAT backend; accepting an arbitrary URL would turn this helper into
# an OIDC-token sender for an attacker-controlled host.
readonly UAT_BACKEND_ORIGIN="https://api.uat.hushh.ai"

PROJECT_ID="${PROJECT_ID:-${UAT_PROJECT_ID}}"
SCHEDULER_LOCATION="${SCHEDULER_LOCATION:-${UAT_SCHEDULER_LOCATION}}"
BACKEND_URL="${BACKEND_URL:-}"
JOB_NAME="${JOB_NAME:-${UAT_JOB_NAME}}"
CRON="${CRON:-${UAT_CRON}}"
TIMEZONE="${TIMEZONE:-${UAT_TIMEZONE}}"
BATCH_LIMIT="${BATCH_LIMIT:-50}"
SCHEDULER_SERVICE_ACCOUNT_NAME="${SCHEDULER_SERVICE_ACCOUNT_NAME:-${UAT_SCHEDULER_SERVICE_ACCOUNT_NAME}}"
SCHEDULER_SERVICE_ACCOUNT_EMAIL="${SCHEDULER_SERVICE_ACCOUNT_EMAIL:-}"
OIDC_AUDIENCE="${OIDC_AUDIENCE:-}"
# Unset keeps this helper's historical behavior (configure the job); a value
# that is set, even empty, must be exactly "true" to run it.
MAIL_SCHEDULED_DRAIN_ENABLED="${MAIL_SCHEDULED_DRAIN_ENABLED-true}"
DRY_RUN="${DRY_RUN:-0}"
DRAIN_ENABLED=0
if [[ "${MAIL_SCHEDULED_DRAIN_ENABLED}" == "true" ]]; then
  DRAIN_ENABLED=1
fi

if [[ "${DRY_RUN}" != "0" && "${DRY_RUN}" != "1" ]]; then
  echo "DRY_RUN must be 0 or 1" >&2
  exit 1
fi

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
  echo "This helper only configures the reviewed UAT scheduled-mail job" >&2
  exit 1
fi

BACKEND_URL="${BACKEND_URL%/}"
OIDC_AUDIENCE="${OIDC_AUDIENCE%/}"
if [[ "${BACKEND_URL}" != https://* || "${OIDC_AUDIENCE}" != https://* ]]; then
  echo "BACKEND_URL and OIDC_AUDIENCE must use HTTPS" >&2
  exit 1
fi
if [[ "${BACKEND_URL}" != "${UAT_BACKEND_ORIGIN}" ]]; then
  echo "BACKEND_URL must be the reviewed UAT backend origin" >&2
  exit 1
fi
if [[ "${OIDC_AUDIENCE}" != "${BACKEND_URL}" ]]; then
  echo "OIDC_AUDIENCE must exactly match BACKEND_URL" >&2
  exit 1
fi

if ! [[ "${BATCH_LIMIT}" =~ ^[1-9][0-9]{0,2}$ ]] || (( BATCH_LIMIT > 100 )); then
  echo "BATCH_LIMIT must be an integer from 1 through 100" >&2
  exit 1
fi

EXPECTED_SCHEDULER_SERVICE_ACCOUNT_EMAIL="${SCHEDULER_SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
if [[ -n "${SCHEDULER_SERVICE_ACCOUNT_EMAIL}" \
  && "${SCHEDULER_SERVICE_ACCOUNT_EMAIL}" != "${EXPECTED_SCHEDULER_SERVICE_ACCOUNT_EMAIL}" ]]; then
  echo "SCHEDULER_SERVICE_ACCOUNT_EMAIL must match SCHEDULER_SERVICE_ACCOUNT_NAME and PROJECT_ID" >&2
  exit 1
fi
SCHEDULER_SERVICE_ACCOUNT_EMAIL="${EXPECTED_SCHEDULER_SERVICE_ACCOUNT_EMAIL}"

URI="${BACKEND_URL}/api/one/email/scheduled/drain?limit=${BATCH_LIMIT}"
COMMON_ARGS=(
  --project="${PROJECT_ID}"
  --location="${SCHEDULER_LOCATION}"
  --schedule="${CRON}"
  --time-zone="${TIMEZONE}"
  --uri="${URI}"
  --http-method=POST
  --oidc-service-account-email="${SCHEDULER_SERVICE_ACCOUNT_EMAIL}"
  --oidc-token-audience="${OIDC_AUDIENCE}"
  --attempt-deadline=300s
  --max-retry-attempts=5
  --min-backoff=10s
  --max-backoff=120s
  --max-doublings=3
)

print_command() {
  local arg
  printf '+'
  for arg in "$@"; do
    if [[ "${arg}" =~ ^[A-Za-z0-9_./:=@,+-]+$ ]]; then
      printf ' %s' "${arg}"
    else
      printf " '%s'" "${arg}"
    fi
  done
  printf '\n'
}

if [[ "${DRY_RUN}" == "1" && "${DRAIN_ENABLED}" == "0" ]]; then
  echo "# DRY_RUN=1: no gcloud command runs."
  echo "# MAIL_SCHEDULED_DRAIN_ENABLED is not true: never create the job."
  echo "# Pause the job when it exists and is not already paused:"
  print_command gcloud scheduler jobs pause "${JOB_NAME}" \
    --project="${PROJECT_ID}" --location="${SCHEDULER_LOCATION}"
  exit 0
fi

if [[ "${DRY_RUN}" == "1" ]]; then
  echo "# DRY_RUN=1: no gcloud command runs."
  echo "# Create the scheduler identity if it is absent:"
  print_command gcloud iam service-accounts create "${SCHEDULER_SERVICE_ACCOUNT_NAME}" \
    --project="${PROJECT_ID}" --display-name="Scheduled mail send scheduler"
  echo "# Update the job when it exists:"
  print_command gcloud scheduler jobs update http "${JOB_NAME}" "${COMMON_ARGS[@]}" \
    --update-headers="Content-Type=application/json"
  echo "# Otherwise create it:"
  print_command gcloud scheduler jobs create http "${JOB_NAME}" "${COMMON_ARGS[@]}" \
    --headers="Content-Type=application/json"
  echo "# Resume it when it is paused:"
  print_command gcloud scheduler jobs resume "${JOB_NAME}" \
    --project="${PROJECT_ID}" --location="${SCHEDULER_LOCATION}"
  exit 0
fi

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud is required" >&2
  exit 1
fi

job_state() {
  gcloud scheduler jobs describe "${JOB_NAME}" \
    --project="${PROJECT_ID}" \
    --location="${SCHEDULER_LOCATION}" \
    --format='value(state)'
}

if [[ "${DRAIN_ENABLED}" == "0" ]]; then
  if ! STATE="$(job_state 2>/dev/null)"; then
    echo "Scheduled-mail drain disabled; ${JOB_NAME} does not exist and was not created"
    exit 0
  fi
  if [[ "${STATE}" != "PAUSED" ]]; then
    gcloud scheduler jobs pause "${JOB_NAME}" \
      --project="${PROJECT_ID}" \
      --location="${SCHEDULER_LOCATION}" >/dev/null
  fi
  STATE="$(job_state)"
  if [[ "${STATE}" != "PAUSED" ]]; then
    echo "Scheduled-mail drain kill switch failed: ${JOB_NAME} is ${STATE}, not PAUSED" >&2
    exit 1
  fi
  echo "Scheduled-mail drain disabled; ${JOB_NAME} verified PAUSED"
  exit 0
fi

if ! gcloud iam service-accounts describe "${SCHEDULER_SERVICE_ACCOUNT_EMAIL}" \
  --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${SCHEDULER_SERVICE_ACCOUNT_NAME}" \
    --project="${PROJECT_ID}" \
    --display-name="Scheduled mail send scheduler" >/dev/null
fi

# Cloud Scheduler's Google-managed service agent receives the project-scoped
# roles/cloudscheduler.serviceAgent grant when the API is enabled, which lets
# it mint an OIDC token for this client identity. Do not modify the client
# account policy here: the deployer needs actAs to attach it, but a harmless
# scheduler repair must not require service-account policy-admin privileges.

if gcloud scheduler jobs describe "${JOB_NAME}" \
  --project="${PROJECT_ID}" \
  --location="${SCHEDULER_LOCATION}" >/dev/null 2>&1; then
  # The update command preserves existing headers and uses a different flag
  # from create. Keep command-specific flags out of the shared arguments.
  gcloud scheduler jobs update http "${JOB_NAME}" "${COMMON_ARGS[@]}" \
    --update-headers="Content-Type=application/json" >/dev/null
else
  gcloud scheduler jobs create http "${JOB_NAME}" "${COMMON_ARGS[@]}" \
    --headers="Content-Type=application/json" >/dev/null
fi

# The repository variable, not a manual pause, decides whether the job runs.
if [[ "$(job_state)" == "PAUSED" ]]; then
  gcloud scheduler jobs resume "${JOB_NAME}" \
    --project="${PROJECT_ID}" \
    --location="${SCHEDULER_LOCATION}" >/dev/null
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

# The job stores only a service-account identity and audience. A successful
# attempt is a bounded drain run; each email's own ledger row and the owner's
# notification say whether it was sent.
echo "Configured and verified scheduled-mail drain ${JOB_NAME}: ${JOB_EVIDENCE} auth=oidc"
