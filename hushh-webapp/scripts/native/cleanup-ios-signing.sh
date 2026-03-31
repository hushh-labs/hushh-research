#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
LOCAL_SIGNING_ROOT="${LOCAL_SIGNING_ROOT:-${WEB_DIR}/.env.local.d/ios}"
LEGACY_SIGNING_ROOT="${LEGACY_SIGNING_ROOT:-${WEB_DIR}/.local-secrets/ios-signing}"
KEYCHAIN_NAME="${IOS_SIGNING_KEYCHAIN_NAME:-hushh-local-signing.keychain-db}"
KEYCHAIN_PATH="${HOME}/Library/Keychains/${KEYCHAIN_NAME}"

if [[ -f "${LOCAL_SIGNING_ROOT}/installed-profiles.tsv" ]]; then
  while IFS=$'\t' read -r _label _name profile_path; do
    [[ -n "${profile_path:-}" ]] && rm -f "${profile_path}"
  done < "${LOCAL_SIGNING_ROOT}/installed-profiles.tsv"
fi

if [[ -f "${KEYCHAIN_PATH}" ]]; then
  security delete-keychain "${KEYCHAIN_PATH}" >/dev/null 2>&1 || true
fi

rm -rf "${LOCAL_SIGNING_ROOT}"
rm -rf "${LEGACY_SIGNING_ROOT}"
echo "Removed local iOS signing sidecar and keychain."
