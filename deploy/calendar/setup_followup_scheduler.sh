#!/usr/bin/env bash
set -euo pipefail

# Idempotently configure the *UAT-only* Calendar email follow-ups drain job.
# The backend route answers 404 unless both CALENDAR_EMAIL_FOLLOWUPS and
# CALENDAR_EMAIL_FOLLOWUP_DRAIN_ENABLED are true, and it scans only accounts that
# opted in themselves, so landing this job never turns monitoring on for anyone.
# Production has no job. DRY_RUN=1 validates the inputs and prints the gcloud
# commands without calling gcloud.
#
# deploy/uat-surface-gates.txt, read from the commit being deployed, is the single
# source of truth: the same file sets the backend flags in backend-deploy.sh. Drain
# true creates or updates the job and resumes it if paused, so a manual pause is
# overwritten by the next backend deploy. Anything else (false, or no gate file)
# pauses an existing job and never creates one.

readonly UAT_PROJECT_ID="hushh-pda-uat"
readonly UAT_SCHEDULER_LOCATION="us-central1"
readonly UAT_JOB_NAME="calendar-email-followups-uat"
readonly UAT_CRON="* * * * *"
readonly UAT_TIMEZONE="Etc/UTC"
readonly UAT_SCHEDULER_SERVICE_ACCOUNT_NAME="calendar-email-followups"
# The scheduler mints a bearer token for its target. Keep that target to the
# reviewed UAT backend; accepting an arbitrary URL would turn this helper into
# an OIDC-token sender for an attacker-controlled host. The drain route verifies
# this audience and this service account's email.
readonly UAT_BACKEND_ORIGIN="https://api.uat.hushh.ai"

PROJECT_ID="${PROJECT_ID:-${UAT_PROJECT_ID}}"
SCHEDULER_LOCATION="${SCHEDULER_LOCATION:-${UAT_SCHEDULER_LOCATION}}"
BACKEND_URL="${BACKEND_URL:-}"
JOB_NAME="${JOB_NAME:-${UAT_JOB_NAME}}"
CRON="${CRON:-${UAT_CRON}}"
TIMEZONE="${TIMEZONE:-${UAT_TIMEZONE}}"
BATCH_LIMIT="${BATCH_LIMIT:-10}"
SCHEDULER_SERVICE_ACCOUNT_NAME="${SCHEDULER_SERVICE_ACCOUNT_NAME:-${UAT_SCHEDULER_SERVICE_ACCOUNT_NAME}}"
SCHEDULER_SERVICE_ACCOUNT_EMAIL="${SCHEDULER_SERVICE_ACCOUNT_EMAIL:-}"
OIDC_AUDIENCE="${OIDC_AUDIENCE:-}"
DRY_RUN="${DRY_RUN:-0}"

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
  echo "This helper only configures the reviewed UAT Calendar follow-ups job" >&2
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

# The drain route accepts limit 1 through 20.
if ! [[ "${BATCH_LIMIT}" =~ ^[1-9][0-9]?$ ]] || (( BATCH_LIMIT > 20 )); then
  echo "BATCH_LIMIT must be an integer from 1 through 20" >&2
  exit 1
fi

EXPECTED_SCHEDULER_SERVICE_ACCOUNT_EMAIL="${SCHEDULER_SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
if [[ -n "${SCHEDULER_SERVICE_ACCOUNT_EMAIL}" \
  && "${SCHEDULER_SERVICE_ACCOUNT_EMAIL}" != "${EXPECTED_SCHEDULER_SERVICE_ACCOUNT_EMAIL}" ]]; then
  echo "SCHEDULER_SERVICE_ACCOUNT_EMAIL must match SCHEDULER_SERVICE_ACCOUNT_NAME and PROJECT_ID" >&2
  exit 1
fi
SCHEDULER_SERVICE_ACCOUNT_EMAIL="${EXPECTED_SCHEDULER_SERVICE_ACCOUNT_EMAIL}"

# A malformed gate file stops here, before any gcloud call. No file means off.
DRAIN_ENABLED=0
if [[ -f deploy/uat-surface-gates.txt ]]; then
  gates="$(python3 "$(dirname "${BASH_SOURCE[0]}")/verify_followup_release.py" read-gates deploy/uat-surface-gates.txt)" || exit 1
  read -r _ drain_gate <<< "${gates}"
  [[ "${drain_gate}" != "true" ]] || DRAIN_ENABLED=1
fi

URI="${BACKEND_URL}/api/one/calendar/followups/drain?limit=${BATCH_LIMIT}"
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
  --max-retry-attempts=3
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
  echo "# calendar_email_followup_drain is not true: never create the job."
  echo "# Pause the job when it exists and is not already paused:"
  print_command gcloud scheduler jobs pause "${JOB_NAME}" \
    --project="${PROJECT_ID}" --location="${SCHEDULER_LOCATION}"
  exit 0
fi

if [[ "${DRY_RUN}" == "1" ]]; then
  echo "# DRY_RUN=1: no gcloud command runs."
  echo "# Create the scheduler identity if it is absent:"
  print_command gcloud iam service-accounts create "${SCHEDULER_SERVICE_ACCOUNT_NAME}" \
    --project="${PROJECT_ID}" --display-name="Calendar follow-ups scheduler"
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
    echo "Calendar follow-ups drain disabled; ${JOB_NAME} does not exist and was not created"
    exit 0
  fi
  if [[ "${STATE}" != "PAUSED" ]]; then
    gcloud scheduler jobs pause "${JOB_NAME}" \
      --project="${PROJECT_ID}" \
      --location="${SCHEDULER_LOCATION}" >/dev/null
  fi
  STATE="$(job_state)"
  if [[ "${STATE}" != "PAUSED" ]]; then
    echo "Calendar follow-ups drain kill switch failed: ${JOB_NAME} is ${STATE}, not PAUSED" >&2
    exit 1
  fi
  echo "Calendar follow-ups drain disabled; ${JOB_NAME} verified PAUSED"
  exit 0
fi

if ! gcloud iam service-accounts describe "${SCHEDULER_SERVICE_ACCOUNT_EMAIL}" \
  --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${SCHEDULER_SERVICE_ACCOUNT_NAME}" \
    --project="${PROJECT_ID}" \
    --display-name="Calendar follow-ups scheduler" >/dev/null
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

# The gate file, not a manual pause, decides whether the job runs.
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
# attempt is a bounded drain run: each scan reads only accounts that opted in,
# and each reminder's own ledger row and the owner's Feed entry say whether it
# was delivered.
echo "Configured and verified Calendar follow-ups drain ${JOB_NAME}: ${JOB_EVIDENCE} auth=oidc"
