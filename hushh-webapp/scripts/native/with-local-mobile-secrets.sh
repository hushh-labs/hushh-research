#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ACTIVE_ENV_FILE="${ACTIVE_ENV_FILE:-${WEB_DIR}/.env.local}"
NATIVE_SIDECAR_ROOT="${NATIVE_SIDECAR_ROOT:-${WEB_DIR}/.env.local.d}"
IOS_SOURCE="${IOS_SOURCE:-${NATIVE_SIDECAR_ROOT}/ios/GoogleService-Info.plist}"
ANDROID_SOURCE="${ANDROID_SOURCE:-${NATIVE_SIDECAR_ROOT}/android/google-services.json}"
IOS_TARGET="${IOS_TARGET:-${WEB_DIR}/ios/App/App/GoogleService-Info.plist}"
ANDROID_TARGET="${ANDROID_TARGET:-${WEB_DIR}/android/app/google-services.json}"
REQUIRE_LOCAL_MOBILE_SECRETS="${REQUIRE_LOCAL_MOBILE_SECRETS:-0}"

if [ "$#" -eq 0 ]; then
  echo "Usage: $0 <command...>" >&2
  exit 1
fi

have_local_secrets=true
if [ ! -f "${ACTIVE_ENV_FILE}" ]; then
  have_local_secrets=false
else
  if [[ ! -f "${IOS_SOURCE}" || ! -f "${ANDROID_SOURCE}" ]]; then
    have_local_secrets=false
  fi
fi

if [[ "${have_local_secrets}" != "true" ]]; then
  if [[ "${REQUIRE_LOCAL_MOBILE_SECRETS}" = "1" ]]; then
    echo "Missing active mobile Firebase artifacts under ${NATIVE_SIDECAR_ROOT}." >&2
    echo "Activate or bootstrap a frontend profile so ${ACTIVE_ENV_FILE} contains the native Firebase values." >&2
    exit 1
  fi
  echo "Local mobile Firebase cache not found; using committed template files." >&2
  exec "$@"
fi

backup_dir="$(mktemp -d)"
cleanup() {
  if [[ -f "${backup_dir}/GoogleService-Info.plist" ]]; then
    cp "${backup_dir}/GoogleService-Info.plist" "${IOS_TARGET}"
  fi
  if [[ -f "${backup_dir}/google-services.json" ]]; then
    cp "${backup_dir}/google-services.json" "${ANDROID_TARGET}"
  fi
  rm -rf "${backup_dir}"
}
trap cleanup EXIT

cp "${IOS_TARGET}" "${backup_dir}/GoogleService-Info.plist"
cp "${ANDROID_TARGET}" "${backup_dir}/google-services.json"
cp "${IOS_SOURCE}" "${IOS_TARGET}"
cp "${ANDROID_SOURCE}" "${ANDROID_TARGET}"

echo "Applied local mobile Firebase cache for native build." >&2
"$@"
