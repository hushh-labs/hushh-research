#!/usr/bin/env bash
set -euo pipefail

IOS_TARGET="${IOS_TARGET:-ios/App/App/GoogleService-Info.plist}"
ANDROID_TARGET="${ANDROID_TARGET:-android/app/google-services.json}"

if [[ -z "${IOS_GOOGLESERVICE_INFO_PLIST_B64:-}" ]]; then
  echo "Missing IOS_GOOGLESERVICE_INFO_PLIST_B64"
  exit 1
fi

if [[ -z "${ANDROID_GOOGLE_SERVICES_JSON_B64:-}" ]]; then
  echo "Missing ANDROID_GOOGLE_SERVICES_JSON_B64"
  exit 1
fi

decode_b64() {
  # GNU coreutils
  if printf "" | base64 --decode >/dev/null 2>&1; then
    base64 --decode
    return
  fi

  # macOS BSD base64
  if printf "" | base64 -D >/dev/null 2>&1; then
    base64 -D
    return
  fi

  echo "No compatible base64 decoder found"
  return 1
}

mkdir -p "$(dirname "${IOS_TARGET}")" "$(dirname "${ANDROID_TARGET}")"

printf '%s' "${IOS_GOOGLESERVICE_INFO_PLIST_B64}" | decode_b64 > "${IOS_TARGET}"
printf '%s' "${ANDROID_GOOGLE_SERVICES_JSON_B64}" | decode_b64 > "${ANDROID_TARGET}"

echo "Injected mobile Firebase artifacts:"
echo "  - ${IOS_TARGET}"
echo "  - ${ANDROID_TARGET}"
