#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
WEB_DIR="$REPO_ROOT/hushh-webapp"

# shellcheck source=scripts/ci/web-common.sh
source "$REPO_ROOT/scripts/ci/web-common.sh"

web_ci_preflight
web_ci_install

CHANGED_FILE_LIST="$(web_ci_changed_files)"

if [ -z "$CHANGED_FILE_LIST" ]; then
  echo "No changed files resolved for targeted web checks."
  exit 0
fi

changed_count="$(printf '%s\n' "$CHANGED_FILE_LIST" | sed '/^[[:space:]]*$/d' | wc -l | tr -d ' ')"
printf 'Resolved %s changed file(s) for targeted web checks.\n' "$changed_count"

has_match() {
  local pattern="$1"
  printf '%s\n' "$CHANGED_FILE_LIST" | grep -Eq "$pattern"
}

run_check() {
  local name="$1"
  shift
  echo "== Targeted web check: $name =="
  (cd "$WEB_DIR" && "$@")
}

ran=0

if has_match '^hushh-webapp/(lib/voice/|components/agent/|scripts/voice/|__tests__/.*(voice|agent)|app/api/(kai|one)/.*(voice|realtime)|\.voice-action-contract\.json)'; then
  run_check "voice gateway" npm run verify:voice-gateway
  ran=1
fi

if has_match '^hushh-webapp/(lib/services/.*(cache|pkm|sync)|__tests__/services/.*(cache|pkm|stale-resource)|scripts/architecture/audit-cache-coherence\.mjs)'; then
  run_check "cache contract" npm run verify:cache
  ran=1
fi

if has_match '^hushh-webapp/(lib/(analytics|observability)|__tests__/services/observability-|scripts/testing/run-observability|scripts/testing/run-uat-analytics|components/.*/.*analytics)'; then
  run_check "analytics contract" npm run verify:analytics
  ran=1
fi

if has_match '^hushh-webapp/(components/.*/.*phone|__tests__/components/phone-verification|lib/services/.*phone|app/.*/.*phone)'; then
  run_check "phone verification" npm run verify:phone-verification
  ran=1
fi

if has_match '^hushh-webapp/(app/|components/app-ui/|lib/(navigation|routes|surface|screen)|scripts/architecture/generate-surface-map\.mjs|scripts/testing/verify-signed-in-routes\.mjs)'; then
  run_check "surface map" npm run verify:surface-map
  ran=1
fi

if has_match '^(hushh-webapp/(ios/|android/|capacitor\.config|scripts/native/|public/manifest|public/.*icon|app/manifest)|GoogleService-Info\.plist)'; then
  run_check "Capacitor static parity" npm run verify:capacitor:static
  ran=1
fi

# Connect People search is an alphabetical index, not a filtered page (fixed in
# 2afe801be). The behaviour lives in two halves that can disagree: the server
# matches, ranks and orders ahead of LIMIT, and the client renders that page
# unchanged. Re-introducing a client-side filter or sort on top of a paged
# server result IS the original bug, and it is one merge-conflict resolution
# away at all times -- branches cut before the fix still carry the old
# `sortedPeople` filter verbatim, and a merge that resolves the wrong way puts
# it straight back with nothing to notice.
#
# These tests already existed and already named the behaviour. They simply
# never ran on a pull request: ci.yml has no vitest lane, so the full suite
# only executes in the merge queue -- which every review-bypass user skips.
# That asymmetry is why a red contract test sat unnoticed on main for a day.
# Run them wherever the behaviour can be touched, including from the backend
# half, because the client contract is "render the page you were handed".
if has_match '^(hushh-webapp/(app/connect/|__tests__/app/connect/)|consent-protocol/(hushh_mcp/services/(connections_service|one_location_agent_service)\.py|api/routes/one/connections\.py))'; then
  run_check "Connect people search" npm run verify:connect-search
  ran=1
fi

if [ "$ran" -eq 0 ]; then
  echo "No focused web contract pack matched the changed files."
fi
