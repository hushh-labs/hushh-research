#!/bin/zsh
# Run the render-performance gesture card on an iOS simulator or a connected
# iPhone, pull the in-app probe's exports, and write the baseline table.
#
#   npm run perf:ios:card                       # booted simulator, attribution only
#   IOS_DEVICE_ID=<udid> npm run perf:ios:card  # a connected iPhone: real hardware, still attribution
#
# The card drives the app through the -UITestMode bridge (reviewer login), so
# its numbers attribute on any hardware and certify on none; the summary says
# so. The certifying lane is a phone, Release, test mode off (charter).
#
# Knobs: HUSHH_PERF_REPS (default 3), HUSHH_PERF_TIER (default ios-sim on a
# simulator; REQUIRED on a device, redacted like ios-mid-2024), PERF_OUT_DIR
# (default tmp/perf/<timestamp>), PERF_SKIP_BUILD=1 to reuse the last test bundle.
#
# Reviewer identity: the passphrase comes from the env resolver
# (REVIEWER_VAULT_PASSPHRASE); the uid is asked of the backend the bundle
# targets (scripts/perf/resolve-reviewer-uid.mjs), because the env file's
# REVIEWER_UID drifts from what each lane mints. A pinned mismatch stalls the
# bootstrap (identity_mismatch); an unpinned id leaves the bridge without an
# expectedUserId, which switches off the native phone-mandate bypass and the
# card lands on /register-phone. PERF_REVIEWER_UID=<uid> overrides the
# lookup. Credentials are handed to the test runner as process environment
# only; nothing is written to disk, the log is grepped for the passphrase
# before it is kept, and only the summary is durable.
set -euo pipefail

cd "$(dirname "$0")/../.."
WEB_DIR="$(pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="${PERF_OUT_DIR:-$WEB_DIR/tmp/perf/$STAMP}"
mkdir -p "$OUT_DIR/probe"
DERIVED="${PERF_DERIVED_DATA:-/tmp/hushh-ios-dd}"
BUNDLE_ID="com.hushh.app"
REPS="${HUSHH_PERF_REPS:-3}"

# PERF_ATTACHED=1 is the truth lane: no reviewer bridge, no test mode. The app
# is launched with only the probe argument and the person holding the phone
# signs in and unlocks (then opens Finance when the log says so). With
# PERF_CONFIGURATION=Release it is the certifying run.
ATTACHED="${PERF_ATTACHED:-0}"
REVIEWER_UID=""
eval "$(node scripts/testing/export-reviewer-test-env.mjs)"
if [[ -z "${REVIEWER_VAULT_PASSPHRASE:-}" ]]; then
  echo "Reviewer passphrase did not resolve (REVIEWER_VAULT_PASSPHRASE)." >&2
  exit 1
fi
if [[ "$ATTACHED" != "1" ]]; then
  REVIEWER_UID="${PERF_REVIEWER_UID:-$(node scripts/perf/resolve-reviewer-uid.mjs)}"
  if [[ -z "$REVIEWER_UID" ]]; then
    echo "Reviewer uid did not resolve; set PERF_REVIEWER_UID or check the backend." >&2
    exit 1
  fi
fi
if [[ "$ATTACHED" == "1" ]]; then
  TEST_NAME="testRenderPerformanceCardAttached"
  ENABLE_VAR="TEST_RUNNER_HUSHH_ENABLE_PERF_ATTACHED"
else
  TEST_NAME="testRenderPerformanceCard"
  ENABLE_VAR="TEST_RUNNER_HUSHH_ENABLE_PERF_BENCHMARK"
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
  SIGNING=(-allowProvisioningUpdates)
else
  SIM="${IOS_SIMULATOR_ID:-$(xcrun simctl list devices booted -j | python3 -c 'import json,sys; d=json.load(sys.stdin); print(next((dev["udid"] for devs in d["devices"].values() for dev in devs if "iPhone" in dev["name"]), ""))')}"
  if [[ -z "$SIM" ]]; then
    echo "No booted iPhone simulator; boot one or pass IOS_SIMULATOR_ID." >&2
    exit 1
  fi
  DESTINATION="platform=iOS Simulator,id=$SIM"
  SDK="iphonesimulator"
  TIER="${HUSHH_PERF_TIER:-ios-sim}"
  CONFIGURATION="${PERF_CONFIGURATION:-Debug}"
  SIGNING=()
fi

SHA="$(git rev-parse --short HEAD)"

# The iOS app ships whatever `cap sync` last copied into ios/App/App/public.
# A bare `npx cap sync ios` resolves webDir without the native env and copies
# the stale default `out/` export (it measured a five-week-old bundle once).
# Refuse to measure unless the synced bundle is the current native export.
NATIVE_EXPORT="${NEXT_DIST_DIR:-.next-native-uat}"
if [[ ! -f "$NATIVE_EXPORT/index.html" ]]; then
  echo "No native export at $NATIVE_EXPORT; run: npm run cap:build && npm run cap:sync:ios" >&2
  exit 1
fi
if ! cmp -s "$NATIVE_EXPORT/index.html" ios/App/App/public/index.html; then
  echo "ios/App/App/public is not the current native export ($NATIVE_EXPORT); run: npm run cap:sync:ios" >&2
  exit 1
fi
# The webpack cache once served a stale stylesheet for a fresh bundle; the
# export must carry every rule globals.css produces before it is measured.
node scripts/native/verify-native-css-fresh.mjs --export "$NATIVE_EXPORT" || exit 1
echo "perf card: $DESTINATION, configuration $CONFIGURATION, tier $TIER, reps $REPS, sha $SHA"
echo "artifacts: $OUT_DIR (raw log and probe JSON stay here; only the summary is committed)"

cd ios/App
if [[ "${PERF_SKIP_BUILD:-0}" != "1" ]]; then
  # The scheme's unit-test target does @testable import App, which a Release
  # module refuses (build-for-testing compiles every test target regardless
  # of -only-testing). ENABLE_TESTABILITY keeps -O and only exports internal
  # symbols; the shell is a thin host, so the WebView's frame cost is untouched.
  xcodebuild -project App.xcodeproj -scheme App -configuration "$CONFIGURATION" -sdk "$SDK" \
    -destination "$DESTINATION" -derivedDataPath "$DERIVED" "${SIGNING[@]}" ENABLE_TESTABILITY=YES build-for-testing > "$OUT_DIR/build.log" 2>&1 \
    || { echo "build-for-testing failed; see $OUT_DIR/build.log" >&2; exit 1; }
fi

RUN_START_MS="$(( $(date +%s) * 1000 ))"
# XCTest records every typed string as a "Synthesized Event" inside the
# result bundle, which would put the passphrase on disk. The bundle goes to a
# path this run owns and is removed as soon as the test exits; the bundles
# xcodebuild also drops under DerivedData/Logs/Test for this run go with it.
# PERF_SECTION=routes walks the route inventory rather than a list written by
# hand in the test. Coverage then rots only if the inventory does, and the
# inventory is already a governed artifact (native static parity checks it).
# PERF_ROUTES overrides the selection for a narrower sweep.
PERF_ROUTE_LIST="${PERF_ROUTES:-}"
if [ "${PERF_SECTION:-}" = "routes" ] && [ -z "$PERF_ROUTE_LIST" ]; then
  # Absolute path: the card has already cd'd into ios/App by this point.
  PERF_ROUTE_LIST="$(WEB_DIR="$WEB_DIR" node -e '
    const inv = require(require("path").join(process.env.WEB_DIR, "native-route-inventory.json"));
    const routes = inv.routes
      .filter((r) => String(r.classification || "").startsWith("native-required"))
      // Signed-in surfaces only. A signed-out route (/logout) ends the
      // reviewer session for every launch after it, which turned the first
      // sweep back half into a wall of false "unreachable" results; OAuth
      // callback routes need a provider round-trip to mean anything.
      .filter((r) => r.expectedAuth === "authenticated" && r.autoReviewerLogin === true)
      .filter((r) => !String(r.classification || "").endsWith("-callback"))
      .map((r) => r.route)
      // A route carrying a path parameter needs a real id to mean anything;
      // the sweep measures the static surfaces and says so.
      .filter((r) => !r.includes("[") && !r.includes(":"));
    process.stdout.write(routes.join(","));
  ')"
  echo "perf routes: $(printf %s "$PERF_ROUTE_LIST" | awk -F, "{print NF}") native-required routes"
fi

RESULT_BUNDLE="$OUT_DIR/run.xcresult"
rm -rf "$RESULT_BUNDLE"
touch "$OUT_DIR/.run-start"

# PERF_SECTION=session walks the app in one launch and marks each stop with
# PERF_STOP; the phone's screen is captured from the Mac at every mark, for a
# pixel review of each screen next to its frame numbers. The gate is captured
# with its keyboard up before anything is typed.
SHOT_PID=""
if [[ "${PERF_SECTION:-}" == "session" && -n "${IOS_DEVICE_ID:-}" ]]; then
  mkdir -p "$OUT_DIR/shots"
  : > "$OUT_DIR/test.log"
  (
    n=0
    tail -n +1 -F "$OUT_DIR/test.log" 2>/dev/null | while IFS= read -r line; do
      case "$line" in
        *"PERF_STOP name="*)
          n=$((n + 1))
          # xcodebuild ends its lines with a carriage return; keep it out of the file name.
          name="${line##*PERF_STOP name=}"; name="${name%% *}"; name="${name//$'\r'/}"
          xcrun devicectl device capture screenshot --device "$IOS_DEVICE_ID" \
            --destination "$OUT_DIR/shots/$(printf %02d "$n")-$name.png" -q >/dev/null 2>&1 || true
          ;;
      esac
    done
  ) &
  SHOT_PID=$!
fi
set +e
env "$ENABLE_VAR=true" \
    TEST_RUNNER_HUSHH_PERF_REPS="$REPS" \
    TEST_RUNNER_HUSHH_PERF_ATTACHED_SECTION="${PERF_SECTION:-all}" \
    TEST_RUNNER_HUSHH_PERF_EXPERIMENT="${PERF_EXPERIMENT:-}" \
    TEST_RUNNER_HUSHH_PERF_ROUTES="$PERF_ROUTE_LIST" \
    TEST_RUNNER_HUSHH_UI_TEST_REVIEWER_UID="$REVIEWER_UID" \
    TEST_RUNNER_HUSHH_UI_TEST_REVIEWER_VAULT_PASSPHRASE="${HUSHH_UI_TEST_REVIEWER_VAULT_PASSPHRASE:-$REVIEWER_VAULT_PASSPHRASE}" \
    TEST_RUNNER_REVIEWER_UID="$REVIEWER_UID" \
    TEST_RUNNER_REVIEWER_VAULT_PASSPHRASE="$REVIEWER_VAULT_PASSPHRASE" \
  xcodebuild -project App.xcodeproj -scheme App -configuration "$CONFIGURATION" -sdk "$SDK" \
    -destination "$DESTINATION" -derivedDataPath "$DERIVED" "${SIGNING[@]}" \
    -resultBundlePath "$RESULT_BUNDLE" \
    -only-testing:"AppUITests/AppUITests/$TEST_NAME" test-without-building > "$OUT_DIR/test.log" 2>&1
TEST_STATUS=$?
set -e
if [[ -n "$SHOT_PID" ]]; then
  sleep 3
  pkill -P "$SHOT_PID" 2>/dev/null || true
  kill "$SHOT_PID" 2>/dev/null || true
  echo "session shots: $(ls "$OUT_DIR/shots" 2>/dev/null | wc -l | tr -d ' ') in $OUT_DIR/shots"
fi
# Session walks keep their screenshot bursts: export the image attachments
# only (typed strings live in the activity log, never in attachments), then
# the bundle goes as always.
if [[ "${PERF_SECTION:-}" == "session" && -d "$RESULT_BUNDLE" ]]; then
  mkdir -p "$OUT_DIR/bursts"
  xcrun xcresulttool export attachments --path "$RESULT_BUNDLE" --output-path "$OUT_DIR/bursts" >/dev/null 2>&1 || true
  find "$OUT_DIR/bursts" -type f ! -iname '*.png' ! -iname '*.jpg' ! -iname '*.jpeg' ! -name 'manifest.json' -delete 2>/dev/null || true
  echo "session bursts: $(find "$OUT_DIR/bursts" -type f -iname '*.png' -o -type f -iname '*.jp*g' | wc -l | tr -d ' ') in $OUT_DIR/bursts"
fi
rm -rf "$RESULT_BUNDLE"
find "$DERIVED/Logs/Test" -maxdepth 1 -name '*.xcresult' -newer "$OUT_DIR/.run-start" -print0 2>/dev/null | xargs -0 rm -rf 2>/dev/null || true
cd "$WEB_DIR"

if [[ -n "$REVIEWER_VAULT_PASSPHRASE" ]] && grep -q -F -- "$REVIEWER_VAULT_PASSPHRASE" "$OUT_DIR/test.log"; then
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
  --tier "$TIER" --sha "$SHA" --configuration "$CONFIGURATION" --test-mode "$([[ "$ATTACHED" == "1" ]] && echo 0 || echo 1)" \
  --since "$RUN_START_MS" --json "$OUT_DIR/summary.json" --md "$OUT_DIR/summary.md"
echo "summary: $OUT_DIR/summary.md (test status $TEST_STATUS)"
exit "$TEST_STATUS"
