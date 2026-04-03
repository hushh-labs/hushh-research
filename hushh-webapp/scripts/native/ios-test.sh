#!/bin/zsh

set -euo pipefail

PROJECT="ios/App/App.xcodeproj"
SCHEME="App"
DESTINATION="${IOS_TEST_DESTINATION:-platform=iOS Simulator,name=iPhone 14 Plus}"
COMMON_FLAGS=(
  -project "$PROJECT"
  -scheme "$SCHEME"
  -destination "$DESTINATION"
  -parallel-testing-enabled NO
  -maximum-parallel-testing-workers 1
)

echo "==> build-for-testing ($DESTINATION)"
xcodebuild "${COMMON_FLAGS[@]}" build-for-testing

echo "==> native unit tests"
xcodebuild "${COMMON_FLAGS[@]}" -only-testing:AppTests test-without-building

echo "==> native route audit"
node ./scripts/native/ios-route-audit.mjs
