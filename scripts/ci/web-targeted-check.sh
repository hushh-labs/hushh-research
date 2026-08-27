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

# Feed is the notification inbox across web and native. Its contract spans the
# page, live providers, FCM/SW bridges, navigation handoff, unread/cache state,
# and the generated browser fixture. Keep that cross-surface pack together so a
# focused PR cannot update one half while only exercising an unrelated lane.
if has_match '^(hushh-webapp/(app/one/feed/|app/providers\.tsx|components/(app-ui/settings-ui\.tsx|consent/notification-provider\.tsx|feed/|navbar\.tsx)|lib/(cache/(cache-sync-service|use-stale-resource)\.ts|feed/|notifications/|services/feed-service\.ts|utils/browser-navigation\.ts)|public/firebase-messaging-sw\.js|capacitor\.config\.ts|ios/App/App/AppDelegate\.swift|scripts/(architecture/audit-cache-coherence\.mjs|testing/(capture-feed-needs-you-fixture|verify-signed-in-routes)\.mjs)|e2e/(feed-needs-you-row\.layout\.spec\.ts|fixtures/feed-needs-you-rows\.html)|__tests__/.*(feed|notification-provider|firebase-messaging|fcm-|browser-navigation-pending|navbar-bottom-nav|cache-sync-mutation-cascade|use-stale-resource-lifecycle))|consent-protocol/(api/(routes/one/feed\.py|utils/fcm_messages\.py)|hushh_mcp/services/(account_service|broker_funding_service|feed_service|one_location_agent_service|one_location_circle_service|push_notifications)\.py|db/.*(feed_notification_projection_coverage|circle_feed_durability)|tests/.*(feed|fcm|push_notifications|broker_funding_transfer_notification_task_ref|one_location_list_state_resilience)))'; then
  run_check "Feed notifications" npm run verify:feed
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
#
# `lib/services/connections-service.ts` is in this list because the payload
# shape is half the contract: the RIAs tab filters its connections on a row
# flag that has to survive the service type on its way from the Python half to
# the screen, and a change confined to that file used to match no pack at all.
# `lib/contacts/` and `contact-matching.ts` are in here because contact sync is
# shared code with two front doors: the One Location agent and, now, Connect's
# People section. A change to the region resolver or the matcher is a change to
# both screens, so both packs have to re-run -- and until this was added, a
# change confined to `lib/contacts/` matched no pack in the repo at all.
if has_match '^(hushh-webapp/(app/connect/|__tests__/app/connect/|lib/services/connections-service\.ts|lib/contacts/|lib/marketplace/contact-matching\.ts)|consent-protocol/(hushh_mcp/services/(connections_service|one_location_agent_service)\.py|api/routes/one/connections\.py))'; then
  run_check "Connect people search" npm run verify:connect-search
  ran=1
fi

# The share ladder, and the origin a shared link has to carry.
#
# Both were extracted out of lib/one-location so Connect's "Invite them to One"
# could reuse them instead of copying a ladder that had already been debugged
# once. That leaves one module with two live consumers -- the Circle invite
# share and Connect's invite -- and only the Connect half looks like Connect. A
# change to lib/share/ that reads as Connect work can therefore break the
# Circle invite, on a pull request where nothing in components/one-location/ or
# app/connect/ was touched and no pack above fires.
#
# The origin resolver is the one that matters. Capacitor does not serve the
# installed app from a web origin (App://localhost on iOS, https://localhost on
# Android), so a regression there ships a link that is dead for every recipient
# and looks perfectly correct in a browser -- the exact bug the Circle invite
# was fixed for once already.
#
# Both consumers' suites run, not just the new one, because "the extraction did
# not change Circle behaviour" is the claim that needs holding.
if has_match '^hushh-webapp/(lib/share/|lib/connect/|__tests__/share/|__tests__/connect/|lib/one-location/(share-circle-code|circle-join-url)\.ts)'; then
  run_check "Share ladder and link origin" npm run verify:share-ladder
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
if has_match '^hushh-webapp/(components/one-location/|__tests__/components/one-location|app/one/location/|lib/one-location/|lib/contacts/|lib/marketplace/contact-matching\.ts)'; then
  run_check "One Location flows" npm run verify:one-location
  ran=1
fi

# The referral program.
#
# The Referrals tab renders numbers it must never compute: the qualified count,
# the status of each referral and the qualification bar all arrive decided by
# the server. A change that turns any of them into a client-side calculation --
# counting the rows in the list instead of reading the count, or hardcoding 15
# minutes instead of rendering what the policy returned -- looks harmless in
# review and quietly makes the number meaningless.
#
# The Python half is in the same pack deliberately. The panel's contract is
# "render exactly the summary you were handed", so a field removed from
# one_referral_service.py breaks the screen on a pull request where nothing
# under hushh-webapp/ was touched at all.
if has_match '^(hushh-webapp/(components/profile/referrals-panel\.tsx|lib/services/referral-service\.ts|__tests__/(components/referrals-panel|services/referral-(service|attribution|stream))|lib/referral/|app/r/|app/api/one/referrals/|app/one/profile/referrals/)|consent-protocol/(hushh_mcp/(services/one_referral_service|operons/referral/)|api/(routes/one/referrals\.py|referral_listener\.py)))'; then
  run_check "Referral program" npm run verify:referrals
  ran=1
fi

# The accent identity.
#
# `lib/theme/accent.ts` owns the one switchable accent, and now also
# `resolvedAccentHex()` -- the accent as a LITERAL, for a consumer that cannot
# resolve a CSS custom property at all. The static token scan in Web Core
# catches a raw hex in a component; nothing ran the behaviour of the resolver
# those components now depend on, and getting it wrong is silent: an
# unparseable colour reaching @capacitor/google-maps draws Google's own default
# on web and flat blue on iOS, both of which look deliberate.
if has_match '^hushh-webapp/(lib/theme/|__tests__/lib/theme-accent)'; then
  run_check "accent identity" npm run verify:accent
  ran=1
fi

# The shared bottom-sheet primitive.
#
# `components/ui/sheet.tsx` is imported by ten surfaces and matched NO pack at
# all, so a change to the one component that decides whether a phone sheet can
# be dragged away -- and whether its close button is reachable underneath the
# drag handle -- ran zero tests on a pull request. Both of those have been real
# defects.
#
# `shared-sheet-consumers.contract.test.tsx` is reachable from the One Location
# pack too, but only when a file under components/one-location/ changes. A
# change confined to the primitive itself reaches it only through here.
if has_match '^hushh-webapp/(components/ui/sheet\.tsx|__tests__/components/(bottom-sheet-drag-dismiss|shared-sheet-consumers))'; then
  run_check "bottom sheet" npm run verify:bottom-sheet
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
