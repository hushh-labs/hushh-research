#!/usr/bin/env bash
set -euo pipefail
APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/background-publisher-test.XXXXXX")"
trap 'rm -rf "$BUILD_DIR"' EXIT
xcrun swiftc \
  "$APP_ROOT/ios/App/App/Plugins/LocationEnvelopeCrypto.swift" \
  "$APP_ROOT/ios/App/App/Plugins/BackgroundLocationPublisher.swift" \
  "$APP_ROOT/scripts/native/tests/background-location-publisher/main.swift" \
  -o "$BUILD_DIR/test"
"$BUILD_DIR/test"
