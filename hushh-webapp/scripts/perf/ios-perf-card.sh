#!/bin/zsh
# Run the render-performance gesture card on an iOS simulator or a connected
# iPhone, pull the in-app probe's exports, and write the baseline table.
#
#   npm run perf:ios:card                       # booted simulator, attribution only
#   IOS_DEVICE_ID=<udid> npm run perf:ios:card  # a connected iPhone: the certifying run
#
# Knobs: HUSHH_PERF_REPS (default 3), HUSHH_PERF_TIER (default ios-sim on a
# simulator; REQUIRED on a device, redacted like ios-mid-2024), PERF_OUT_DIR
# (default tmp/perf/<timestamp>), PERF_SKIP_BUILD=1 to reuse the last test bundle.
#
# Reviewer identity comes from the env resolver (REVIEWER_UID /
# REVIEWER_VAULT_PASSPHRASE) and is handed to the test runner as process
# environment only; it is never written to disk, the log is grepped for the
# passphrase before it is kept, and only the summary is durable.
set -euo pipefail

cd "$(dirname "$0")/../.."
WEB_DIR="$(pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="${PERF_OUT_DIR:-$WEB_DIR/tmp/perf/$STAMP}"
mkdir -p "$OUT_DIR/probe"
DERIVED="${PERF_DERIVED_DATA:-/tmp/hushh-ios-dd}"
BUNDLE_ID="com.hushh.app"
REPS="${HUSHH_PERF_REPS:-3}"

eval "$(node scripts/testing/export-reviewer-test-env.mjs)"
if [[ -z "${REVIEWER_UID:-}" || -z "${REVIEWER_VAULT_PASSPHRASE:-}" ]]; then
  echo "Reviewer identity did not resolve (REVIEWER_UID / REVIEWER_VAULT_PASSPHRASE)." >&2
  exit 1
fi

if [[ -n "${IOS_DEVICE_ID:-}" ]]; then
  DESTINATION="platform=iOS,id=$IOS_DEVICE_ID"
  SDK="iphoneos"
  TIER="${HUSHH_PERF_TIER:-}"
  if [[ ! "$TIER" =~ ^(ios)-(floor|mid|flagship)-[0-9]{4}$ ]]; then
    echo "HUSHH_PERF_TIER must be a redacted tier like ios-mid-2024 for a device run." >&2
    exit 1
  fi
  CONFIGURATION="${PERF_CONFIGURATION:-Debug}"
else
  SIM="${IOS_SIMULATOR_ID:-$(xcrun simctl list devices booted -j | python3 -c 'import json,sys; d=json.load(sys.stdin); print(next((dev["udid"] for devs in d["devices"].values() for dev in devs if "iPhone" in dev["name"]), ""))')}"
  if [[ -z "$SIM" ]]; then
    echo "No booted iPhone simulator; boot one or pass IOS_SIMULATOR_ID." >&2
    exit 1
  fi
  DESTINATION="platform=iOS Simulator,id=$SIM"
  SDK="iphonesimulator"
  TIER="${HUSSH_PERF_TIER:-${HUSHH_PERF_TIER:-ios-sim}}"
  CONFIGURATION="${PERF_CONFIGURATION:-Debug}"
fi

SHA="$(git rev-parse --short HEAD)"
echo "perf card: $DESTINATION, configuration $CONFIGURATION, tier $TIER, reps $REPS, sha $SHA"
echo "artifacts: $OUT_DIR (raw log and probe JSON stay here; only the summary is committed)"

cd ios/App
if [[ "${PERF_SKIP_BUILD:-0}" != "1" ]]; then
  xcodebuild -project App.xcodeproj -scheme App -configuration "$CONFIGURATION" -sdk "$SDK" \
    -destination "$DESTINATION" -derivedDataPath "$DERIVED" build-for-testing > "$OUT_DIR/build.log" 2>&1 \
    || { echo "build-for-testing failed; see $OUT_DIR/build.log" >&2; exit 1; }
fi

set +e
env TEST_RUNNER_HUSHH_ENABLE_PERF_BENCHMARK=true \
    TEST_RUNNER_HUSHH_PERF_REPS="$REPS" \
    TEST_RUNNER_HUSHH_UI_TEST_REVIEWER_UID="${HUSHH_UI_TEST_REVIEWER_UID:-$REVIEWER_UID}" \
    TEST_RUNNER_HUSHH_UI_TEST_REVIEWER_VAULT_PASSPHRASE="${HUSHH_UI_TEST_REVIEWER_VAULT_PASSPHRASE:-$REVIEWER_VAULT_PASSPHRASE}" \
    TEST_RUNNER_REVIEWER_UID="$REVIEWER_UID" \
    TEST_RUNNER_REVIEWER_VAULT_PASSPHRASE="$REVIEWER_VAULT_PASSPHRASE" \
  xcodebuild -project App.xcodeproj -scheme App -configuration "$CONFIGURATION" -sdk "$SDK" \
    -destination "$DESTINATION" -derivedDataPath "$DERIVED" \
    -only-testing:AppUITests/AppUITests/testRenderPerformanceCard test-without-building > "$OUT_DIR/test.log" 2>&1
TEST_STATUS=$?
set -e
cd "$WEB_DIR"

if grep -q -F -- "$REVIEWER_VAULT_PASSPHRASE" "$OUT_DIR/test.log"; then
  echo "The test log contained the vault passphrase; removing the log." >&2
  rm -f "$OUT_DIR/test.log"
  exit 1
fi
grep -E "PERF_|Test Case.*(passed|failed|skipped)|\*\* TEST" "$OUT_DIR/test.log" | sed 's/^.*AppUITests\[[0-9:]*\] //' > "$OUT_DIR/gestures.log" || true

# Pull the probe's exports from the app container.
if [[ -n "${IOS_DEVICE_ID:-}" ]]; then
  xcrun devicectl device copy from --device "$IOS_DEVICE_ID" --domain-type appDataContainer \
    --domain-identifier "$BUNDLE_ID" --source Documents/hushh-perf --destination "$OUT_DIR/probe" \
    || echo "devicectl copy failed; the probe files stay on the device (Documents/hushh-perf)." >&2
else
  CONTAINER="$(xcrun simctl get_app_container "$SIM" "$BUNDLE_ID" data 2>/dev/null || true)"
  if [[ -n "$CONTAINER" && -d "$CONTAINER/Documents/hushh-perf" ]]; then
    cp "$CONTAINER"/Documents/hushh-perf/*.json "$OUT_DIR/probe/" 2>/dev/null || true
  fi
fi

COUNT="$(ls "$OUT_DIR"/probe/*.json 2>/dev/null | wc -l | tr -d ' ')"
if [[ "$COUNT" == "0" ]]; then
  echo "No probe exports were pulled (test status $TEST_STATUS); see $OUT_DIR/gestures.log" >&2
  exit 1
fi

node scripts/perf/summarize-probe-runs.mjs --runs "$OUT_DIR/probe" --gestures "$OUT_DIR/gestures.log" \
  --tier "$TIER" --sha "$SHA" --json "$OUT_DIR/summary.json" --md "$OUT_DIR/summary.md"
echo "summary: $OUT_DIR/summary.md (test status $TEST_STATUS)"
exit "$TEST_STATUS"
