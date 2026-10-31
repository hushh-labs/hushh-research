#!/bin/zsh

set -euo pipefail

if [[ "${HUSHH_ENABLE_IOS_VOICE_DEVICE_BENCHMARK:-}" != "true" ]]; then
  echo "Refusing to run the physical-device voice gate without explicit enablement." >&2
  exit 2
fi

PROJECT="ios/App/App.xcodeproj"
SCHEME="App"
RUNNER_TEMP_ROOT="${RUNNER_TEMP:-/tmp}"
REPETITIONS="${IOS_VOICE_BENCHMARK_REPETITIONS:-30}"
P95_MS="${IOS_VOICE_CAPTURE_P95_MS:-300}"
EXPECTED_SHA="${IOS_EXPECTED_SOURCE_SHA:-}"
DEVICE_TIER="${IOS_VOICE_DEVICE_TIER:-}"

if [[ ! "$REPETITIONS" =~ ^[0-9]+$ ]] || (( REPETITIONS < 30 )); then
  echo "IOS_VOICE_BENCHMARK_REPETITIONS must be at least 30." >&2
  exit 1
fi
if [[ ! "$P95_MS" =~ ^[0-9]+([.][0-9]+)?$ ]] || [[ "$P95_MS" == "0" ]]; then
  echo "IOS_VOICE_CAPTURE_P95_MS must be positive." >&2
  exit 1
fi
if [[ ! "$EXPECTED_SHA" =~ ^[0-9a-fA-F]{7,64}$ ]]; then
  echo "IOS_EXPECTED_SOURCE_SHA must be an exact source SHA." >&2
  exit 1
fi
if [[ ! "$DEVICE_TIER" =~ ^[A-Za-z0-9_-]{1,32}$ ]]; then
  echo "IOS_VOICE_DEVICE_TIER must be a redacted runner tier." >&2
  exit 1
fi

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
if [[ -z "$DEVICE_ID" ]]; then
  echo "No connected iPhone found for the automated voice benchmark." >&2
  exit 1
fi

DESTINATION="${IOS_TEST_DESTINATION:-platform=iOS,id=$DEVICE_ID}"
AUTH_ARGS=()
if [[ -n "${IOS_TEST_AUTH_KEY_PATH:-}" || -n "${IOS_TEST_AUTH_KEY_ID:-}" || -n "${IOS_TEST_AUTH_ISSUER_ID:-}" ]]; then
  if [[ -z "${IOS_TEST_AUTH_KEY_PATH:-}" || -z "${IOS_TEST_AUTH_KEY_ID:-}" || -z "${IOS_TEST_AUTH_ISSUER_ID:-}" ]]; then
    echo "iOS App Store Connect authentication must be configured completely." >&2
    exit 1
  fi
  AUTH_ARGS=(
    -authenticationKeyPath "$IOS_TEST_AUTH_KEY_PATH"
    -authenticationKeyID "$IOS_TEST_AUTH_KEY_ID"
    -authenticationKeyIssuerID "$IOS_TEST_AUTH_ISSUER_ID"
  )
fi

if [[ "$RUNNER_TEMP_ROOT" == "/" ]]; then
  echo "RUNNER_TEMP must not resolve to the filesystem root." >&2
  exit 1
fi
mkdir -p "$RUNNER_TEMP_ROOT"
WORK_DIR="$(mktemp -d "$RUNNER_TEMP_ROOT/one-voice-device.XXXXXX")"
DERIVED_DATA_PATH="$WORK_DIR/DerivedData"
RESULT_PATH="$(mktemp "$RUNNER_TEMP_ROOT/one-voice-hardware-capture.XXXXXX.json")"
RESULT_BUNDLE_PATH="$WORK_DIR/one-voice-hardware-capture.xcresult"
TEST_LOG_PATH="$WORK_DIR/one-voice-hardware-capture.log"
cleanup_runner_only_files() {
  rm -rf "$WORK_DIR"
}
trap cleanup_runner_only_files EXIT

export HUSHH_ENABLE_IOS_VOICE_DEVICE_BENCHMARK="true"
export IOS_VOICE_BENCHMARK_REPETITIONS="$REPETITIONS"
export IOS_VOICE_CAPTURE_P95_MS="$P95_MS"
export IOS_EXPECTED_SOURCE_SHA="$EXPECTED_SHA"
export IOS_VOICE_DEVICE_TIER="$DEVICE_TIER"

echo "==> automated One Voice microphone-permission bootstrap"
xcodebuild \
  -project "$PROJECT" \
  -scheme "$SCHEME" \
  -destination "$DESTINATION" \
  -derivedDataPath "$DERIVED_DATA_PATH" \
  -allowProvisioningUpdates \
  "${AUTH_ARGS[@]}" \
  -parallel-testing-enabled NO \
  -maximum-parallel-testing-workers 1 \
  -only-testing:AppUITests/OneVoiceMicrophonePermissionBootstrapTests/testAutomatedVoiceGateBootstrapsMicrophonePermission \
  test

echo "==> automated One Voice hardware capture gate"
xcodebuild \
  -project "$PROJECT" \
  -scheme "$SCHEME" \
  -destination "$DESTINATION" \
  -derivedDataPath "$DERIVED_DATA_PATH" \
  -resultBundlePath "$RESULT_BUNDLE_PATH" \
  -allowProvisioningUpdates \
  "${AUTH_ARGS[@]}" \
  -parallel-testing-enabled NO \
  -maximum-parallel-testing-workers 1 \
  -only-testing:AppTests/OneVoiceHardwareBenchmarkTests/testHardwareCaptureP95Under300Milliseconds \
  test 2>&1 | tee "$TEST_LOG_PATH"

# XCTest runs on the attached iPhone and cannot safely write to a macOS runner
# path. It emits exactly one redacted aggregate JSON marker instead. Extract
# only that marker; do not retain or upload the xcodebuild log/result bundle.
CAPTURE_JSON="$(grep -Eo 'ONE_VOICE_HARDWARE_CAPTURE_JSON=\{.*\}' "$TEST_LOG_PATH" | tail -n 1 | sed 's/^ONE_VOICE_HARDWARE_CAPTURE_JSON=//')"
if [[ -z "$CAPTURE_JSON" ]]; then
  echo "The physical-device test did not emit aggregate timing evidence." >&2
  exit 1
fi
printf '%s' "$CAPTURE_JSON" > "$RESULT_PATH"

node scripts/native/verify-ios-voice-device-result.mjs "$RESULT_PATH"

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "result_path=$RESULT_PATH" >> "$GITHUB_OUTPUT"
fi
