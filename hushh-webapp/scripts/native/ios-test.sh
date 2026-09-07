#!/bin/zsh

set -euo pipefail

if [[ "${HUSHH_ALLOW_DESTRUCTIVE_NATIVE_AUDIT:-}" != "true" ]]; then
  echo "ios:test is a destructive cold-start audit and is disabled by default. Use npm run ios:continuity:local for normal-session continuity, or npm run ios:cold:audit for an intentional reset." >&2
  exit 2
fi

PROJECT="ios/App/App.xcodeproj"
SCHEME="App"
DEVICE_NAME="${IOS_TEST_DEVICE_NAME:-iPhone 14 Plus}"
SDK="${IOS_TEST_SDK:-iphonesimulator}"
DERIVED_DATA_PATH="${IOS_DERIVED_DATA_PATH:-ios/App/build/DerivedData}"
if [[ -n "${IOS_TEST_DESTINATION:-}" ]]; then
  DESTINATION="$IOS_TEST_DESTINATION"
else
  DESTINATION="$(IOS_TEST_DEVICE_NAME="$DEVICE_NAME" node <<'NODE'
const { execFileSync } = require("node:child_process");

const deviceName = process.env.IOS_TEST_DEVICE_NAME || "iPhone 14 Plus";
try {
  const output = execFileSync(
    "xcrun",
    ["simctl", "list", "devices", "available", "--json"],
    { encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL" }
  );
  const payload = JSON.parse(output);
  for (const devices of Object.values(payload.devices || {})) {
    const device = devices.find((candidate) => candidate.name === deviceName && candidate.isAvailable);
    if (device?.udid) {
      console.log(`platform=iOS Simulator,id=${device.udid}`);
      process.exit(0);
    }
  }
} catch (error) {
  // Fall through to the human-readable destination below.
}
console.log(`platform=iOS Simulator,name=${deviceName}`);
NODE
)"
fi
COMMON_FLAGS=(
  -project "$PROJECT"
  -scheme "$SCHEME"
  -sdk "$SDK"
  -destination "$DESTINATION"
  -derivedDataPath "$DERIVED_DATA_PATH"
  -parallel-testing-enabled NO
  -maximum-parallel-testing-workers 1
)

cleanup_native_test_app() {
  if [[ "$DESTINATION" == *",id="* ]]; then
    local device_id="${DESTINATION##*,id=}"
    python3 - "$device_id" <<'PYTHON' >/dev/null 2>&1 || true
import subprocess, sys
try:
    subprocess.run(["xcrun", "simctl", "terminate", sys.argv[1], "com.hushh.app"], timeout=15)
except subprocess.TimeoutExpired:
    sys.exit(1)
PYTHON
  fi
}

# This script runs only behind the explicit cold-audit gate above. Always
# terminate the launched test process—even when xcodebuild or a child audit is
# interrupted—without clearing the simulator's normal user data.
trap cleanup_native_test_app EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "==> native unit tests"
# App-hosted XCTest bundles are installed alongside a freshly built test host.
# `test-without-building` can retain a prior simulator bundle path after an app
# install, then launch an ordinary app process and fail before any assertion.
xcodebuild "${COMMON_FLAGS[@]}" -only-testing:AppTests test

echo "==> native route audit"
IOS_TEST_DESTINATION="$DESTINATION" \
IOS_DERIVED_DATA_PATH="$DERIVED_DATA_PATH" \
  node ./scripts/native/ios-route-audit.mjs

echo "==> native UI interaction audit"
IOS_TEST_DESTINATION="$DESTINATION" \
IOS_DERIVED_DATA_PATH="$DERIVED_DATA_PATH" \
  node ./scripts/native/ios-ui-interaction-audit.mjs
