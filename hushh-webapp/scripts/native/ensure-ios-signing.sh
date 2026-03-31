#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ACTIVE_ENV_FILE="${ACTIVE_ENV_FILE:-${WEB_DIR}/.env.local}"
LOCAL_SIGNING_ROOT="${LOCAL_SIGNING_ROOT:-${WEB_DIR}/.env.local.d/ios}"
ENV_FILE="${LOCAL_SIGNING_ROOT}/signing.env"
DEBUG_SIGNING_XCCONFIG="${LOCAL_SIGNING_ROOT}/debug-signing.xcconfig"
RELEASE_SIGNING_XCCONFIG="${LOCAL_SIGNING_ROOT}/release-signing.xcconfig"
KEYCHAIN_NAME="${IOS_SIGNING_KEYCHAIN_NAME:-hushh-local-signing.keychain-db}"
KEYCHAIN_PATH="${HOME}/Library/Keychains/${KEYCHAIN_NAME}"
KEYCHAIN_PASSWORD_FILE="${LOCAL_SIGNING_ROOT}/keychain.password"

read_env_value() {
  local file="$1"
  local key="$2"
  python3 - "$file" "$key" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
key = sys.argv[2]
needle = f"{key}="
if not path.exists():
    print("")
    raise SystemExit(0)

for line in path.read_text(encoding="utf-8").splitlines():
    if line.startswith(needle):
        print(line.split("=", 1)[1])
        break
else:
    print("")
PY
}

sanitize_env_value() {
  local value="$1"
  if [[ "$value" == replace_with_* ]]; then
    echo ""
  else
    echo "$value"
  fi
}

signing_cache_ready() {
  [[ -f "${ENV_FILE}" && -f "${DEBUG_SIGNING_XCCONFIG}" && -f "${RELEASE_SIGNING_XCCONFIG}" ]]
}

if [ ! -f "${ACTIVE_ENV_FILE}" ]; then
  echo "Missing active env file for iOS signing: ${ACTIVE_ENV_FILE}" >&2
  exit 1
fi

mkdir -p "${LOCAL_SIGNING_ROOT}"
bash "${WEB_DIR}/scripts/native/materialize-active-native-profile.sh"

if signing_cache_ready; then
  exit 0
fi

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

install_profile() {
  local source_file="$1"
  local label="$2"
  local plist_file uuid profile_name destination

  plist_file="$(mktemp)"
  security cms -D -i "${source_file}" > "${plist_file}"
  uuid="$(/usr/libexec/PlistBuddy -c 'Print UUID' "${plist_file}")"
  profile_name="$(/usr/libexec/PlistBuddy -c 'Print Name' "${plist_file}")"
  destination="${HOME}/Library/MobileDevice/Provisioning Profiles/${uuid}.mobileprovision"
  mkdir -p "${HOME}/Library/MobileDevice/Provisioning Profiles"
  cp "${source_file}" "${destination}"
  rm -f "${plist_file}"
  printf '%s\t%s\t%s\n' "${label}" "${profile_name}" "${destination}" >> "${LOCAL_SIGNING_ROOT}/installed-profiles.tsv"
  printf '%s' "${profile_name}"
}

require_cmd security
require_cmd openssl

APPLE_TEAM_ID="$(sanitize_env_value "$(read_env_value "${ACTIVE_ENV_FILE}" "APPLE_TEAM_ID")")"
DEV_CERT_PASSWORD="$(sanitize_env_value "$(read_env_value "${ACTIVE_ENV_FILE}" "IOS_DEV_CERT_PASSWORD")")"
DIST_CERT_PASSWORD="$(sanitize_env_value "$(read_env_value "${ACTIVE_ENV_FILE}" "IOS_DIST_CERT_PASSWORD")")"
ASC_KEY_ID="$(sanitize_env_value "$(read_env_value "${ACTIVE_ENV_FILE}" "APPSTORE_CONNECT_KEY_ID")")"
ASC_ISSUER_ID="$(sanitize_env_value "$(read_env_value "${ACTIVE_ENV_FILE}" "APPSTORE_CONNECT_ISSUER_ID")")"

if [ -z "${APPLE_TEAM_ID}" ] || [ -z "${DEV_CERT_PASSWORD}" ] || [ -z "${DIST_CERT_PASSWORD}" ] || [ -z "${ASC_KEY_ID}" ] || [ -z "${ASC_ISSUER_ID}" ]; then
  echo "Missing active iOS signing env values in ${ACTIVE_ENV_FILE}." >&2
  exit 1
fi

if [[ ! -f "${LOCAL_SIGNING_ROOT}/development.p12" || ! -f "${LOCAL_SIGNING_ROOT}/distribution.p12" || ! -f "${LOCAL_SIGNING_ROOT}/development.mobileprovision" || ! -f "${LOCAL_SIGNING_ROOT}/appstore.mobileprovision" ]]; then
  echo "Missing materialized iOS signing payloads under ${LOCAL_SIGNING_ROOT}." >&2
  exit 1
fi

if [[ ! -f "${KEYCHAIN_PASSWORD_FILE}" ]]; then
  openssl rand -hex 24 > "${KEYCHAIN_PASSWORD_FILE}"
  chmod 600 "${KEYCHAIN_PASSWORD_FILE}"
fi
KEYCHAIN_PASSWORD="$(cat "${KEYCHAIN_PASSWORD_FILE}")"

: > "${LOCAL_SIGNING_ROOT}/installed-profiles.tsv"

if [[ ! -f "${KEYCHAIN_PATH}" ]]; then
  security create-keychain -p "${KEYCHAIN_PASSWORD}" "${KEYCHAIN_NAME}"
fi

security unlock-keychain -p "${KEYCHAIN_PASSWORD}" "${KEYCHAIN_PATH}"
security set-keychain-settings -lut 21600 "${KEYCHAIN_PATH}"
security list-keychains -d user -s "${KEYCHAIN_PATH}" $(security list-keychains -d user | tr -d '"')
security import "${LOCAL_SIGNING_ROOT}/development.p12" -k "${KEYCHAIN_PATH}" -P "${DEV_CERT_PASSWORD}" -T /usr/bin/codesign -T /usr/bin/security >/dev/null
security import "${LOCAL_SIGNING_ROOT}/distribution.p12" -k "${KEYCHAIN_PATH}" -P "${DIST_CERT_PASSWORD}" -T /usr/bin/codesign -T /usr/bin/security >/dev/null
security set-key-partition-list -S apple-tool:,apple: -s -k "${KEYCHAIN_PASSWORD}" "${KEYCHAIN_PATH}" >/dev/null

DEV_PROFILE_NAME="$(install_profile "${LOCAL_SIGNING_ROOT}/development.mobileprovision" development)"
DIST_PROFILE_NAME="$(install_profile "${LOCAL_SIGNING_ROOT}/appstore.mobileprovision" distribution)"

cat > "${DEBUG_SIGNING_XCCONFIG}" <<EOF
DEVELOPMENT_TEAM = ${APPLE_TEAM_ID}
CODE_SIGN_STYLE = Manual
CODE_SIGN_IDENTITY = Apple Development
PROVISIONING_PROFILE_SPECIFIER = ${DEV_PROFILE_NAME}
EOF

cat > "${RELEASE_SIGNING_XCCONFIG}" <<EOF
DEVELOPMENT_TEAM = ${APPLE_TEAM_ID}
CODE_SIGN_STYLE = Manual
CODE_SIGN_IDENTITY = Apple Distribution
PROVISIONING_PROFILE_SPECIFIER = ${DIST_PROFILE_NAME}
EOF

cat > "${ENV_FILE}" <<EOF
export APPLE_TEAM_ID='${APPLE_TEAM_ID}'
export IOS_SIGNING_KEYCHAIN_PATH='${KEYCHAIN_PATH}'
export IOS_SIGNING_KEYCHAIN_PASSWORD='${KEYCHAIN_PASSWORD}'
export APPSTORE_CONNECT_API_KEY_PATH='${LOCAL_SIGNING_ROOT}/AuthKey_${ASC_KEY_ID}.p8'
export APPSTORE_CONNECT_KEY_ID='${ASC_KEY_ID}'
export APPSTORE_CONNECT_ISSUER_ID='${ASC_ISSUER_ID}'
EOF
chmod 600 "${ENV_FILE}" "${DEBUG_SIGNING_XCCONFIG}" "${RELEASE_SIGNING_XCCONFIG}" || true

echo "Prepared local iOS signing under ${LOCAL_SIGNING_ROOT}."
