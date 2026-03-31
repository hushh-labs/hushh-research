#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

ACTIVE_ENV_FILE="${ACTIVE_ENV_FILE:-${WEB_DIR}/.env.local}"
PROFILE_ENV_FILE="${PROFILE_ENV_FILE:-${ACTIVE_ENV_FILE}}"
SIDECAR_ROOT="${NATIVE_SIDECAR_ROOT:-${WEB_DIR}/.env.local.d}"
IOS_DIR="${SIDECAR_ROOT}/ios"
ANDROID_DIR="${SIDECAR_ROOT}/android"
LEGACY_ROOT="${LEGACY_NATIVE_ROOT:-${WEB_DIR}/.local-secrets}"
LEGACY_MOBILE_ROOT="${LEGACY_ROOT}/mobile-firebase"
LEGACY_IOS_ROOT="${LEGACY_ROOT}/ios-signing"
IOS_TRACKED_FILE="${IOS_TRACKED_FILE:-${WEB_DIR}/ios/App/App/GoogleService-Info.plist}"
ANDROID_TRACKED_FILE="${ANDROID_TRACKED_FILE:-${WEB_DIR}/android/app/google-services.json}"

IOS_FIREBASE_KEY="${IOS_FIREBASE_ENV_KEY:-IOS_GOOGLESERVICE_INFO_PLIST_B64}"
ANDROID_FIREBASE_KEY="${ANDROID_FIREBASE_ENV_KEY:-ANDROID_GOOGLE_SERVICES_JSON_B64}"
IOS_DEV_CERT_KEY="${IOS_DEV_CERT_KEY:-IOS_DEV_CERT_P12_B64}"
IOS_DEV_CERT_PASSWORD_KEY="${IOS_DEV_CERT_PASSWORD_KEY:-IOS_DEV_CERT_PASSWORD}"
IOS_DEV_PROFILE_KEY="${IOS_DEV_PROFILE_KEY:-IOS_DEV_PROFILE_B64}"
IOS_DIST_CERT_KEY="${IOS_DIST_CERT_KEY:-IOS_DIST_CERT_P12_B64}"
IOS_DIST_CERT_PASSWORD_KEY="${IOS_DIST_CERT_PASSWORD_KEY:-IOS_DIST_CERT_PASSWORD}"
IOS_DIST_PROFILE_KEY="${IOS_DIST_PROFILE_KEY:-IOS_APPSTORE_PROFILE_B64}"
APPLE_TEAM_ID_KEY="${APPLE_TEAM_ID_KEY:-APPLE_TEAM_ID}"
APPSTORE_CONNECT_KEY_KEY="${APPSTORE_CONNECT_KEY_KEY:-APPSTORE_CONNECT_API_KEY_P8_B64}"
APPSTORE_CONNECT_KEY_ID_KEY="${APPSTORE_CONNECT_KEY_ID_KEY:-APPSTORE_CONNECT_KEY_ID}"
APPSTORE_CONNECT_ISSUER_ID_KEY="${APPSTORE_CONNECT_ISSUER_ID_KEY:-APPSTORE_CONNECT_ISSUER_ID}"
ANDROID_KEYSTORE_KEY="${ANDROID_KEYSTORE_KEY:-ANDROID_RELEASE_KEYSTORE_B64}"
ANDROID_STORE_PASSWORD_KEY="${ANDROID_STORE_PASSWORD_KEY:-ANDROID_RELEASE_KEYSTORE_PASSWORD}"
ANDROID_KEY_ALIAS_KEY="${ANDROID_KEY_ALIAS_KEY:-ANDROID_RELEASE_KEY_ALIAS}"
ANDROID_KEY_PASSWORD_KEY="${ANDROID_KEY_PASSWORD_KEY:-ANDROID_RELEASE_KEY_PASSWORD}"

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

upsert_env_value() {
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

sync_env_value() {
  local key="$1"
  local value="$2"
  if [ -z "$value" ]; then
    return 0
  fi
  upsert_env_value "$ACTIVE_ENV_FILE" "$key" "$value"
  if [ "$PROFILE_ENV_FILE" != "$ACTIVE_ENV_FILE" ]; then
    upsert_env_value "$PROFILE_ENV_FILE" "$key" "$value"
  fi
}

decode_b64_to_file() {
  local value="$1"
  local target="$2"
  mkdir -p "$(dirname "$target")"
  if printf "" | base64 --decode >/dev/null 2>&1; then
    printf '%s' "$value" | base64 --decode > "$target"
  else
    printf '%s' "$value" | base64 -D > "$target"
  fi
  chmod 600 "$target" || true
}

encode_file_to_b64() {
  local source_file="$1"
  if base64 < "$source_file" >/dev/null 2>&1; then
    base64 < "$source_file" | tr -d '\n'
  else
    base64 -i "$source_file" | tr -d '\n'
  fi
}

ios_file_is_template() {
  local file_path="$1"
  [ -f "$file_path" ] || return 1
  grep -qE 'FIREBASE_IOS_TEMPLATE_API_KEY|firebase-template-project|firebase-ios-template-client-id' "$file_path"
}

android_file_is_template() {
  local file_path="$1"
  [ -f "$file_path" ] || return 1
  grep -qE 'FIREBASE_ANDROID_TEMPLATE_API_KEY|firebase-template-project|firebase-android-template-client-id' "$file_path"
}

seed_env_from_file_if_missing() {
  local env_key="$1"
  local source_file="$2"
  local current_value
  current_value="$(sanitize_env_value "$(read_env_value "$ACTIVE_ENV_FILE" "$env_key")")"
  if [ -n "$current_value" ] || [ ! -f "$source_file" ]; then
    return 0
  fi
  sync_env_value "$env_key" "$(encode_file_to_b64 "$source_file")"
}

seed_env_from_text_if_missing() {
  local env_key="$1"
  local value="$2"
  if [ -z "$value" ]; then
    return 0
  fi
  if [ -n "$(sanitize_env_value "$(read_env_value "$ACTIVE_ENV_FILE" "$env_key")")" ]; then
    return 0
  fi
  sync_env_value "$env_key" "$value"
}

read_legacy_signing_export() {
  local key="$1"
  local env_file="${LEGACY_IOS_ROOT}/signing.env"
  if [ ! -f "$env_file" ]; then
    echo ""
    return 0
  fi
  python3 - "$env_file" "$key" <<'PY'
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1])
key = sys.argv[2]
pattern = re.compile(rf"^export {re.escape(key)}=(?:'([^']*)'|\"([^\"]*)\"|(.*))$")
for line in path.read_text(encoding="utf-8").splitlines():
    match = pattern.match(line.strip())
    if match:
        print(next((group for group in match.groups() if group is not None), ""))
        break
else:
    print("")
PY
}

read_legacy_xcconfig_value() {
  local key="$1"
  local source_file="$2"
  if [ ! -f "$source_file" ]; then
    echo ""
    return 0
  fi
  python3 - "$source_file" "$key" <<'PY'
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1])
key = sys.argv[2]
pattern = re.compile(rf"^{re.escape(key)}\s*=\s*(.+?)\s*$")
for line in path.read_text(encoding="utf-8").splitlines():
    match = pattern.match(line.strip())
    if match:
        print(match.group(1))
        break
else:
    print("")
PY
}

copy_if_exists() {
  local source_file="$1"
  local target_file="$2"
  if [ -f "$source_file" ] && [ ! -f "$target_file" ]; then
    mkdir -p "$(dirname "$target_file")"
    cp "$source_file" "$target_file"
    chmod 600 "$target_file" || true
  fi
}

materialize_mobile_artifacts() {
  local ios_b64 android_b64
  ios_b64="$(sanitize_env_value "$(read_env_value "$ACTIVE_ENV_FILE" "$IOS_FIREBASE_KEY")")"
  android_b64="$(sanitize_env_value "$(read_env_value "$ACTIVE_ENV_FILE" "$ANDROID_FIREBASE_KEY")")"

  if [ -n "$ios_b64" ]; then
    decode_b64_to_file "$ios_b64" "${IOS_DIR}/GoogleService-Info.plist"
  fi
  if [ -n "$android_b64" ]; then
    decode_b64_to_file "$android_b64" "${ANDROID_DIR}/google-services.json"
  fi
}

materialize_ios_signing_payloads() {
  local appstore_key_id appstore_key_b64
  mkdir -p "$IOS_DIR"

  for pair in \
    "${IOS_DEV_CERT_KEY}:${IOS_DIR}/development.p12" \
    "${IOS_DEV_PROFILE_KEY}:${IOS_DIR}/development.mobileprovision" \
    "${IOS_DIST_CERT_KEY}:${IOS_DIR}/distribution.p12" \
    "${IOS_DIST_PROFILE_KEY}:${IOS_DIR}/appstore.mobileprovision"
  do
    local env_key="${pair%%:*}"
    local target_file="${pair#*:}"
    local value
    value="$(sanitize_env_value "$(read_env_value "$ACTIVE_ENV_FILE" "$env_key")")"
    if [ -n "$value" ]; then
      decode_b64_to_file "$value" "$target_file"
    fi
  done

  appstore_key_id="$(sanitize_env_value "$(read_env_value "$ACTIVE_ENV_FILE" "$APPSTORE_CONNECT_KEY_ID_KEY")")"
  appstore_key_b64="$(sanitize_env_value "$(read_env_value "$ACTIVE_ENV_FILE" "$APPSTORE_CONNECT_KEY_KEY")")"
  if [ -n "$appstore_key_b64" ]; then
    if [ -z "$appstore_key_id" ]; then
      appstore_key_id="LOCAL"
    fi
    decode_b64_to_file "$appstore_key_b64" "${IOS_DIR}/AuthKey_${appstore_key_id}.p8"
  fi
}

materialize_android_release_signing() {
  local keystore_b64 store_password key_alias key_password keystore_path properties_path
  keystore_b64="$(sanitize_env_value "$(read_env_value "$ACTIVE_ENV_FILE" "$ANDROID_KEYSTORE_KEY")")"
  store_password="$(sanitize_env_value "$(read_env_value "$ACTIVE_ENV_FILE" "$ANDROID_STORE_PASSWORD_KEY")")"
  key_alias="$(sanitize_env_value "$(read_env_value "$ACTIVE_ENV_FILE" "$ANDROID_KEY_ALIAS_KEY")")"
  key_password="$(sanitize_env_value "$(read_env_value "$ACTIVE_ENV_FILE" "$ANDROID_KEY_PASSWORD_KEY")")"

  if [ -z "$keystore_b64" ] || [ -z "$store_password" ] || [ -z "$key_alias" ] || [ -z "$key_password" ]; then
    return 0
  fi

  mkdir -p "$ANDROID_DIR"
  keystore_path="${ANDROID_DIR}/release.keystore"
  properties_path="${ANDROID_DIR}/release-signing.properties"
  decode_b64_to_file "$keystore_b64" "$keystore_path"
  cat > "$properties_path" <<EOF
storePassword=${store_password}
keyPassword=${key_password}
keyAlias=${key_alias}
storeFile=${keystore_path}
EOF
  chmod 600 "$properties_path" || true
}

migrate_legacy_mobile_cache() {
  seed_env_from_file_if_missing "$IOS_FIREBASE_KEY" "${LEGACY_MOBILE_ROOT}/GoogleService-Info.plist"
  seed_env_from_file_if_missing "$ANDROID_FIREBASE_KEY" "${LEGACY_MOBILE_ROOT}/google-services.json"
}

migrate_tracked_mobile_files() {
  if [ -f "$IOS_TRACKED_FILE" ] && ! ios_file_is_template "$IOS_TRACKED_FILE"; then
    seed_env_from_file_if_missing "$IOS_FIREBASE_KEY" "$IOS_TRACKED_FILE"
  fi
  if [ -f "$ANDROID_TRACKED_FILE" ] && ! android_file_is_template "$ANDROID_TRACKED_FILE"; then
    seed_env_from_file_if_missing "$ANDROID_FIREBASE_KEY" "$ANDROID_TRACKED_FILE"
  fi
}

migrate_legacy_ios_signing_payloads() {
  seed_env_from_file_if_missing "$IOS_DEV_CERT_KEY" "${LEGACY_IOS_ROOT}/development.p12"
  seed_env_from_file_if_missing "$IOS_DEV_PROFILE_KEY" "${LEGACY_IOS_ROOT}/development.mobileprovision"
  seed_env_from_file_if_missing "$IOS_DIST_CERT_KEY" "${LEGACY_IOS_ROOT}/distribution.p12"
  seed_env_from_file_if_missing "$IOS_DIST_PROFILE_KEY" "${LEGACY_IOS_ROOT}/appstore.mobileprovision"

  local auth_key_file auth_key_id
  auth_key_file="$(find "${LEGACY_IOS_ROOT}" -maxdepth 1 -name 'AuthKey_*.p8' | head -n1 || true)"
  if [ -n "${auth_key_file:-}" ] && [ -f "$auth_key_file" ]; then
    seed_env_from_file_if_missing "$APPSTORE_CONNECT_KEY_KEY" "$auth_key_file"
    auth_key_id="$(basename "$auth_key_file")"
    auth_key_id="${auth_key_id#AuthKey_}"
    auth_key_id="${auth_key_id%.p8}"
    seed_env_from_text_if_missing "$APPSTORE_CONNECT_KEY_ID_KEY" "$auth_key_id"
  fi

  seed_env_from_text_if_missing "$APPSTORE_CONNECT_ISSUER_ID_KEY" "$(read_legacy_signing_export 'APPSTORE_CONNECT_ISSUER_ID')"
  seed_env_from_text_if_missing "$APPLE_TEAM_ID_KEY" "$(read_legacy_xcconfig_value 'DEVELOPMENT_TEAM' "${LEGACY_IOS_ROOT}/debug-signing.xcconfig")"

  local has_complete_ios_env="false"
  if [ -n "$(sanitize_env_value "$(read_env_value "$ACTIVE_ENV_FILE" "$APPLE_TEAM_ID_KEY")")" ] && \
     [ -n "$(sanitize_env_value "$(read_env_value "$ACTIVE_ENV_FILE" "$IOS_DEV_CERT_PASSWORD_KEY")")" ] && \
     [ -n "$(sanitize_env_value "$(read_env_value "$ACTIVE_ENV_FILE" "$IOS_DIST_CERT_PASSWORD_KEY")")" ] && \
     [ -n "$(sanitize_env_value "$(read_env_value "$ACTIVE_ENV_FILE" "$APPSTORE_CONNECT_KEY_ID_KEY")")" ] && \
     [ -n "$(sanitize_env_value "$(read_env_value "$ACTIVE_ENV_FILE" "$APPSTORE_CONNECT_ISSUER_ID_KEY")")" ]; then
    has_complete_ios_env="true"
  fi

  if [ "$has_complete_ios_env" != "true" ]; then
    copy_if_exists "${LEGACY_IOS_ROOT}/debug-signing.xcconfig" "${IOS_DIR}/debug-signing.xcconfig"
    copy_if_exists "${LEGACY_IOS_ROOT}/release-signing.xcconfig" "${IOS_DIR}/release-signing.xcconfig"
    copy_if_exists "${LEGACY_IOS_ROOT}/signing.env" "${IOS_DIR}/signing.env"
    copy_if_exists "${LEGACY_IOS_ROOT}/installed-profiles.tsv" "${IOS_DIR}/installed-profiles.tsv"
    copy_if_exists "${LEGACY_IOS_ROOT}/keychain.password" "${IOS_DIR}/keychain.password"
  fi
}

if [ ! -f "$ACTIVE_ENV_FILE" ]; then
  echo "Missing active frontend env file: ${ACTIVE_ENV_FILE}" >&2
  exit 1
fi

rm -rf "$IOS_DIR" "$ANDROID_DIR"
mkdir -p "$SIDECAR_ROOT" "$IOS_DIR" "$ANDROID_DIR"

migrate_legacy_mobile_cache
migrate_tracked_mobile_files
migrate_legacy_ios_signing_payloads
materialize_mobile_artifacts
materialize_ios_signing_payloads
materialize_android_release_signing

echo "Materialized active native profile into ${SIDECAR_ROOT}."
