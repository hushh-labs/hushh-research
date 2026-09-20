#!/bin/zsh
# Run the render-performance gesture card on a connected Android phone, pull
# the in-app probe's exports and HWUI's gfxinfo, and write the baseline table.
#
#   ANDROID_SERIAL=<serial> npm run perf:android:card                 # attribution: Debug, test bridge on
#   PERF_ATTACHED=1 ANDROID_SERIAL=<serial> npm run perf:android:card # truth lane: bridge off, UIAutomator unlock
#   PERF_ATTACHED=1 PERF_CONFIGURATION=Release ... npm run perf:android:card  # certifying (perf build type)
#
# Attribution lane: the debug APK is launched through the native test bridge
# (reviewer login + vault passphrase as intent extras, exactly as
# scripts/native/android-ui-interaction-audit.mjs does) plus the probe
# extras HUSHH_PERF_PROBE / HUSHH_PERF_ROUTE, and scripts/perf/android-perf-gestures.mjs
# drives the gestures over adb. Its numbers attribute and certify nothing.
#
# Truth lane (PERF_ATTACHED=1): the app is launched by
# android/app/src/androidTest/java/com/hussh/app/AttachedRenderPerfTest.kt with
# only the probe extras; the vault is unlocked with the passphrase method
# (never biometrics) typed by UIAutomator; the reviewer bridge and its status
# poll are absent. With PERF_CONFIGURATION=Release it builds the `perf` build
# type (release settings, debuggable false, debug-signed so it installs) and
# the summary says certifies=true.
#
# Knobs: HUSHH_PERF_REPS (default 3), HUSHH_PERF_TIER (default
# android-flagship-2024; redacted, never a device name), PERF_OUT_DIR
# (default tmp/perf/android-<timestamp>), PERF_SKIP_BUILD=1 (reuse the last
# web export, sync and APK), PERF_SECTION=feed|kai|location|all,
# PERF_THIRD_PARTY=1 (also flick Threads and X, gfxinfo only), ADB.
#
# The passphrase comes from the env resolver (REVIEWER_VAULT_PASSPHRASE) and
# reaches the phone only on a command line built by a script (`am start
# --es` / `am instrument -e`); it is never written to disk. Every file kept
# under PERF_OUT_DIR is grepped for it at the end and removed if it appears.
set -euo pipefail

cd "$(dirname "$0")/../.."
WEB_DIR="$(pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="${PERF_OUT_DIR:-$WEB_DIR/tmp/perf/android-$STAMP}"
mkdir -p "$OUT_DIR/probe" "$OUT_DIR/gfx"
ADB="${ADB:-$HOME/Library/Android/sdk/platform-tools/adb}"
BUNDLE_ID="com.hussh.app"
REPS="${HUSHH_PERF_REPS:-3}"
TIER="${HUSHH_PERF_TIER:-android-flagship-2024}"
ATTACHED="${PERF_ATTACHED:-0}"
CONFIGURATION="${PERF_CONFIGURATION:-Debug}"
SECTION="${PERF_SECTION:-all}"
NATIVE_EXPORT=".next-native-android"
# The build lock is shared with the iOS lane: both export the same source tree.
BUILD_LOCK="${PERF_BUILD_LOCK:-${TMPDIR:-/tmp}/hushh-next-build.lock}"

if [[ ! "$TIER" =~ ^android-(floor|mid|flagship)-[0-9]{4}$ ]]; then
  echo "HUSHH_PERF_TIER must be a redacted tier like android-flagship-2024." >&2
  exit 1
fi
if [[ "$ATTACHED" != "1" && "$CONFIGURATION" != "Debug" ]]; then
  echo "The attribution lane needs the debug build (the test bridge only exists there); set PERF_ATTACHED=1 for Release." >&2
  exit 1
fi

# Device: ANDROID_SERIAL, else the single connected device.
if [[ -z "${ANDROID_SERIAL:-}" ]]; then
  DEVICES=("${(@f)$("$ADB" devices | awk 'NR>1 && $2=="device" {print $1}')}")
  if [[ ${#DEVICES[@]} -ne 1 || -z "${DEVICES[1]}" ]]; then
    echo "Set ANDROID_SERIAL (found ${#DEVICES[@]} ready devices)." >&2
    exit 1
  fi
  export ANDROID_SERIAL="${DEVICES[1]}"
fi
if [[ "$("$ADB" -s "$ANDROID_SERIAL" get-state 2>/dev/null || true)" != "device" ]]; then
  echo "Android device $ANDROID_SERIAL is not ready (adb get-state)." >&2
  exit 1
fi

REVIEWER_UID=""
eval "$(node scripts/testing/export-reviewer-test-env.mjs)"
if [[ -z "${REVIEWER_VAULT_PASSPHRASE:-}" ]]; then
  echo "Reviewer passphrase did not resolve (REVIEWER_VAULT_PASSPHRASE)." >&2
  exit 1
fi
BACKEND_URL="$(node scripts/native/with-android-native-env.mjs --print NEXT_PUBLIC_BACKEND_URL)"
if [[ "$ATTACHED" != "1" ]]; then
  # The env file's uid drifts from what the lane's backend mints; ask the backend.
  REVIEWER_UID="${PERF_REVIEWER_UID:-$(PERF_BACKEND_URL="$BACKEND_URL" node scripts/perf/resolve-reviewer-uid.mjs 2>/dev/null)}"
  if [[ -z "$REVIEWER_UID" ]]; then
    echo "Reviewer uid did not resolve; set PERF_REVIEWER_UID or check the backend." >&2
    exit 1
  fi
fi

SHA="$(git rev-parse --short HEAD)"
echo "perf card: android $ANDROID_SERIAL, configuration $CONFIGURATION, attached $ATTACHED, tier $TIER, reps $REPS, sha $SHA"
echo "artifacts: $OUT_DIR (raw logs, gfxinfo and probe JSON stay here; only the summary is committed)"

# ---- build: web export (under the shared lock), sync, APK ----
if [[ "$CONFIGURATION" == "Release" ]]; then
  BUILD_TYPE="perf"; APK="android/app/build/outputs/apk/perf/app-perf.apk"
  TEST_APK="android/app/build/outputs/apk/androidTest/perf/app-perf-androidTest.apk"
else
  BUILD_TYPE="debug"; APK="android/app/build/outputs/apk/debug/app-debug.apk"
  TEST_APK="android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk"
fi
if [[ "${PERF_SKIP_BUILD:-0}" != "1" ]]; then
  waited=0
  until mkdir "$BUILD_LOCK" 2>/dev/null; do
    echo "another native export is building ($BUILD_LOCK); waiting ($waited s)"
    sleep 15; waited=$((waited + 15))
  done
  # The webpack cache handed back a stale stylesheet once; clear both the
  # shared location and this dist dir's own cache before the export.
  rm -rf "$NATIVE_EXPORT/cache/webpack"
  set +e
  node ./scripts/native/clear-webpack-cache.mjs > "$OUT_DIR/build.log" 2>&1 && \
  node ./scripts/native/with-android-native-env.mjs npx cross-env CAPACITOR_BUILD=true NEXT_DIST_DIR="$NATIVE_EXPORT" \
    next build --webpack --debug-build-paths "app/**/page.tsx,!app/api/**" >> "$OUT_DIR/build.log" 2>&1
  BUILD_STATUS=$?
  set -e
  rmdir "$BUILD_LOCK" 2>/dev/null || true
  if [[ $BUILD_STATUS -ne 0 ]]; then
    echo "next build failed; see $OUT_DIR/build.log" >&2
    exit 1
  fi
  node ./scripts/native/verify-native-css-fresh.mjs --export "$NATIVE_EXPORT" || exit 1
  node ./scripts/native/sync-native-firebase-configs.mjs --platform android >> "$OUT_DIR/build.log" 2>&1
  node ./scripts/native/with-android-native-env.mjs npx cross-env CAPACITOR_PLATFORM=android NEXT_DIST_DIR="$NATIVE_EXPORT" \
    npx cap sync android >> "$OUT_DIR/build.log" 2>&1 || { echo "cap sync android failed; see $OUT_DIR/build.log" >&2; exit 1; }
  GRADLE_TASKS=(":app:assemble${(C)BUILD_TYPE}")
  [[ "$ATTACHED" == "1" ]] && GRADLE_TASKS+=(":app:assemble${(C)BUILD_TYPE}AndroidTest")
  node ./scripts/native/with-android-native-env.mjs ./android/gradlew -p android -PhushhTestBuildType="$BUILD_TYPE" \
    "${GRADLE_TASKS[@]}" >> "$OUT_DIR/build.log" 2>&1 || { echo "gradle failed; see $OUT_DIR/build.log" >&2; exit 1; }
fi
if [[ ! -f "$NATIVE_EXPORT/index.html" ]]; then
  echo "No native export at $NATIVE_EXPORT; run without PERF_SKIP_BUILD=1." >&2
  exit 1
fi
# A bare `cap sync android` resolves webDir without the native env and ships
# whatever `out/` holds; refuse to measure unless the synced bundle is this export.
if ! cmp -s "$NATIVE_EXPORT/index.html" android/app/src/main/assets/public/index.html; then
  echo "android/app/src/main/assets/public is not the current native export ($NATIVE_EXPORT); run without PERF_SKIP_BUILD=1." >&2
  exit 1
fi
if [[ ! -f "$APK" ]]; then
  echo "No APK at $APK; run without PERF_SKIP_BUILD=1." >&2
  exit 1
fi

# ---- screen: stay awake for the run (restored at the end), refuse a locked phone ----
STAY_ON_BEFORE="$("$ADB" -s "$ANDROID_SERIAL" shell settings get global stay_on_while_plugged_in 2>/dev/null | tr -d '\r' || echo 0)"
restore_screen() {
  "$ADB" -s "$ANDROID_SERIAL" shell settings put global stay_on_while_plugged_in "${STAY_ON_BEFORE:-0}" >/dev/null 2>&1 || true
}
trap restore_screen EXIT
"$ADB" -s "$ANDROID_SERIAL" shell svc power stayon true >/dev/null 2>&1 || true
"$ADB" -s "$ANDROID_SERIAL" shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1 || true
"$ADB" -s "$ANDROID_SERIAL" shell wm dismiss-keyguard >/dev/null 2>&1 || true
sleep 1
if "$ADB" -s "$ANDROID_SERIAL" shell dumpsys window 2>/dev/null | grep -qE "mDreamingLockscreen=true|mCurrentFocus=.*(Bouncer|Keyguard)"; then
  echo "The phone is locked (secure keyguard); unlock it and run again." >&2
  exit 3
fi

# ---- install (replace in place; -d allows a lower versionCode than the phone's) ----
"$ADB" -s "$ANDROID_SERIAL" shell am force-stop "$BUNDLE_ID" >/dev/null 2>&1 || true
if ! "$ADB" -s "$ANDROID_SERIAL" install -r -t -d "$APK" > "$OUT_DIR/install.log" 2>&1; then
  if grep -q "INSTALL_FAILED_UPDATE_INCOMPATIBLE" "$OUT_DIR/install.log" && [[ "${PERF_ALLOW_REINSTALL:-0}" == "1" ]]; then
    "$ADB" -s "$ANDROID_SERIAL" uninstall "$BUNDLE_ID" >> "$OUT_DIR/install.log" 2>&1 || true
    "$ADB" -s "$ANDROID_SERIAL" install -r -t -d "$APK" >> "$OUT_DIR/install.log" 2>&1 || { echo "install failed; see $OUT_DIR/install.log" >&2; exit 1; }
  else
    echo "install failed (a differently signed build is on the phone? PERF_ALLOW_REINSTALL=1 uninstalls it, losing its signed-in state); see $OUT_DIR/install.log" >&2
    exit 1
  fi
fi
if [[ "$ATTACHED" == "1" ]]; then
  "$ADB" -s "$ANDROID_SERIAL" install -r -t -d "$TEST_APK" >> "$OUT_DIR/install.log" 2>&1 || { echo "test APK install failed; see $OUT_DIR/install.log" >&2; exit 1; }
fi

# ---- run ----
RUN_START_MS="$(( $(date +%s) * 1000 - 5000 ))"
"$ADB" -s "$ANDROID_SERIAL" logcat -c >/dev/null 2>&1 || true
set +e
if [[ "$ATTACHED" == "1" ]]; then
  # The test logs PERF_* lines on the phone's clock; the driver reads them back.
  "$ADB" -s "$ANDROID_SERIAL" shell run-as "$BUNDLE_ID" rm -rf files/hushh-perf >/dev/null 2>&1 || true
  "$ADB" -s "$ANDROID_SERIAL" shell rm -rf /sdcard/Download/hushh-perf >/dev/null 2>&1 || true
  # Stream the tag for the whole run: a `logcat -d` afterwards can lose the
  # early lines to buffer eviction on a busy phone.
  "$ADB" -s "$ANDROID_SERIAL" logcat -v raw -s HUSHH_PERF:I > "$OUT_DIR/logcat.log" 2>&1 &
  LOGCAT_PID=$!
  # The passphrase is quoted for the device shell by a script, never echoed.
  "$ADB" -s "$ANDROID_SERIAL" shell am instrument -w -r \
    -e passphrase "$(python3 -c 'import shlex,sys; print(shlex.quote(sys.argv[1]))' "$REVIEWER_VAULT_PASSPHRASE")" \
    -e reps "$REPS" -e section "$SECTION" -e thirdParty "${PERF_THIRD_PARTY:-0}" \
    -e class com.hussh.app.AttachedRenderPerfTest \
    com.hussh.app.test/androidx.test.runner.AndroidJUnitRunner > "$OUT_DIR/instrument.log" 2>&1
  TEST_STATUS=$?
  sleep 1
  kill "$LOGCAT_PID" 2>/dev/null || true
  grep -E "^PERF_" "$OUT_DIR/logcat.log" > "$OUT_DIR/gestures.log" || true
  grep -q "INSTRUMENTATION_STATUS_CODE: -1\|INSTRUMENTATION_RESULT: shortMsg=" "$OUT_DIR/instrument.log" && TEST_STATUS=1
  grep -E "PERF_DISPLAY" "$OUT_DIR/gestures.log" > "$OUT_DIR/display.txt" || true
  # Exports and gfxinfo dumps: the test copies them into Download/hushh-perf
  # through MediaStore (readable by adb on every build type, run-as is not);
  # a debuggable build also still has them under files/hushh-perf.
  "$ADB" -s "$ANDROID_SERIAL" pull /sdcard/Download/hushh-perf "$OUT_DIR/pull" >/dev/null 2>&1 || true
  if [[ -d "$OUT_DIR/pull" ]]; then
    for f in "$OUT_DIR"/pull/*.json; do [[ -f "$f" ]] && mv "$f" "$OUT_DIR/probe/"; done
    for f in "$OUT_DIR"/pull/gfx-*.txt; do
      [[ -f "$f" ]] || continue
      name="$(basename "$f" .txt)"; name="${name#gfx-}"
      mv "$f" "$OUT_DIR/gfx/$name.txt"
      node scripts/perf/parse-gfxinfo.mjs --in "$OUT_DIR/gfx/$name.txt" --name "$name" --out "$OUT_DIR/gfx/$name.json"
    done
    rm -rf "$OUT_DIR/pull"
  fi
  "$ADB" -s "$ANDROID_SERIAL" shell rm -rf /sdcard/Download/hushh-perf >/dev/null 2>&1 || true
  if [[ "$BUILD_TYPE" == "debug" ]]; then
    for name in $("$ADB" -s "$ANDROID_SERIAL" exec-out run-as "$BUNDLE_ID" ls files/hushh-perf 2>/dev/null | tr -d '\r'); do
      [[ "$name" == *.json && ! -f "$OUT_DIR/probe/$name" ]] || continue
      "$ADB" -s "$ANDROID_SERIAL" exec-out run-as "$BUNDLE_ID" cat "files/hushh-perf/$name" > "$OUT_DIR/probe/$name"
    done
    "$ADB" -s "$ANDROID_SERIAL" shell run-as "$BUNDLE_ID" rm -rf files/hushh-perf >/dev/null 2>&1 || true
  fi
else
  PERF_OUT_DIR="$OUT_DIR" HUSHH_PERF_REPS="$REPS" PERF_SECTION="$SECTION" REVIEWER_UID="$REVIEWER_UID" \
    node scripts/perf/android-perf-gestures.mjs > "$OUT_DIR/driver.log" 2>&1
  TEST_STATUS=$?
fi
set -e

# ---- the passphrase must not be anywhere in what we keep ----
for f in "$OUT_DIR"/*.log "$OUT_DIR"/probe/*.json "$OUT_DIR"/gfx/*; do
  [[ -f "$f" ]] || continue
  if grep -q -F -- "$REVIEWER_VAULT_PASSPHRASE" "$f"; then
    echo "$f contained the vault passphrase; removing it." >&2
    rm -f "$f"
    TEST_STATUS=1
  fi
done

COUNT="$(ls "$OUT_DIR"/probe/*.json 2>/dev/null | wc -l | tr -d ' ')"
if [[ "$COUNT" == "0" ]]; then
  echo "No probe exports were pulled (status $TEST_STATUS); see $OUT_DIR/gestures.log" >&2
  exit 1
fi

node scripts/perf/summarize-probe-runs.mjs --runs "$OUT_DIR/probe" --gestures "$OUT_DIR/gestures.log" \
  --tier "$TIER" --sha "$SHA" --configuration "$CONFIGURATION" --test-mode "$([[ "$ATTACHED" == "1" ]] && echo 0 || echo 1)" \
  --since "$RUN_START_MS" --json "$OUT_DIR/summary.json" --md "$OUT_DIR/summary.md" > /dev/null
node scripts/perf/merge-android-gfxinfo.mjs --summary "$OUT_DIR/summary.json" --gfx "$OUT_DIR/gfx" \
  --gestures "$OUT_DIR/gestures.log" --display "$OUT_DIR/display.txt" --md "$OUT_DIR/summary.md"
echo "summary: $OUT_DIR/summary.md (status $TEST_STATUS)"
exit "$TEST_STATUS"
