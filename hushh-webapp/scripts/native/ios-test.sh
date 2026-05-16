#!/bin/zsh

set -euo pipefail

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
    { encoding: "utf8" }
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

echo "==> build-for-testing ($DESTINATION)"
xcodebuild "${COMMON_FLAGS[@]}" build-for-testing

echo "==> native unit tests"
xcodebuild "${COMMON_FLAGS[@]}" -only-testing:AppTests test-without-building

echo "==> native route audit"
IOS_TEST_DESTINATION="$DESTINATION" \
IOS_DERIVED_DATA_PATH="$DERIVED_DATA_PATH" \
  node ./scripts/native/ios-route-audit.mjs
