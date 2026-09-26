#!/usr/bin/env bash
# Verifies the browser Google Maps key accepts every origin this app actually
# runs at, and permits every Maps service the client calls.
#
# Usage:  skills/client-env-parity/check-key-origins.sh [GCP_PROJECT]
#         (default project: hushh-pda-uat)
#
# Needs: gcloud authenticated. Read-only — it never modifies a key.
set -uo pipefail

PROJECT="${1:-hushh-pda-uat}"
SECRET="NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY"

# Origins the app runs at. Derived from hushh-webapp/capacitor.config.ts:
#   ios.scheme / server.iosScheme = "App"   -> App://localhost
#   server.androidScheme = "https"          -> https://localhost
# plus the hosted site and local dev. A key missing any of these fails ONLY on
# that surface, and fails silently (the map degrades to an iframe embed).
REQUIRED_REFERRERS=(
  "App://localhost/*"
  "capacitor://localhost/*"
  "http://localhost/*"
  "https://localhost/*"
)
# Services the browser bundle calls: Maps JS draws the map, Places powers the
# onboarding picker's nearest-place lookup, Routes is used by route previews.
REQUIRED_SERVICES=(
  "maps-backend.googleapis.com"
  "places.googleapis.com"
  "routes.googleapis.com"
)

KEY_STRING="$(gcloud secrets versions access latest --secret="$SECRET" --project="$PROJECT" 2>/dev/null)"
if [ -z "$KEY_STRING" ]; then
  echo "FAIL — cannot read secret $SECRET in $PROJECT." >&2
  exit 1
fi

# Resolve the key by matching its actual key string, not by display name —
# display names drift, and a renamed key would silently pass a name-based check.
KEY_NAME=""
while read -r uid; do
  [ -n "$uid" ] || continue
  ks="$(gcloud services api-keys get-key-string "$uid" --project="$PROJECT" --format='value(keyString)' 2>/dev/null)"
  if [ "$ks" = "$KEY_STRING" ]; then KEY_NAME="$uid"; break; fi
done < <(gcloud services api-keys list --project="$PROJECT" --format='value(uid)' 2>/dev/null)

if [ -z "$KEY_NAME" ]; then
  echo "FAIL — the value in $SECRET matches no API key in $PROJECT." >&2
  echo "       The secret and the key have drifted apart." >&2
  exit 1
fi

DESC="$(gcloud services api-keys describe "$KEY_NAME" --project="$PROJECT" --format=json 2>/dev/null)"
REFERRERS="$(printf '%s' "$DESC" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("\n".join(d.get("restrictions",{}).get("browserKeyRestrictions",{}).get("allowedReferrers",[])))')"
SERVICES="$(printf '%s' "$DESC" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("\n".join(t["service"] for t in d.get("restrictions",{}).get("apiTargets",[])))')"

fail=0

# An empty referrer list means "any site may use this key" — not a pass.
if [ -z "$REFERRERS" ]; then
  echo "FAIL  the key has NO referrer restriction at all (usable from any site)"
  fail=1
else
  for want in "${REQUIRED_REFERRERS[@]}"; do
    printf '%s\n' "$REFERRERS" | grep -qixF "$want" \
      || { echo "MISSING referrer  $want"; fail=1; }
  done
fi

if [ -z "$SERVICES" ]; then
  echo "WARN  no API restriction — the key may call any Google API"
else
  for want in "${REQUIRED_SERVICES[@]}"; do
    printf '%s\n' "$SERVICES" | grep -qxF "$want" \
      || { echo "MISSING service   $want"; fail=1; }
  done
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "OK — browser maps key in $PROJECT accepts every app origin and service."
else
  echo "FAIL — the browser maps key rejects a surface the app really runs on."
  echo "Widen it with the FULL list (update replaces, it does not append):"
  echo "  gcloud services api-keys update <KEY_ID> --project=$PROJECT \\"
  for s in "${REQUIRED_SERVICES[@]}"; do echo "    --api-target=service=$s \\"; done
  echo "    --allowed-referrers='https://<host>/*','http://localhost:3000/*',$(printf "'%s'," "${REQUIRED_REFERRERS[@]}" | sed 's/,$//')"
fi
exit "$fail"
