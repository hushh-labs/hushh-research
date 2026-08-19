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

# The first-run funnel: sign-in, phone verification, the lock, the setup hub,
# and every guard that decides which of them somebody is on.
#
# Nothing in this area matched any pack until now. The three guard suites, the
# gate composition test and the setup contract test all existed and all passed
# -- and none of them had ever run on a pull request, so the three defects this
# pack was written for (the lock screen re-appearing mid-flow, Back returning to
# phone verification, and the lock and phone screens on screen together) could
# each be reintroduced by an edit that no lane would notice.
#
# The route file and the composition root are in the list because the decision
# is only as good as where it is mounted: moving a guard in app/providers.tsx,
# re-nesting one in app/one/one-auth-gate.tsx, or adding a route to the funnel
# without adding it to ONBOARDING_ROUTES all break the contract from outside the
# guards themselves. HushhIntroGate is here because withholding the guards from
# the tree while it played is what made the surfaces collide in the first place.
#
# `lib/vault/` and `lib/services/vault-service.ts` were the hole. The pack
# covered `components/vault/` but not the module the whole funnel reads its lock
# answer from, so `vault-access-policy.ts` and `vault-context.tsx` — where
# CONFIGURED, LOCKED, UNLOCKED, LOADING and ERROR are actually told apart —
# could be changed on a pull request with no funnel test running at all. The
# `capability-vault-prerequisite` suite is here for the same reason: it is the
# only suite that asserts the create-vs-unlock distinction, and it sat red on
# main for days because no pack named it.
if has_match '^hushh-webapp/(lib/onboarding/|lib/vault/|components/onboarding/|components/auth/|components/vault/|components/app-ui/(HushhIntroGate|vault-status-inline)|__tests__/onboarding/|__tests__/lib/vault/|__tests__/components/(onboarding-journey-guard|phone-mandate-guard|vault-lock-guard|capability-vault-prerequisite)|__tests__/services/pre-vault-user-state-service|__tests__/app/(one/one-auth-gate|register-phone)|lib/navigation/routes\.ts|lib/services/(pre-vault-user-state-service|one-setup-completion-hint-service|phone-mandate-service|post-auth-route-service|vault-service)\.ts|app/(providers|page)\.tsx|app/one/(layout|one-auth-gate)\.tsx|app/(login|register-phone|getting-started)/|app/(kai|ria|marketplace|profile|one/consent|profile/pkm-agent-lab)/layout\.tsx)'; then
  run_check "onboarding funnel" npm run verify:onboarding-funnel
  ran=1
fi

if has_match '^hushh-webapp/(app/|components/app-ui/|lib/(navigation|routes|surface|screen)|scripts/architecture/generate-surface-map\.mjs|scripts/testing/verify-signed-in-routes\.mjs)'; then
  run_check "surface map" npm run verify:surface-map
  ran=1
fi

# `top-app-bar.tsx` had two unit-test files sitting next to it
# (top-app-bar.contract.test.ts, top-shell-breadcrumbs.test.ts) that no pack
# above actually ran -- an edit to the shared top bar or the breadcrumb
# resolver it reads from could pass CI green with either suite silently
# skipped. This is what caught the ancestor-crumb ellipsis regression
# (P... > S. > Lock methods) staying invisible to a PR.
if has_match '^hushh-webapp/(components/app-ui/top-app-bar\.tsx|lib/navigation/top-shell-breadcrumbs\.ts|lib/navigation/top-shell-back\.ts|__tests__/components/top-app-bar\.contract\.test\.ts|__tests__/utils/top-shell-breadcrumbs\.test\.ts)'; then
  run_check "top shell navigation" npm run verify:top-shell-navigation
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
#
# `lib/services/connections-service.ts` is in this list because the payload
# shape is half the contract: the RIAs tab filters its connections on a row
# flag that has to survive the service type on its way from the Python half to
# the screen, and a change confined to that file used to match no pack at all.
if has_match '^(hushh-webapp/(app/connect/|__tests__/app/connect/|lib/services/connections-service\.ts)|consent-protocol/(hushh_mcp/services/(connections_service|one_location_agent_service)\.py|api/routes/one/connections\.py))'; then
  run_check "Connect people search" npm run verify:connect-search
  ran=1
fi

# One Location's share and request flows. Until this pack existed, NOTHING in
# components/one-location/ matched any targeted glob above -- so the duration
# pickers, the share recipient picker and the whole hub could be changed on a
# pull request with no vitest running at all. (app/one/location/ matched the
# surface-map pack, but that verifies routes, not behaviour.) Three of the four
# defects this pack was written for were reported by a tester rather than
# caught here, and one of them -- an open-ended duration offered on the Request
# screen -- emits a non-numeric sentinel into a field the same lane runs
# Number() over.
if has_match '^hushh-webapp/(components/one-location/|__tests__/components/one-location|app/one/location/|lib/one-location/)'; then
  run_check "One Location flows" npm run verify:one-location
  ran=1
fi

# The browser-measured layout contracts.
#
# Until this pack, `test:layout-contracts` was referenced in exactly one place in
# the repository -- the script that defines it. 227 assertions across 11 spec
# files, every one of them written after a founder or tester reported a pixel
# defect, and none of them had ever run anywhere but on the author's laptop.
# JSDOM cannot prove a pixel, so these are the only tests in the web suite that
# can fail on overlap, clipping, tap-target height or a stretched control.
#
# Runs when a spec, a component a spec measures, the shell geometry, or
# globals.css changes -- which is what those specs are pinned to. The browsers
# are installed in the workflow step, not here, so a local run of this script
# uses whatever is already on the machine.
if has_match '^hushh-webapp/(e2e/.*\.layout\.spec\.ts|playwright\.config\.ts|app/globals\.css|components/app-ui/|components/one-location/|components/feed/|components/connect/)'; then
  run_check "layout contracts" npm run test:layout-contracts
  ran=1
fi

if [ "$ran" -eq 0 ]; then
  echo "No focused web contract pack matched the changed files."
fi
