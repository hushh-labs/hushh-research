#!/usr/bin/env bash
set -euo pipefail

ARCHIVE_PATH="${1:-}"
if [ -z "$ARCHIVE_PATH" ]; then
  echo "Usage: ./scripts/native/verify-ios-archive-symbols.sh <path-to.xcarchive>" >&2
  exit 1
fi

if [ ! -d "$ARCHIVE_PATH" ]; then
  echo "Archive not found: $ARCHIVE_PATH" >&2
  exit 1
fi

DSYM_DIR="$ARCHIVE_PATH/dSYMs"
APP_DSYM="$DSYM_DIR/App.app.dSYM"
FRAMEWORKS_DIR="$ARCHIVE_PATH/Products/Applications/App.app/Frameworks"

if [ ! -d "$DSYM_DIR" ]; then
  echo "Missing dSYMs directory in archive: $ARCHIVE_PATH" >&2
  exit 1
fi

if [ ! -d "$APP_DSYM" ]; then
  echo "Missing app dSYM: $APP_DSYM" >&2
  exit 1
fi

echo "App dSYM present: $APP_DSYM"

warn_if_missing_if_embedded() {
  local framework_name="$1"
  local framework_path="$FRAMEWORKS_DIR/${framework_name}.framework"
  local dsym_path="$DSYM_DIR/${framework_name}.framework.dSYM"
  if [ ! -d "$framework_path" ]; then
    return 0
  fi
  if [ -d "$dsym_path" ]; then
    echo "Framework dSYM present: ${framework_name}"
  else
    echo "Framework dSYM missing: ${framework_name}" >&2
  fi
}

warn_if_missing_if_embedded "FirebaseAnalytics"
warn_if_missing_if_embedded "GoogleAdsOnDeviceConversion"
warn_if_missing_if_embedded "GoogleAppMeasurement"
warn_if_missing_if_embedded "GoogleAppMeasurementIdentitySupport"
