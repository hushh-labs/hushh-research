#!/usr/bin/env bash
set -euo pipefail

# Native Google callbacks use GET query parameters for OAuth codes, signed
# state and Picker file IDs. Cloud Run ingress logs request URLs before the
# application can redact them, so retain structured app outcome telemetry but
# drop only those two fixed request-log paths at the UAT project boundary.
#
# This helper is intentionally UAT-only and idempotent. It never changes a
# sink, IAM policy, service, feature flag, or a customer connection.

readonly UAT_PROJECT_ID="hushh-pda-uat"
readonly UAT_BACKEND_SERVICE="consent-protocol"
readonly UAT_EXCLUSION_NAME="drive-native-callback-query-material"

PROJECT_ID="${PROJECT_ID:-${UAT_PROJECT_ID}}"
BACKEND_SERVICE="${BACKEND_SERVICE:-${UAT_BACKEND_SERVICE}}"
EXCLUSION_NAME="${EXCLUSION_NAME:-${UAT_EXCLUSION_NAME}}"

if [[ "${PROJECT_ID}" != "${UAT_PROJECT_ID}" ]]; then
  echo "This callback log guard is limited to ${UAT_PROJECT_ID}" >&2
  exit 1
fi
if [[ "${BACKEND_SERVICE}" != "${UAT_BACKEND_SERVICE}" ]]; then
  echo "This callback log guard is limited to ${UAT_BACKEND_SERVICE}" >&2
  exit 1
fi
if [[ "${EXCLUSION_NAME}" != "${UAT_EXCLUSION_NAME}" ]]; then
  echo "This callback log guard only manages ${UAT_EXCLUSION_NAME}" >&2
  exit 1
fi
if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud is required" >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1; then
  echo "curl and python3 are required" >&2
  exit 1
fi

# No wildcard service or generic OAuth matching: only Cloud Run ingress
# request logs for the two server-owned callbacks are excluded. Application
# request.summary logs retain their safe route-template/outcome telemetry.
LOG_FILTER="resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${BACKEND_SERVICE}\" AND logName=\"projects/${PROJECT_ID}/logs/run.googleapis.com%2Frequests\" AND httpRequest.requestUrl=~\"/api/connectors/(oauth/native/callback|google_drive/picker/native/callback)(\\?.*)?$\""
DESCRIPTION="UAT-only: exclude native Google OAuth and Picker callback query material; structured route/outcome logs remain enabled."
RESOURCE="projects/${PROJECT_ID}/exclusions/${EXCLUSION_NAME}"
BASE_URL="https://logging.googleapis.com/v2"
TMP_DIR="$(mktemp -d)"
trap 'unset access_token; rm -rf "${TMP_DIR}"' EXIT

# Cloud Logging's public REST resource is the durable interface for exclusions.
# Some gcloud distributions intentionally do not expose an exclusions command.
access_token="$(gcloud auth print-access-token)"
if [[ -z "${access_token}" ]]; then
  echo "Unable to obtain an access token for Cloud Logging" >&2
  exit 1
fi

request_payload() {
  local include_name="$1"
  INCLUDE_NAME="${include_name}" EXCLUSION_NAME="${EXCLUSION_NAME}" \
    DESCRIPTION="${DESCRIPTION}" LOG_FILTER="${LOG_FILTER}" python3 - <<'PY'
import json
import os

payload = {
    "description": os.environ["DESCRIPTION"],
    "filter": os.environ["LOG_FILTER"],
    "disabled": False,
}
if os.environ["INCLUDE_NAME"] == "true":
    payload["name"] = os.environ["EXCLUSION_NAME"]
print(json.dumps(payload, separators=(",", ":")))
PY
}

call_logging() {
  local method="$1"
  local url="$2"
  local payload="$3"
  local output_file="$4"
  local -a arguments=(
    --silent --show-error --output "${output_file}" --write-out '%{http_code}'
    --request "${method}"
    --header "Authorization: Bearer ${access_token}"
    --header "Content-Type: application/json"
  )
  if [[ -n "${payload}" ]]; then
    arguments+=(--data "${payload}")
  fi
  arguments+=("${url}")
  curl "${arguments[@]}"
}

get_status="$(call_logging GET "${BASE_URL}/${RESOURCE}" "" "${TMP_DIR}/get.json")"
case "${get_status}" in
  200)
    update_status="$(call_logging PATCH "${BASE_URL}/${RESOURCE}?updateMask=filter%2Cdescription%2Cdisabled" "$(request_payload false)" "${TMP_DIR}/update.json")"
    [[ "${update_status}" == "200" ]] || {
      echo "Unable to update native callback log exclusion" >&2
      exit 1
    }
    ;;
  404)
    create_status="$(call_logging POST "${BASE_URL}/projects/${PROJECT_ID}/exclusions" "$(request_payload true)" "${TMP_DIR}/create.json")"
    [[ "${create_status}" == "200" ]] || {
      echo "Unable to create native callback log exclusion" >&2
      exit 1
    }
    ;;
  *)
    echo "Unable to read native callback log exclusion (HTTP ${get_status})" >&2
    exit 1
    ;;
esac

verify_status="$(call_logging GET "${BASE_URL}/${RESOURCE}" "" "${TMP_DIR}/verify.json")"
if [[ "${verify_status}" != "200" ]]; then
  echo "Unable to verify native callback log exclusion" >&2
  exit 1
fi
if ! EXPECTED_FILTER="${LOG_FILTER}" python3 - "${TMP_DIR}/verify.json" <<'PY'
import json
import os
import sys

payload = json.load(open(sys.argv[1], encoding="utf-8"))
# Cloud Logging omits a false-valued `disabled` field in some successful
# create/read responses. Missing therefore has the API's documented default
# meaning (enabled); true is the only unsafe value here.
if payload.get("filter") != os.environ["EXPECTED_FILTER"] or payload.get("disabled", False) is not False:
    raise SystemExit(1)
PY
then
  echo "Native callback log exclusion verification failed" >&2
  exit 1
fi

echo "Configured and verified UAT native callback log exclusion ${EXCLUSION_NAME} (request logs only)"
