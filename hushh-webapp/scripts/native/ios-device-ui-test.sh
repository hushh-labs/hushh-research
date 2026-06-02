#!/bin/zsh

set -euo pipefail

PROJECT="ios/App/App.xcodeproj"
SCHEME="App"
DERIVED_DATA_PATH="${IOS_DERIVED_DATA_PATH:-ios/App/build/DerivedData}"
SDK="${IOS_TEST_SDK:-iphoneos}"
TEST_FILTER="${IOS_DEVICE_UI_TEST:-AppUITests/AppUITests/testReviewerUiInteractionFlows}"

resolve_connected_iphone_id() {
  xcrun xctrace list devices 2>/dev/null | awk '
    /^== Devices ==/ { in_devices = 1; next }
    /^== Simulators ==/ { in_devices = 0; next }
    in_devices && /iPhone/ {
      if (match($0, /\([0-9A-Fa-f-]{20,}\)$/)) {
        print substr($0, RSTART + 1, RLENGTH - 2)
        exit
      }
    }
  '
}

DEVICE_ID="${IOS_DEVICE_ID:-$(resolve_connected_iphone_id)}"
if [[ -z "${DEVICE_ID}" ]]; then
  echo "No connected iPhone found. Connect and trust an iPhone, or set IOS_DEVICE_ID." >&2
  exit 1
fi

DESTINATION="${IOS_TEST_DESTINATION:-platform=iOS,id=${DEVICE_ID}}"

eval "$(node ./scripts/testing/export-reviewer-test-env.mjs)"

if [[ -z "${HUSHH_UI_TEST_REVIEWER_UID}" || -z "${HUSHH_UI_TEST_REVIEWER_VAULT_PASSPHRASE}" ]]; then
  echo "Missing REVIEWER_UID / REVIEWER_VAULT_PASSPHRASE for device UI automation." >&2
  exit 1
fi

if [[ "${IOS_UI_FLOW_FILTER:-}" == "native-investor-kai-import-e2e" ]]; then
  export HUSHH_UI_TEST_INITIAL_ROUTE="${HUSHH_UI_TEST_INITIAL_ROUTE:-/login?redirect=%2Fkai}"
  export HUSHH_UI_TEST_EXPECTED_MARKER="${HUSHH_UI_TEST_EXPECTED_MARKER:-native-route-kai-home}"
  export HUSHH_UI_TEST_EXPECTED_ROUTE="${HUSHH_UI_TEST_EXPECTED_ROUTE:-/kai}"
fi

echo "==> reviewer identity loaded for device UI automation"

COMMON_FLAGS=(
  -project "$PROJECT"
  -scheme "$SCHEME"
  -sdk "$SDK"
  -destination "$DESTINATION"
  -derivedDataPath "$DERIVED_DATA_PATH"
  -allowProvisioningUpdates
  -parallel-testing-enabled NO
  -maximum-parallel-testing-workers 1
)

kill_process_tree() {
  local pid="$1"
  local child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    kill_process_tree "$child"
  done
  kill -TERM "$pid" 2>/dev/null || true
}

run_xcodebuild_with_log() {
  local log_path="$1"
  shift
  rm -f "$log_path"
  "$@" > >(tee "$log_path") 2>&1 &
  local cmd_pid=$!
  local timeout_seconds="${IOS_XCODEBUILD_TIMEOUT_SECONDS:-600}"
  local deadline=$((SECONDS + timeout_seconds))
  local result_seen_at=-1
  local post_result_grace_seconds="${IOS_XCODEBUILD_POST_RESULT_GRACE_SECONDS:-5}"

  while kill -0 "$cmd_pid" 2>/dev/null; do
    if [[ -f "$log_path" && "$result_seen_at" -lt 0 ]] && \
      grep -Eq "Test Suite 'Selected tests' (passed|failed)" "$log_path"; then
      result_seen_at=$SECONDS
    fi

    if [[ "$result_seen_at" -ge 0 && $((SECONDS - result_seen_at)) -ge "$post_result_grace_seconds" ]]; then
      kill_process_tree "$cmd_pid"
      wait "$cmd_pid" 2>/dev/null || true
      break
    fi

    if [[ "$SECONDS" -ge "$deadline" ]]; then
      echo "xcodebuild timed out after ${timeout_seconds}s; terminating current process tree." >&2
      kill_process_tree "$cmd_pid"
      wait "$cmd_pid" 2>/dev/null || true
      break
    fi

    sleep 1
  done

  local status=0
  wait "$cmd_pid" 2>/dev/null || status=$?

  if [[ -f "$log_path" ]] && grep -q "Test Suite 'Selected tests' passed" "$log_path"; then
    return 0
  fi
  if [[ -f "$log_path" ]] && grep -q "Test Suite 'Selected tests' failed" "$log_path"; then
    return 1
  fi
  return "$status"
}

echo "==> prepare UAT native build + UI flow artifacts"
node ./scripts/native/prepare-ios-ui-test-build.mjs

echo "==> build-for-testing on connected iPhone"
run_xcodebuild_with_log /tmp/ios-device-ui-build.log xcodebuild "${COMMON_FLAGS[@]}" build-for-testing

echo "==> XCUITest UI interaction flows on device ($TEST_FILTER)"
run_xcodebuild_with_log /tmp/ios-device-ui-test.log xcodebuild "${COMMON_FLAGS[@]}" \
  -only-testing:"$TEST_FILTER" \
  test-without-building

echo "==> device UI automation finished"
