#!/usr/bin/env bash
# Restores the reviewer session on a phone for the iOS truth lane.
#
# The truth lane runs Release with test mode off, and test mode is the only
# automated sign-in (it is compiled out of Release on purpose). So once the
# app is signed out, by a /logout route in a sweep or an expired session,
# every attached run sits on "Welcome to One" until someone signs in by hand.
# This builds the Debug app, lets its reviewer bootstrap sign in and unlock
# once with -UITestResetAppState false, and leaves that session in the app's
# data container; the next Release install lands on top of it and keeps it.
#
# Usage (from hushh-webapp/, reviewer env loaded):
#   eval "$(node scripts/testing/export-reviewer-test-env.mjs)"
#   IOS_DEVICE_ID=<udid> bash scripts/perf/ios-reviewer-signin.sh
# PERF_SKIP_BUILD=1 reuses the last Debug build in PERF_SIGNIN_DERIVED_DATA.
#
# XCTest records typed strings inside the result bundle, so the bundle lives
# only for the length of the run, like the perf card's.
set -euo pipefail

WEB_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$WEB_DIR"

if [[ -z "${IOS_DEVICE_ID:-}" ]]; then
  echo "IOS_DEVICE_ID is required (xcrun devicectl list devices)." >&2
  exit 1
fi
if [[ -z "${HUSHH_UI_TEST_REVIEWER_VAULT_PASSPHRASE:-${REVIEWER_VAULT_PASSPHRASE:-}}" ]]; then
  echo "No reviewer passphrase in the environment; run: eval \"\$(node scripts/testing/export-reviewer-test-env.mjs)\"" >&2
  exit 1
fi

DERIVED="${PERF_SIGNIN_DERIVED_DATA:-/tmp/hushh-ios-dd-device-debug}"
DESTINATION="platform=iOS,id=$IOS_DEVICE_ID"
OUT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/hushh-ios-signin.XXXXXX")"

# Same reasoning as the perf card: the uid the backend mints drifts from the
# env file's REVIEWER_UID, and a pinned mismatch stalls the bootstrap.
REVIEWER_UID="${PERF_REVIEWER_UID:-$(node scripts/perf/resolve-reviewer-uid.mjs)}"
if [[ -z "$REVIEWER_UID" ]]; then
  echo "Reviewer uid did not resolve; set PERF_REVIEWER_UID or check the backend." >&2
  exit 1
fi

cd ios/App
if [[ "${PERF_SKIP_BUILD:-0}" != "1" ]]; then
  echo "building Debug for $DESTINATION (log: $OUT_DIR/build.log)"
  xcodebuild -project App.xcodeproj -scheme App -configuration Debug -sdk iphoneos \
    -destination "$DESTINATION" -derivedDataPath "$DERIVED" -allowProvisioningUpdates \
    build-for-testing > "$OUT_DIR/build.log" 2>&1 \
    || { echo "build-for-testing failed; see $OUT_DIR/build.log" >&2; exit 1; }
fi

RESULT_BUNDLE="$OUT_DIR/signin.xcresult"
set +e
env TEST_RUNNER_HUSHH_UI_TEST_REVIEWER_UID="$REVIEWER_UID" \
    TEST_RUNNER_REVIEWER_UID="$REVIEWER_UID" \
    TEST_RUNNER_HUSHH_UI_TEST_REVIEWER_VAULT_PASSPHRASE="${HUSHH_UI_TEST_REVIEWER_VAULT_PASSPHRASE:-$REVIEWER_VAULT_PASSPHRASE}" \
    TEST_RUNNER_REVIEWER_VAULT_PASSPHRASE="${REVIEWER_VAULT_PASSPHRASE:-}" \
  xcodebuild -project App.xcodeproj -scheme App -configuration Debug -sdk iphoneos \
    -destination "$DESTINATION" -derivedDataPath "$DERIVED" -allowProvisioningUpdates \
    -resultBundlePath "$RESULT_BUNDLE" \
    -only-testing:AppUITests/AppUITests/testReviewerSignInForTruthLane test-without-building > "$OUT_DIR/test.log" 2>&1
STATUS=$?
set -e
rm -rf "$RESULT_BUNDLE"
find "$DERIVED/Logs/Test" -maxdepth 1 -name '*.xcresult' -exec rm -rf {} + 2>/dev/null || true

if [[ $STATUS -ne 0 ]] || ! grep -q "PERF_REVIEWER_SIGNED_IN" "$OUT_DIR/test.log"; then
  echo "reviewer sign-in failed (exit $STATUS); see $OUT_DIR/test.log" >&2
  exit 1
fi
echo "reviewer signed in and unlocked on $IOS_DEVICE_ID; the next Release run keeps the session"
