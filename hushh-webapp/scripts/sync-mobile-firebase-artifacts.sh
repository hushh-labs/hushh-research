#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

ENV_FILE="${ENV_FILE:-${WEB_ROOT}/.env.local}"
PROFILE_ENV_FILE="${PROFILE_ENV_FILE:-}"
FIREBASE_PROJECT_ID="${FIREBASE_PROJECT_ID:-}"
IOS_BUNDLE_ID="${IOS_BUNDLE_ID:-}"
ANDROID_PACKAGE_NAME="${ANDROID_PACKAGE_NAME:-}"
IOS_FIREBASE_APP_ID="${IOS_FIREBASE_APP_ID:-}"
ANDROID_FIREBASE_APP_ID="${ANDROID_FIREBASE_APP_ID:-}"
WRITE_B64_ENV_FILE="${WRITE_B64_ENV_FILE:-false}"
B64_ENV_OUTPUT="${B64_ENV_OUTPUT:-${WEB_ROOT}/.mobile-firebase-artifacts.env}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: required command not found: $1"
    exit 1
  fi
}

log() {
  echo "[sync-mobile-firebase] $*"
}

read_env_key() {
  local key="$1"
  local file="$2"
  if [[ ! -f "${file}" ]]; then
    return
  fi
  local raw
  raw="$(grep -E "^${key}=" "${file}" | tail -n1 | cut -d= -f2- || true)"
  raw="${raw%\"}"
  raw="${raw#\"}"
  echo "${raw}"
}

upsert_env_key() {
  local file="$1"
  local key="$2"
  local value="$3"
  VALUE="$value" python3 - "$file" "$key" <<'PY'
import os
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
key = sys.argv[2]
value = os.environ.get("VALUE", "")
needle = f"{key}="
lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []

for index, line in enumerate(lines):
    if line.startswith(needle):
        lines[index] = f"{key}={value}"
        break
else:
    if lines and lines[-1].strip():
        lines.append("")
    lines.append(f"{key}={value}")

path.write_text("\n".join(lines) + "\n", encoding="utf-8")
PY
}

require_cmd firebase
require_cmd jq
require_cmd python3

if [[ -z "${FIREBASE_PROJECT_ID}" ]]; then
  FIREBASE_PROJECT_ID="$(read_env_key NEXT_PUBLIC_FIREBASE_PROJECT_ID "${ENV_FILE}")"
fi
if [[ -z "${FIREBASE_PROJECT_ID}" ]]; then
  echo "ERROR: FIREBASE_PROJECT_ID is required (or set NEXT_PUBLIC_FIREBASE_PROJECT_ID in ${ENV_FILE})."
  exit 1
fi

existing_ios_target="$(mktemp)"
existing_android_target="$(mktemp)"
cleanup() {
  rm -f "${tmp_ios}" "${tmp_android}" "${existing_ios_target}" "${existing_android_target}"
}
trap cleanup EXIT

if [[ -f "${WEB_ROOT}/.env.local.d/ios/GoogleService-Info.plist" ]]; then
  cp "${WEB_ROOT}/.env.local.d/ios/GoogleService-Info.plist" "${existing_ios_target}"
fi
if [[ -f "${WEB_ROOT}/.env.local.d/android/google-services.json" ]]; then
  cp "${WEB_ROOT}/.env.local.d/android/google-services.json" "${existing_android_target}"
fi

if [[ -z "${IOS_BUNDLE_ID}" && -s "${existing_ios_target}" ]]; then
  IOS_BUNDLE_ID="$(python3 - <<'PY' "${existing_ios_target}"
import plistlib, sys
path = sys.argv[1]
try:
    with open(path, 'rb') as fh:
        data = plistlib.load(fh)
    print(str(data.get('BUNDLE_ID', '')).strip())
except Exception:
    print('')
PY
)"
fi

if [[ -z "${ANDROID_PACKAGE_NAME}" && -s "${existing_android_target}" ]]; then
  ANDROID_PACKAGE_NAME="$(jq -r '.client[0].client_info.android_client_info.package_name // empty' "${existing_android_target}" 2>/dev/null || true)"
fi

if [[ -z "${IOS_BUNDLE_ID}" ]]; then
  IOS_BUNDLE_ID="com.hushh.app"
fi
if [[ -z "${ANDROID_PACKAGE_NAME}" ]]; then
  ANDROID_PACKAGE_NAME="com.hushh.app"
fi

apps_json_raw="$(firebase apps:list --project "${FIREBASE_PROJECT_ID}" --json)"
apps_json="$(printf '%s\n' "${apps_json_raw}" | sed -n '/^{/,$p')"

if [[ -z "${IOS_FIREBASE_APP_ID}" ]]; then
  IOS_FIREBASE_APP_ID="$(printf '%s\n' "${apps_json}" | jq -r --arg ns "${IOS_BUNDLE_ID}" '.result[] | select(.platform=="IOS" and .namespace==$ns) | .appId' | head -n1)"
fi
if [[ -z "${ANDROID_FIREBASE_APP_ID}" ]]; then
  ANDROID_FIREBASE_APP_ID="$(printf '%s\n' "${apps_json}" | jq -r --arg ns "${ANDROID_PACKAGE_NAME}" '.result[] | select(.platform=="ANDROID" and .namespace==$ns) | .appId' | head -n1)"
fi

if [[ -z "${IOS_FIREBASE_APP_ID}" ]]; then
  echo "ERROR: Could not resolve iOS Firebase appId for bundle ${IOS_BUNDLE_ID}."
  exit 1
fi
if [[ -z "${ANDROID_FIREBASE_APP_ID}" ]]; then
  echo "ERROR: Could not resolve Android Firebase appId for package ${ANDROID_PACKAGE_NAME}."
  exit 1
fi

tmp_ios="$(mktemp)"
tmp_android="$(mktemp)"

log "Downloading iOS sdk config for appId=${IOS_FIREBASE_APP_ID}"
firebase apps:sdkconfig IOS "${IOS_FIREBASE_APP_ID}" --project "${FIREBASE_PROJECT_ID}" --out "${tmp_ios}" >/dev/null

log "Downloading Android sdk config for appId=${ANDROID_FIREBASE_APP_ID}"
firebase apps:sdkconfig ANDROID "${ANDROID_FIREBASE_APP_ID}" --project "${FIREBASE_PROJECT_ID}" --out "${tmp_android}" >/dev/null

ios_b64="$(base64 < "${tmp_ios}" | tr -d '\n')"
android_b64="$(base64 < "${tmp_android}" | tr -d '\n')"

upsert_env_key "${ENV_FILE}" "IOS_GOOGLESERVICE_INFO_PLIST_B64" "${ios_b64}"
upsert_env_key "${ENV_FILE}" "ANDROID_GOOGLE_SERVICES_JSON_B64" "${android_b64}"

if [[ -z "${PROFILE_ENV_FILE}" ]]; then
  active_profile="$(read_env_key "${ENV_FILE}" "APP_RUNTIME_PROFILE")"
  if [[ -n "${active_profile}" ]]; then
    PROFILE_ENV_FILE="${WEB_ROOT}/.env.${active_profile}.local"
  fi
fi

if [[ -n "${PROFILE_ENV_FILE}" && "${PROFILE_ENV_FILE}" != "${ENV_FILE}" ]]; then
  upsert_env_key "${PROFILE_ENV_FILE}" "IOS_GOOGLESERVICE_INFO_PLIST_B64" "${ios_b64}"
  upsert_env_key "${PROFILE_ENV_FILE}" "ANDROID_GOOGLE_SERVICES_JSON_B64" "${android_b64}"
fi

ACTIVE_ENV_FILE="${ENV_FILE}" PROFILE_ENV_FILE="${PROFILE_ENV_FILE:-${ENV_FILE}}" \
bash "${WEB_ROOT}/scripts/native/materialize-active-native-profile.sh" >/dev/null

ios_analytics_enabled="$(python3 - <<'PY' "${tmp_ios}"
import plistlib, sys
with open(sys.argv[1], 'rb') as fh:
    data = plistlib.load(fh)
print('true' if bool(data.get('IS_ANALYTICS_ENABLED', False)) else 'false')
PY
)"
android_has_analytics_service="$(jq -r 'if any(.client[]?; .services.analytics_service? != null) then "true" else "false" end' "${tmp_android}")"

log "Updated active frontend env with native Firebase artifacts:"
log "  env: ${ENV_FILE}"
if [[ -n "${PROFILE_ENV_FILE}" ]]; then
  log "  profile env: ${PROFILE_ENV_FILE}"
fi
log "  sidecar: ${WEB_ROOT}/.env.local.d"
log "  iOS IS_ANALYTICS_ENABLED=${ios_analytics_enabled}"
log "  Android analytics_service_present=${android_has_analytics_service}"

if [[ "${WRITE_B64_ENV_FILE}" == "true" ]]; then
  cat > "${B64_ENV_OUTPUT}" <<EOF_ENV
IOS_GOOGLESERVICE_INFO_PLIST_B64=${ios_b64}
ANDROID_GOOGLE_SERVICES_JSON_B64=${android_b64}
EOF_ENV
  chmod 600 "${B64_ENV_OUTPUT}"
  log "Wrote base64 artifact env file: ${B64_ENV_OUTPUT}"
fi

if [[ "${ios_analytics_enabled}" != "true" || "${android_has_analytics_service}" != "true" ]]; then
  log "WARNING: Firebase app configs still indicate analytics is not fully enabled for native."
  log "         Link Firebase project/apps to GA4 and re-download artifacts."
fi

log "The active .env.local profile is now the source of truth for the native Firebase artifacts."
