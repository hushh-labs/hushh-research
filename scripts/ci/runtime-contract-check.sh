#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"

backend_helper="$REPO_ROOT/hushh-webapp/app/api/_utils/backend.ts"
backend_cloudbuild="$REPO_ROOT/deploy/backend.cloudbuild.yaml"
frontend_cloudbuild="$REPO_ROOT/deploy/frontend.cloudbuild.yaml"
ria_proxy_route="$REPO_ROOT/hushh-webapp/app/api/ria/[...path]/route.ts"

if grep -q 'consent-protocol-rpphvsc3tq-uc.a.run.app' "$backend_helper"; then
  echo "❌ backend route helper still hardcodes a production backend fallback."
  exit 1
fi

if ! grep -q 'do not guess a backend origin' "$backend_helper"; then
  echo "❌ backend route helper is missing the hosted fail-fast contract."
  exit 1
fi

if ! grep -q 'BACKEND_URL=BACKEND_URL:latest' "$frontend_cloudbuild"; then
  echo "❌ frontend Cloud Run deploy must inject BACKEND_URL at runtime."
  exit 1
fi

if ! grep -q 'DEVELOPER_API_URL=BACKEND_URL:latest' "$frontend_cloudbuild"; then
  echo "❌ frontend Cloud Run deploy must inject DEVELOPER_API_URL at runtime."
  exit 1
fi

# The Docker Cloud Builder image does not ship gcloud. Google Contacts client
# resolution must stay in a Cloud SDK step and pass only the public client id to
# the Docker step through Cloud Build's ephemeral workspace.
google_contacts_lookup_step="$(
  awk '
    /name: "gcr.io\/google.com\/cloudsdktool\/cloud-sdk"/ { current_step = "cloud-sdk" }
    /name: "gcr.io\/cloud-builders\/docker"/ { current_step = "docker" }
    /gcloud secrets versions access latest/ {
      print current_step
      exit
    }
  ' "$frontend_cloudbuild"
)"
if [ "$google_contacts_lookup_step" != "cloud-sdk" ]; then
  echo "❌ Google Contacts Secret Manager lookup must run in a Cloud SDK step, not the Docker builder."
  exit 1
fi

if grep -q "NOT_FOUND|not found" "$frontend_cloudbuild"; then
  echo "❌ Google Contacts secret handling must not treat generic 'not found' text as a Secret Manager NOT_FOUND status."
  exit 1
fi

google_contacts_artifact_refs="$(
  grep -c '/workspace/.google-contacts-client-id' "$frontend_cloudbuild" || true
)"
if [ "$google_contacts_artifact_refs" -lt 2 ]; then
  echo "❌ Google Contacts client resolution must hand off through the ephemeral Cloud Build workspace."
  exit 1
fi

if ! grep -q -- '--build-arg "NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID=' "$frontend_cloudbuild"; then
  echo "❌ frontend Cloud Build must pass NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID to the web image."
  exit 1
fi

for association_secret in \
  APPLE_TEAM_ID \
  NEXT_PUBLIC_IOS_BUNDLE_ID \
  NEXT_PUBLIC_ANDROID_APP_ID \
  ANDROID_SHA256_CERT_FINGERPRINTS; do
  if ! grep -q "${association_secret}=${association_secret}:latest" "$frontend_cloudbuild"; then
    echo "❌ frontend Cloud Run deploy must inject ${association_secret} for native passkey association."
    exit 1
  fi
done

android_manifest="$REPO_ROOT/hushh-webapp/android/app/src/main/AndroidManifest.xml"
android_strings="$REPO_ROOT/hushh-webapp/android/app/src/main/res/values/strings.xml"
if ! grep -q 'android:name="asset_statements"' "$android_manifest"; then
  echo "❌ Android manifest must declare Credential Manager Digital Asset Links."
  exit 1
fi
if ! grep -q 'https://one.hushh.ai/.well-known/assetlinks.json' "$android_strings"; then
  echo "❌ Android passkeys must use the canonical one.hushh.ai association document."
  exit 1
fi

if ! grep -q -- '--set-env-vars=NEXT_PUBLIC_APP_ENV=' "$frontend_cloudbuild"; then
  echo "❌ frontend Cloud Run deploy must inject NEXT_PUBLIC_APP_ENV at runtime."
  exit 1
fi

frontend_timeout_seconds="$(
  grep -Eo -- '--timeout=[0-9]+' "$frontend_cloudbuild" | head -n 1 | cut -d= -f2 || true
)"
if [ -z "$frontend_timeout_seconds" ] && grep -q -- '--timeout=${_CLOUD_RUN_TIMEOUT_SECONDS}' "$frontend_cloudbuild"; then
  frontend_timeout_seconds="$(
    grep -E '^[[:space:]]*_CLOUD_RUN_TIMEOUT_SECONDS:' "$frontend_cloudbuild" |
      head -n 1 |
      sed -E 's/.*"([0-9]+)".*/\1/'
  )"
fi
if [ -z "$frontend_timeout_seconds" ]; then
  echo "❌ frontend Cloud Run deploy must declare an explicit request timeout."
  exit 1
fi

if [ "$frontend_timeout_seconds" -lt 120 ]; then
  echo "❌ frontend Cloud Run timeout must be at least 120s for long-running RIA verification."
  exit 1
fi

if ! grep -q 'process.env.RIA_ONBOARDING_PROXY_TIMEOUT_MS' "$ria_proxy_route"; then
  echo "❌ RIA onboarding proxy must read RIA_ONBOARDING_PROXY_TIMEOUT_MS."
  exit 1
fi

onboarding_proxy_timeout_ms="$(
  grep -Eo 'RIA_ONBOARDING_PROXY_TIMEOUT_MS=[0-9]+' "$frontend_cloudbuild" | head -n 1 | cut -d= -f2
)"
if [ -z "$onboarding_proxy_timeout_ms" ]; then
  echo "❌ frontend Cloud Run deploy must inject RIA_ONBOARDING_PROXY_TIMEOUT_MS."
  exit 1
fi

if [ "$((frontend_timeout_seconds * 1000))" -le "$onboarding_proxy_timeout_ms" ]; then
  echo "❌ frontend Cloud Run timeout must be greater than the RIA onboarding proxy timeout."
  exit 1
fi

if ! grep -q 'RIA_INTELLIGENCE_CRD_SCRAPER_TIMEOUT_SECONDS=${_RIA_INTELLIGENCE_CRD_SCRAPER_TIMEOUT_SECONDS}' "$backend_cloudbuild"; then
  echo "❌ backend Cloud Run deploy must inject RIA_INTELLIGENCE_CRD_SCRAPER_TIMEOUT_SECONDS."
  exit 1
fi

crd_scraper_timeout_seconds="$(
  grep -E '^[[:space:]]*_RIA_INTELLIGENCE_CRD_SCRAPER_TIMEOUT_SECONDS:' "$backend_cloudbuild" |
    head -n 1 |
    sed -E 's/.*"([0-9]+)".*/\1/'
)"
if ! [[ "$crd_scraper_timeout_seconds" =~ ^[0-9]+$ ]]; then
  echo "❌ RIA_INTELLIGENCE_CRD_SCRAPER_TIMEOUT_SECONDS substitution must be a whole number of seconds."
  exit 1
fi

if [ "$crd_scraper_timeout_seconds" -lt 60 ]; then
  echo "❌ RIA Intelligence provider client timeout must be at least 60s."
  exit 1
fi

if ! grep -q 'RIA_ONBOARDING_PROVIDER_TIMEOUT_SECONDS=${_RIA_ONBOARDING_PROVIDER_TIMEOUT_SECONDS}' "$backend_cloudbuild"; then
  echo "❌ backend Cloud Run deploy must inject RIA_ONBOARDING_PROVIDER_TIMEOUT_SECONDS."
  exit 1
fi

provider_timeout_seconds="$(
  grep -E '^[[:space:]]*_RIA_ONBOARDING_PROVIDER_TIMEOUT_SECONDS:' "$backend_cloudbuild" |
    head -n 1 |
    sed -E 's/.*"([0-9]+)".*/\1/'
)"
if ! [[ "$provider_timeout_seconds" =~ ^[0-9]+$ ]]; then
  echo "❌ RIA_ONBOARDING_PROVIDER_TIMEOUT_SECONDS substitution must be a whole number of seconds."
  exit 1
fi

if [ "$provider_timeout_seconds" -lt "$crd_scraper_timeout_seconds" ]; then
  echo "❌ RIA onboarding provider timeout must be >= the provider client timeout."
  exit 1
fi

if [ "$((provider_timeout_seconds * 1000))" -ge "$onboarding_proxy_timeout_ms" ]; then
  echo "❌ RIA onboarding provider timeout must stay below the frontend proxy timeout."
  exit 1
fi

# --- Location map demo fixture -------------------------------------------
#
# `?demo=people` renders fifty fabricated people on the location map. It is an
# operator preview, and in a product whose entire promise is that the map shows
# only people who chose to share with you, showing it to a real user is the
# worst bug the surface has.
#
# The client gate (`lib/testing/location-map-demo.ts`) is an explicit opt-in
# rather than `APP_ENV !== "production"`, because the App Store and Play Store
# binaries are stamped `NEXT_PUBLIC_APP_ENV=uat` — an environment-shaped check
# reads every store install as non-production. An opt-in is only as good as the
# plumbing that carries it, so assert the whole chain here: a build arg that is
# declared but never passed leaves the flag permanently false and the preview
# silently gone, and a production lane that passes `true` is the incident.
webapp_dockerfile="$REPO_ROOT/hushh-webapp/Dockerfile"

if ! grep -q '^ARG NEXT_PUBLIC_LOCATION_MAP_DEMO$' "$webapp_dockerfile"; then
  echo "❌ webapp Dockerfile must declare the NEXT_PUBLIC_LOCATION_MAP_DEMO build arg."
  exit 1
fi

if ! grep -q '^ENV NEXT_PUBLIC_LOCATION_MAP_DEMO=\$NEXT_PUBLIC_LOCATION_MAP_DEMO$' "$webapp_dockerfile"; then
  echo "❌ webapp Dockerfile must promote NEXT_PUBLIC_LOCATION_MAP_DEMO into the build env."
  exit 1
fi

if ! grep -q -- '--build-arg NEXT_PUBLIC_LOCATION_MAP_DEMO=${_LOCATION_MAP_DEMO}' "$frontend_cloudbuild"; then
  echo "❌ frontend Cloud Build must pass NEXT_PUBLIC_LOCATION_MAP_DEMO from the _LOCATION_MAP_DEMO substitution."
  exit 1
fi

location_map_demo_default="$(
  grep -E '^[[:space:]]*_LOCATION_MAP_DEMO:' "$frontend_cloudbuild" |
    head -n 1 |
    sed -E 's/.*"([^"]*)".*/\1/'
)"
if [ "$location_map_demo_default" != "false" ]; then
  echo "❌ _LOCATION_MAP_DEMO must default to \"false\" so a lane has to opt in deliberately."
  exit 1
fi

# No deploy lane may enable the fixture. Guarding production alone was not
# enough: UAT shipped `_LOCATION_MAP_DEMO=true`, and UAT is not a private
# sandbox — it is the frontend every reviewer, tester, and demo audience sees,
# and the backend the store builds point at. Fifty fabricated people on a map
# whose entire promise is "only the people who chose to share with you appear
# here" is the same incident wherever it lands, so the ban is lane-wide and a
# lane that genuinely wants the fixture has to say so outside CI.
for workflow in "$REPO_ROOT"/.github/workflows/*.yml; do
  if grep -q '_LOCATION_MAP_DEMO=true' "$workflow"; then
    echo "❌ $(basename "$workflow") enables the fabricated-people map fixture (_LOCATION_MAP_DEMO=true)."
    echo "   No deploy lane may ship it. Real users cannot tell a fixture from a person."
    exit 1
  fi
done

# --- Nearby check-in on public store builds -------------------------------
#
# Same failure shape as the map demo fixture above, and the same reason. The
# architecture doc calls nearby check-in "a visibly labelled local/UAT
# simulation" that still needs organizer admission proof, replay resistance and
# bidirectional Block/Report before spoof resistance may be claimed. The public
# store binaries are stamped `NEXT_PUBLIC_APP_ENV=uat`, so an
# environment-shaped gate reads them as non-production and offers it anyway.
#
# The client now requires an explicit opt-in everywhere but local development.
# Assert that, and assert the two PUBLIC store lanes never opt in. TestFlight is
# deliberately not covered: it is an internal tester lane, and turning the flow
# on there is a legitimate choice for whoever owns that build.
nearby_availability="$REPO_ROOT/hushh-webapp/lib/one-location/nearby-check-in-availability.ts"

# Comment lines are stripped first: the file documents the old gate on purpose,
# and matching that prose would fail the build for explaining itself.
if sed -e 's://.*::' -e '/^[[:space:]]*\*/d' "$nearby_availability" |
  grep -q 'resolveAppEnvironment() !== "production"'; then
  echo "❌ nearby check-in must not gate on an environment comparison; store builds are stamped uat."
  exit 1
fi

if ! grep -q 'NEXT_PUBLIC_ONE_LOCATION_NEARBY_CHECK_IN' "$nearby_availability"; then
  echo "❌ nearby check-in availability must read its explicit opt-in flag."
  exit 1
fi

for public_store_lane in \
  "$REPO_ROOT/.github/workflows/release-ios-appstore.yml" \
  "$REPO_ROOT/.github/workflows/ship-android-playstore-v1.yml"; do
  if grep -qE 'NEXT_PUBLIC_ONE_LOCATION_NEARBY_CHECK_IN[ ="]+true' "$public_store_lane"; then
    echo "❌ $(basename "$public_store_lane") must not enable nearby check-in for public store users."
    exit 1
  fi
done

echo "✅ Runtime contract check passed."
