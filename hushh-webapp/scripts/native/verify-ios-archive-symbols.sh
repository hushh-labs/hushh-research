#!/usr/bin/env bash
set -euo pipefail

REPAIR=false
ARCHIVE_PATH=""

usage() {
  cat >&2 <<'EOF'
Usage:
  ./scripts/native/verify-ios-archive-symbols.sh [--repair] <path-to.xcarchive>

Description:
  Verifies that the app archive contains dSYMs whose UUIDs match the app binary
  and embedded Firebase/Google frameworks. With --repair, missing or mismatched
  framework dSYMs are regenerated from the embedded framework binaries.
EOF
}

while [ "$#" -gt 0 ]; do
  case "${1:-}" in
    --repair)
      REPAIR=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [ -n "$ARCHIVE_PATH" ]; then
        echo "Unexpected extra argument: $1" >&2
        usage
        exit 1
      fi
      ARCHIVE_PATH="$1"
      shift
      ;;
  esac
done

if [ -z "$ARCHIVE_PATH" ]; then
  usage
  exit 1
fi

if [ ! -d "$ARCHIVE_PATH" ]; then
  echo "Archive not found: $ARCHIVE_PATH" >&2
  exit 1
fi

if ! command -v dwarfdump >/dev/null 2>&1; then
  echo "Missing required tool: dwarfdump" >&2
  exit 1
fi

if [ "$REPAIR" = "true" ] && ! command -v dsymutil >/dev/null 2>&1; then
  echo "Missing required tool for --repair: dsymutil" >&2
  exit 1
fi

APPLICATIONS_DIR="$ARCHIVE_PATH/Products/Applications"
APP_PATH="$(find "$APPLICATIONS_DIR" -maxdepth 1 -type d -name "*.app" -print -quit 2>/dev/null || true)"
if [ -z "$APP_PATH" ]; then
  echo "Archive does not contain an .app under: $APPLICATIONS_DIR" >&2
  exit 1
fi

DSYM_DIR="$ARCHIVE_PATH/dSYMs"
APP_NAME="$(basename "$APP_PATH")"
APP_DSYM="$DSYM_DIR/${APP_NAME}.dSYM"
APP_EXECUTABLE="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP_PATH/Info.plist" 2>/dev/null || basename "$APP_PATH" .app)"
APP_BINARY="$APP_PATH/$APP_EXECUTABLE"
FRAMEWORKS_DIR="$APP_PATH/Frameworks"

if [ ! -d "$DSYM_DIR" ]; then
  echo "Missing dSYMs directory in archive: $ARCHIVE_PATH" >&2
  exit 1
fi

uuid_list() {
  local binary_or_dsym="$1"
  dwarfdump --uuid "$binary_or_dsym" 2>/dev/null | awk '{print $2}' | sort -u
}

contains_uuid() {
  local haystack="$1"
  local needle="$2"
  printf '%s\n' "$haystack" | grep -Fxq "$needle"
}

verify_uuid_match() {
  local label="$1"
  local binary_path="$2"
  local dsym_path="$3"

  if [ ! -f "$binary_path" ]; then
    echo "Missing binary for ${label}: $binary_path" >&2
    return 1
  fi
  if [ ! -d "$dsym_path" ]; then
    echo "Missing dSYM for ${label}: $dsym_path" >&2
    return 1
  fi

  local binary_uuids
  local dsym_uuids
  binary_uuids="$(uuid_list "$binary_path")"
  dsym_uuids="$(uuid_list "$dsym_path")"

  if [ -z "$binary_uuids" ]; then
    echo "No UUIDs found in binary for ${label}: $binary_path" >&2
    return 1
  fi
  if [ -z "$dsym_uuids" ]; then
    echo "No UUIDs found in dSYM for ${label}: $dsym_path" >&2
    return 1
  fi

  local uuid
  for uuid in $binary_uuids; do
    if ! contains_uuid "$dsym_uuids" "$uuid"; then
      echo "dSYM UUID mismatch for ${label}: missing ${uuid}" >&2
      echo "  binary UUIDs: ${binary_uuids}" >&2
      echo "  dSYM UUIDs:   ${dsym_uuids}" >&2
      return 1
    fi
  done

  echo "dSYM UUID verified: ${label} (${binary_uuids//$'\n'/, })"
}

repair_framework_dsym() {
  local framework_name="$1"
  local binary_path="$2"
  local dsym_path="$3"

  echo "Repairing framework dSYM: ${framework_name}"
  rm -rf "$dsym_path"
  dsymutil "$binary_path" -o "$dsym_path"
}

verify_framework_if_embedded() {
  local framework_name="$1"
  local framework_path="$FRAMEWORKS_DIR/${framework_name}.framework"
  local binary_path="$framework_path/$framework_name"
  local dsym_path="$DSYM_DIR/${framework_name}.framework.dSYM"

  if [ ! -d "$framework_path" ]; then
    return 0
  fi

  if ! verify_uuid_match "$framework_name.framework" "$binary_path" "$dsym_path"; then
    if [ "$REPAIR" != "true" ]; then
      return 1
    fi
    repair_framework_dsym "$framework_name" "$binary_path" "$dsym_path"
    verify_uuid_match "$framework_name.framework" "$binary_path" "$dsym_path"
  fi
}

verify_uuid_match "$APP_NAME" "$APP_BINARY" "$APP_DSYM"

verify_framework_if_embedded "FirebaseAnalytics"
verify_framework_if_embedded "GoogleAdsOnDeviceConversion"
verify_framework_if_embedded "GoogleAppMeasurement"
verify_framework_if_embedded "GoogleAppMeasurementIdentitySupport"

echo "Archive dSYM verification passed: $ARCHIVE_PATH"
