#!/usr/bin/env bash

# Materialize the non-secret UAT build contract and the native Firebase plist
# only on a CI runner after workload-identity authentication. This script never
# prints values and is deliberately shared by the TestFlight and physical-iPhone
# lanes so both use the same backend, Firebase, and Capacitor inputs.

set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-hushh-pda-uat}"
IOS_BUNDLE_ID="${IOS_BUNDLE_ID:-com.hushh.app}"
GITHUB_ENV_PATH="${GITHUB_ENV:-}"

if [[ -z "$GITHUB_ENV_PATH" ]]; then
  echo "materialize-ios-uat-build-contract requires GITHUB_ENV on a CI runner." >&2
  exit 2
fi

get_secret() {
  gcloud secrets versions access latest --secret="$1" --project="$PROJECT_ID" 2>/dev/null || true
}

require_value() {
  local name="$1"
  local value="$2"
  if [[ -z "$value" ]]; then
    echo "Missing required GCP secret: $name (project $PROJECT_ID)." >&2
    exit 1
  fi
}

put_env() {
  local key="$1"
  local value="$2"
  printf '%s=%s\n' "$key" "$value" >> "$GITHUB_ENV_PATH"
}

require_secret_exists() {
  local name="$1"
  if ! gcloud secrets describe "$name" --project="$PROJECT_ID" >/dev/null 2>&1; then
    echo "Missing required GCP secret: $name (project $PROJECT_ID)." >&2
    exit 1
  fi
}

BACKEND_URL="$(get_secret BACKEND_URL)"
require_value BACKEND_URL "$BACKEND_URL"
APP_URL="$(get_secret APP_FRONTEND_ORIGIN)"
[[ -n "$APP_URL" ]] || APP_URL="https://uat.one.hushh.ai"
FB_API_KEY="$(get_secret NEXT_PUBLIC_FIREBASE_API_KEY)"; require_value NEXT_PUBLIC_FIREBASE_API_KEY "$FB_API_KEY"
FB_AUTH_DOMAIN="$(get_secret NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN)"; require_value NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN "$FB_AUTH_DOMAIN"
FB_PROJECT_ID="$(get_secret NEXT_PUBLIC_FIREBASE_PROJECT_ID)"; require_value NEXT_PUBLIC_FIREBASE_PROJECT_ID "$FB_PROJECT_ID"
FB_STORAGE="$(get_secret NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET)"; require_value NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET "$FB_STORAGE"
FB_SENDER="$(get_secret NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID)"; require_value NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID "$FB_SENDER"
FB_APP_ID="$(get_secret NEXT_PUBLIC_FIREBASE_APP_ID)"; require_value NEXT_PUBLIC_FIREBASE_APP_ID "$FB_APP_ID"
FB_VAPID="$(get_secret NEXT_PUBLIC_FIREBASE_VAPID_KEY)"; require_value NEXT_PUBLIC_FIREBASE_VAPID_KEY "$FB_VAPID"
FB_MEASUREMENT="$(get_secret NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID)"
[[ -n "$FB_MEASUREMENT" ]] || FB_MEASUREMENT="$(get_secret NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID_UAT)"
[[ -n "$FB_MEASUREMENT" ]] || FB_MEASUREMENT="$(get_secret NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID_STAGING)"
MAPS_IOS_KEY="$(get_secret NEXT_PUBLIC_GOOGLE_MAPS_IOS_API_KEY)"
MAPS_BROWSER_KEY="$(get_secret NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY)"
require_value NEXT_PUBLIC_GOOGLE_MAPS_IOS_API_KEY "$MAPS_IOS_KEY"
require_value NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY "$MAPS_BROWSER_KEY"

# These values are public application configuration but masking keeps logs and
# accidental shell diagnostics from becoming a disclosure channel.
for value in "$FB_API_KEY" "$FB_VAPID" "$MAPS_IOS_KEY" "$MAPS_BROWSER_KEY"; do
  [[ -n "$value" ]] && echo "::add-mask::$value"
done

put_env APP_RUNTIME_PROFILE "uat"
put_env NEXT_PUBLIC_APP_ENV "uat"
put_env NEXT_PUBLIC_BACKEND_URL "$BACKEND_URL"
put_env NEXT_PUBLIC_APP_URL "$APP_URL"
put_env NEXT_PUBLIC_PASSKEY_RP_ID "uat.one.hushh.ai"
put_env NEXT_PUBLIC_FIREBASE_API_KEY "$FB_API_KEY"
put_env NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN "$FB_AUTH_DOMAIN"
put_env NEXT_PUBLIC_FIREBASE_PROJECT_ID "$FB_PROJECT_ID"
put_env NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET "$FB_STORAGE"
put_env NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID "$FB_SENDER"
put_env NEXT_PUBLIC_FIREBASE_APP_ID "$FB_APP_ID"
put_env NEXT_PUBLIC_FIREBASE_VAPID_KEY "$FB_VAPID"
[[ -n "$FB_MEASUREMENT" ]] && put_env NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID "$FB_MEASUREMENT"
put_env NEXT_PUBLIC_GOOGLE_MAPS_IOS_API_KEY "$MAPS_IOS_KEY"
put_env NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY "$MAPS_BROWSER_KEY"
put_env NEXT_PUBLIC_OBSERVABILITY_ENABLED "true"
put_env NEXT_PUBLIC_OBSERVABILITY_DEBUG "false"
put_env NEXT_PUBLIC_OBSERVABILITY_SAMPLE_RATE "1"

require_secret_exists IOS_GOOGLESERVICE_INFO_PLIST_B64
PLIST_SOURCE="GoogleService-Info.plist"
umask 077
gcloud secrets versions access latest \
  --secret=IOS_GOOGLESERVICE_INFO_PLIST_B64 \
  --project="$PROJECT_ID" \
  | openssl base64 -d -A > "$PLIST_SOURCE"
if ! plutil -lint "$PLIST_SOURCE" >/dev/null 2>&1; then
  echo "Decoded GoogleService-Info.plist failed plist validation." >&2
  exit 1
fi

echo "Materialized the UAT iOS build contract for bundle $IOS_BUNDLE_ID."
