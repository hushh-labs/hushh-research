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
if [[ "$SDK" != "iphonesimulator" ]]; then
  echo "ios:test requires a simulator; use ios-device-ui-test.sh for physical devices." >&2
  exit 2
fi
DESTINATION="$(IOS_TEST_DEVICE_NAME="$DEVICE_NAME" node <<'NODE'
const { execFileSync } = require("node:child_process");

const deviceName = process.env.IOS_TEST_DEVICE_NAME || "iPhone 14 Plus";
const requested = new Map((process.env.IOS_TEST_DESTINATION || "")
  .split(",").filter(Boolean).map((part) => {
    const separator = part.indexOf("=");
    return [part.slice(0, separator), part.slice(separator + 1)];
  }));
if (requested.size && requested.get("platform") !== "iOS Simulator") {
  console.error("An iOS Simulator destination is required before a cold audit.");
  process.exit(2);
}
try {
  const output = execFileSync(
    "xcrun",
    ["simctl", "list", "devices", "available", "--json"],
    { encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL" }
  );
  const payload = JSON.parse(output);
  const runtimes = Object.entries(payload.devices || {}).sort(([a], [b]) => b.localeCompare(a, undefined, { numeric: true }));
  for (const [runtime, devices] of runtimes) {
    if (!runtime.includes(".iOS-")) continue;
    const os = requested.get("OS");
    if (os && os !== "latest" && !runtime.endsWith(`.iOS-${os.replaceAll(".", "-")}`)) continue;
    const device = devices.find((candidate) => candidate.isAvailable && (
      requested.has("id")
        ? candidate.udid.toLowerCase() === requested.get("id").toLowerCase()
        : candidate.name === (requested.get("name") || deviceName)
    ));
    if (device?.udid) {
      console.log(`platform=iOS Simulator,id=${device.udid}`);
      process.exit(0);
    }
  }
} catch {
  // Never start an audit without a concrete target for verified cleanup.
}
console.error("Requested iOS Simulator is unavailable; no test app was launched.");
process.exit(2);
NODE
)"
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
  local test_result=$?
  local cleanup_result=0
  trap - EXIT
  if [[ "$DESTINATION" == *",id="* ]]; then
    local device_id="${DESTINATION##*,id=}"
    device_id="${device_id%%,*}"
    python3 ./scripts/native/ios-simulator-cleanup.py "$device_id" || cleanup_result=$?
  else
    echo "Test app cleanup is unverified: an explicit simulator UUID is required." >&2
    cleanup_result=1
  fi
  if (( test_result != 0 )); then
    exit "$test_result"
  fi
  exit "$cleanup_result"
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
