#!/usr/bin/env bash
set -euo pipefail

# Idempotently configure the *UAT-only* bounded paid-answer settlement sweep.
#
# This lane is deliberately NOT part of the Drive work drain. It has its own
# scheduler jobs, its own client service account and its own enablement flag,
# so a Drive incident cannot stall an answer refund and pausing this lane
# cannot stall Drive sharing.
#
# Landing this script or the API route never enables the feature and never
# moves money. The route stays unreachable unless ANSWER_WORK_DRAIN_ENABLED is
# true on the backend, and every worker short-circuits unless
# PKM_ANSWER_PAYMENTS_ENABLED is true as well. This only gives Cloud Scheduler
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
#   BACKEND_URL=https://api.uat.hushh.ai STAGE=refunds \
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

PROJECT_ID="${PROJECT_ID:-${UAT_PROJECT_ID}}"
SCHEDULER_LOCATION="${SCHEDULER_LOCATION:-${UAT_SCHEDULER_LOCATION}}"
BACKEND_URL="${BACKEND_URL:-}"
STAGE="${STAGE:-timeouts}"
JOB_NAME="${JOB_NAME:-answer-work-${STAGE}-uat}"
CRON="${CRON:-${UAT_CRON}}"
TIMEZONE="${TIMEZONE:-${UAT_TIMEZONE}}"
SCHEDULER_SERVICE_ACCOUNT_NAME="${SCHEDULER_SERVICE_ACCOUNT_NAME:-${UAT_SCHEDULER_SERVICE_ACCOUNT_NAME}}"
OIDC_AUDIENCE="${UAT_PUBLIC_BACKEND_ORIGIN}"

case "${STAGE}" in
  timeouts|refunds|payouts) ;;
  *)
    echo "STAGE must be timeouts, refunds or payouts" >&2
    exit 1
    ;;
esac

if [[ "${PROJECT_ID}" != "${UAT_PROJECT_ID}" ]]; then
  echo "This helper configures the UAT project only" >&2
  exit 1
fi
if [[ "${BACKEND_URL%/}" != "${UAT_PUBLIC_BACKEND_ORIGIN}" ]]; then
  echo "BACKEND_URL must be ${UAT_PUBLIC_BACKEND_ORIGIN}" >&2
  exit 1
fi

SCHEDULER_SERVICE_ACCOUNT_EMAIL="${SCHEDULER_SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud is required" >&2
  exit 1
fi

if ! gcloud iam service-accounts describe "${SCHEDULER_SERVICE_ACCOUNT_EMAIL}" \
  --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${SCHEDULER_SERVICE_ACCOUNT_NAME}" \
    --project="${PROJECT_ID}" \
    --display-name="Paid answer work drain scheduler" >/dev/null
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

# The job stores only a service-account identity and an audience. A successful
# attempt means a bounded sweep ran; it never means a refund settled or an
# owner was paid -- those are database states, reconciled on the next sweep.
echo "Configured and verified answer work drain ${JOB_NAME}: stage=${STAGE} ${JOB_EVIDENCE} auth=oidc"
