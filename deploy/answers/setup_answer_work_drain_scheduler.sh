#!/usr/bin/env bash
set -euo pipefail

# Idempotently configure the bounded paid-answer settlement sweep.
#
# This lane is deliberately NOT part of the Drive work drain. It has its own
# scheduler jobs, its own client service account and its own enablement flag,
# so a Drive incident cannot stall an answer refund and pausing this lane
# cannot stall Drive sharing.
#
# Landing this script or the API route never enables the feature and never
# moves money. The route stays unreachable unless ANSWER_WORK_DRAIN_ENABLED is
# true on the backend. Workers can continue settling obligations while new
# payment admission is paused. This only gives Cloud Scheduler
# an OIDC-authenticated way to invoke the finite operational drain.
#
# Three stages, three jobs, so a slow provider on one cannot consume another's
# budget:
#
#   STAGE=timeouts  expire answers past their quoted deadline and file refunds
#   STAGE=refunds   dispatch and retry filed refunds
#   STAGE=payouts   transfer delivered answers' earnings to the owner
#
# Usage (one invocation per stage):
#   ANSWER_WORK_DRAIN_ENABLED=true BACKEND_URL=https://api.uat.hushh.ai STAGE=refunds \
#     JOB_NAME=answer-work-refunds-uat bash deploy/answers/setup_answer_work_drain_scheduler.sh

readonly UAT_PROJECT_ID="hushh-pda-uat"
readonly UAT_SCHEDULER_LOCATION="us-central1"
readonly UAT_CRON="*/5 * * * *"
readonly UAT_TIMEZONE="Etc/UTC"
# Its own identity, not Drive's. A compromised or paused Drive scheduler must
# not be able to drive money movement on this lane.
readonly UAT_SCHEDULER_SERVICE_ACCOUNT_NAME="answer-work-drain-sched"
# The scheduler can mint a bearer token for its target, so the target is
# pinned to the reviewed UAT backend. An arbitrary URL would turn this helper
# into an OIDC-token sender for an attacker-controlled host.
readonly UAT_PUBLIC_BACKEND_ORIGIN="https://api.uat.hushh.ai"

ENVIRONMENT="${ENVIRONMENT:-uat}"
case "${ENVIRONMENT}" in
  uat) EXPECTED_PROJECT="hushh-pda-uat"; EXPECTED_ORIGIN="https://api.uat.hushh.ai" ;;
  production) EXPECTED_PROJECT="hushh-pda"; EXPECTED_ORIGIN="https://api.hushh.ai" ;;
  *) echo "ENVIRONMENT must be uat or production" >&2; exit 1 ;;
esac
PROJECT_ID="${PROJECT_ID:-${EXPECTED_PROJECT}}"
SCHEDULER_LOCATION="${SCHEDULER_LOCATION:-${UAT_SCHEDULER_LOCATION}}"
BACKEND_URL="${BACKEND_URL:-}"
STAGE="${STAGE:-timeouts}"
JOB_NAME="${JOB_NAME:-answer-work-${STAGE}-${ENVIRONMENT}}"
CRON="${CRON:-${UAT_CRON}}"
TIMEZONE="${TIMEZONE:-${UAT_TIMEZONE}}"
ANSWER_WORK_DRAIN_ENABLED="${ANSWER_WORK_DRAIN_ENABLED:-false}"
case "${ANSWER_WORK_DRAIN_ENABLED}" in
  true|false) ;;
  *) echo "ANSWER_WORK_DRAIN_ENABLED must be true or false" >&2; exit 1 ;;
esac
SCHEDULER_SERVICE_ACCOUNT_NAME="${SCHEDULER_SERVICE_ACCOUNT_NAME:-${UAT_SCHEDULER_SERVICE_ACCOUNT_NAME}}"
OIDC_AUDIENCE="${EXPECTED_ORIGIN}"

case "${STAGE}" in
  timeouts|refunds|payouts) ;;
  *)
    echo "STAGE must be timeouts, refunds or payouts" >&2
    exit 1
    ;;
esac

if [[ "${PROJECT_ID}" != "${EXPECTED_PROJECT}" ]]; then
  echo "Project must match the selected environment" >&2
  exit 1
fi
if [[ "${BACKEND_URL%/}" != "${EXPECTED_ORIGIN}" ]]; then
  echo "BACKEND_URL must be ${EXPECTED_ORIGIN}" >&2
  exit 1
fi
if [[ "${SCHEDULER_SERVICE_ACCOUNT_NAME}" != "${UAT_SCHEDULER_SERVICE_ACCOUNT_NAME}" || "${JOB_NAME}" != "answer-work-${STAGE}-${ENVIRONMENT}" ]]; then
  echo "Answer settlement requires its own pinned job and service-account identity" >&2
  exit 1
fi

SCHEDULER_SERVICE_ACCOUNT_EMAIL="${SCHEDULER_SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud is required" >&2
  exit 1
fi

describe_resource() {
  local output
  if output="$(gcloud "$@" 2>&1)"; then
    printf '%s' "$output"
  elif [[ "$output" == *NOT_FOUND* || "$output" == *"not found"* ]]; then
    return 1
  else
    echo "Cannot verify the existing answer scheduler resource" >&2
    return 2
  fi
}

JOB_EXISTS=false
if JOB_STATE="$(describe_resource scheduler jobs describe "${JOB_NAME}" \
  --project="${PROJECT_ID}" --location="${SCHEDULER_LOCATION}" --format='value(state)')"; then
  JOB_EXISTS=true
else
  result=$?
  if [[ "$result" != 1 ]]; then exit "$result"; fi
fi

if [[ "${ANSWER_WORK_DRAIN_ENABLED}" != true ]]; then
  if [[ "${JOB_EXISTS}" == true ]]; then
    if [[ "${JOB_STATE}" != PAUSED ]]; then
      gcloud scheduler jobs pause "${JOB_NAME}" --project="${PROJECT_ID}" --location="${SCHEDULER_LOCATION}" >/dev/null
    fi
    JOB_STATE="$(describe_resource scheduler jobs describe "${JOB_NAME}" \
      --project="${PROJECT_ID}" --location="${SCHEDULER_LOCATION}" --format='value(state)')"
    if [[ "$JOB_STATE" != PAUSED ]]; then echo "Answer scheduler pause was not verified" >&2; exit 1; fi
  fi
  echo "Answer settlement scheduling disabled; ${JOB_NAME} is absent or paused."
  exit 0
fi

created_identity=false
if describe_resource iam service-accounts describe "${SCHEDULER_SERVICE_ACCOUNT_EMAIL}" \
  --project="${PROJECT_ID}" >/dev/null; then
  :
else
  result=$?
  if [[ "$result" != 1 ]]; then exit "$result"; fi
  gcloud iam service-accounts create "${SCHEDULER_SERVICE_ACCOUNT_NAME}" \
    --project="${PROJECT_ID}" \
    --display-name="Paid answer work drain scheduler" >/dev/null
  created_identity=true
fi

# The stage travels in the query string because the route reads it there and
# caps the body at 64 bytes; the body stays empty so a job cannot smuggle
# parameters past that cap.
URI="${BACKEND_URL%/}/api/internal/answer-work/drain?stage=${STAGE}"
COMMON_ARGS=(
  --project="${PROJECT_ID}"
  --location="${SCHEDULER_LOCATION}"
  --schedule="${CRON}"
  --time-zone="${TIMEZONE}"
  --uri="${URI}"
  --http-method=POST
  --oidc-service-account-email="${SCHEDULER_SERVICE_ACCOUNT_EMAIL}"
  --oidc-token-audience="${OIDC_AUDIENCE}"
  --attempt-deadline=180s
  --max-retry-attempts=3
  --min-backoff=10s
  --max-backoff=120s
  --max-doublings=3
)

if [[ "${JOB_EXISTS}" == true ]]; then
  gcloud scheduler jobs update http "${JOB_NAME}" "${COMMON_ARGS[@]}" >/dev/null
else
  for attempt in 0 1 2 3 4 5 6 7; do
    if create_error="$(gcloud scheduler jobs create http "${JOB_NAME}" "${COMMON_ARGS[@]}" 2>&1 >/dev/null)"; then
      break
    else
      create_status=$?
    fi
    if [[ "${created_identity}" != true || "${attempt}" == 7 \
      || "${create_error}" != "ERROR: (gcloud.scheduler.jobs.create.http) NOT_FOUND:"* ]]; then
      printf '%s\n' "${create_error}" >&2
      exit "${create_status}"
    fi
    sleep "$((1 << attempt))"
  done
fi

if [[ "${JOB_STATE}" == PAUSED ]]; then
  gcloud scheduler jobs resume "${JOB_NAME}" --project="${PROJECT_ID}" --location="${SCHEDULER_LOCATION}" >/dev/null
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

# The job stores only a service-account identity and an audience. A successful
# attempt means a bounded sweep ran; it never means a refund settled or an
# owner was paid -- those are database states, reconciled on the next sweep.
echo "Configured and verified answer work drain ${JOB_NAME}: stage=${STAGE} ${JOB_EVIDENCE} auth=oidc"
