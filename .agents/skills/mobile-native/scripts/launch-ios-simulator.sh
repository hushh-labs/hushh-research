#!/usr/bin/env bash
#
# Build the hushh One webapp, sync it into the native iOS shell, and launch it on
# an iPhone simulator with the selected native profile, without desktop focus.
#
# Usage: launch.sh [--latest-dev] [SIMULATOR_UDID]
#
set -euo pipefail

boot_deadline=$((SECONDS + 120))
bounded_simctl() {
  local remaining=$((boot_deadline - SECONDS))
  [ "$remaining" -gt 0 ] || { echo "Simulator readiness timed out" >&2; return 1; }
  python3 - "$remaining" "$@" <<'PYTHON'
import subprocess, sys
try:
    result = subprocess.run(["xcrun", "simctl", *sys.argv[2:]], timeout=int(sys.argv[1]))
except subprocess.TimeoutExpired:
    print("Simulator readiness timed out", file=sys.stderr)
    sys.exit(1)
sys.exit(result.returncode)
PYTHON
}

# --- config -----------------------------------------------------------------
# Resolve the simulator instead of pinning a UDID: Xcode updates retire device
# types, and a hardcoded UDID silently points at a simulator that no longer
# exists (the failure surfaces late, after a full web build). Prefer an already
# booted iPhone, else the newest available one.
pick_simulator() {
  bounded_simctl list devices available --json 2>/dev/null | python3 -c '
import json, sys
data = json.load(sys.stdin).get("devices", {})
phones = [d for runtime in data.values() for d in runtime if d.get("name", "").startswith("iPhone")]
if not phones:
    sys.exit(1)
booted = [d for d in phones if d.get("state") == "Booted"]
print((booted or phones)[-1]["udid"])
'
}

latest_dev=false
if [ "${1:-}" = "--latest-dev" ]; then
  latest_dev=true
  shift
fi
UDID="${1:-}"
if [ -z "$UDID" ]; then
  UDID="$(pick_simulator || true)"
fi
if [ -z "$UDID" ]; then
  printf '\n\033[1;31m✗ no available iPhone simulator (see: xcrun simctl list devices)\033[0m\n' >&2
  exit 1
fi
BACKEND="${NEXT_PUBLIC_BACKEND_URL:?Select a complete native runtime profile}"
SCHEME="App"
DERIVED_DATA="${HUSSH_IOS_DERIVED_DATA:-/tmp/hushh-ios-dd}"

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SKILL_DIR/../../../.." && pwd)"
WEBAPP="$REPO_ROOT/hushh-webapp"
PROJECT="$WEBAPP/ios/App/App.xcodeproj"

say() { printf '\n\033[1;34m▸ %s\033[0m\n' "$1"; }
die() { printf '\n\033[1;31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

# Shared Dev reviews pin the remote base and the source before starting the export.
# An explicit device keeps a second booted environment out of this installation.
dev_tip() {
  git -C "$REPO_ROOT" ls-remote --exit-code origin refs/heads/dev | awk 'NR == 1 { print $1 }'
}
if "$latest_dev"; then
  [ "${APP_RUNTIME_PROFILE:-}" = dev ] || die "--latest-dev requires the Dev runtime profile"
  [ -n "${1:-}" ] || die "Pass the Dev simulator UDID with --latest-dev"
  [ -z "$(git -C "$REPO_ROOT" status --porcelain)" ] || die "Commit the reviewed source before a latest-Dev build"
  source_head="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  base_head="$(dev_tip)" || die "Could not resolve origin/dev"
  git -C "$REPO_ROOT" merge-base --is-ancestor "$base_head" "$source_head" 2>/dev/null ||
    die "This checkout does not include Dev $base_head. Sync the named branch before building."
  say "Dev base $base_head; source $source_head; simulator $UDID; SDK $(xcrun --sdk iphonesimulator --show-sdk-version)"
fi

# --- 1. Node 22 (required for cap sync) -------------------------------------
say "Selecting Node 22"
source "$SKILL_DIR/native-node22.sh"

# --- 2. Selected backend reachable? ----------------------------------------------
say "Checking selected backend is reachable"
code="$(curl --connect-timeout 5 --max-time 15 -s -o /dev/null -w '%{http_code}' "$BACKEND/" || true)"
[ "$code" = "200" ] || die "Selected backend not reachable (HTTP $code): $BACKEND"

# --- 3. Build the web bundle for the selected profile ---------------------
cd "$WEBAPP"

# Disk check — a full disk silently corrupts the Tailwind/CSS output (classes
# ship in the JS but their utility rules go missing → e.g. a blue button with
# no background). Need a few GB of headroom for a clean Next build.
avail_gb="$(df -g "$WEBAPP" 2>/dev/null | awk 'NR==2 {print $4}')"
if [ -n "$avail_gb" ] && [ "$avail_gb" -lt 5 ]; then
  die "Only ${avail_gb}GB free — a full disk corrupts the CSS build. Free space (e.g. rm -rf $WEBAPP/.next) and retry."
fi

# CLEAN=1 forces a from-scratch build. The webpack cache (.next/cache) can serve
# a STALE Tailwind compilation after a palette/className change, so recently
# edited arbitrary classes (bg-[#007aff], …) never make it into the CSS. When in
# doubt after a styling change, run: CLEAN=1 launch.sh
if [ "${CLEAN:-0}" = "1" ]; then
  say "CLEAN=1 → removing .next and out for a from-scratch build"
  rm -rf .next out
fi

shared_dev=$(node --input-type=module -e 'import { isSharedDevSimulatorBuild } from "./scripts/native/native-build-environment.mjs"; process.stdout.write(String(isSharedDevSimulatorBuild(process.env)));')
say "Shared Dev simulator features (Chat Location and Scheduled runs): $shared_dev"
say "Building web bundle (cap:build) for the selected profile"
export NEXT_PUBLIC_BACKEND_URL="$BACKEND"
export NEXT_DIST_DIR="${NEXT_DIST_DIR:-out}"
NODE_OPTIONS=--max-old-space-size=8192 npm run cap:build

# --- 4. Sync into the native shell ------------------------------------------
say "Syncing web bundle + plugins into iOS (cap:sync:ios)"
npm run cap:sync:ios

# --- 5. Boot the simulator ---------------------------------------------------
say "Booting simulator $UDID"
boot_deadline=$((SECONDS + 120))
simulator_state() {
  bounded_simctl list devices available --json | python3 -c '
import json, sys
wanted = sys.argv[1]
for devices in json.load(sys.stdin).get("devices", {}).values():
    for device in devices:
        if device.get("udid") == wanted:
            print(device.get("state", "Unknown"))
            sys.exit(0)
sys.exit(1)
' "$UDID"
}
state="$(simulator_state)" || die "Selected simulator is unavailable"
if [ "$state" != "Booted" ]; then
  bounded_simctl boot "$UDID" || die "Simulator boot request failed"
fi
say "Waiting for simulator readiness in the background"
bounded_simctl bootstatus "$UDID" -b || die "Simulator readiness failed"

# --- 6. Build the app for the simulator -------------------------------------
say "Building $SCHEME for iphonesimulator (DerivedData: $DERIVED_DATA)"
xcodebuild \
  -project "$PROJECT" \
  -scheme "$SCHEME" \
  -configuration Debug \
  -destination "id=$UDID" \
  -derivedDataPath "$DERIVED_DATA" \
  -sdk iphonesimulator \
  "HUSHH_SHARED_DEV_SIMULATOR=$shared_dev" \
  build

APP_PATH="$DERIVED_DATA/Build/Products/Debug-iphonesimulator/App.app"
[ -d "$APP_PATH" ] || die "Built app not found at $APP_PATH"

# --- 7. Verify the actual bundle before installing --------------------------
bash "$WEBAPP/scripts/native/verify-ios-bundled-backend.sh"   "$APP_PATH/capacitor.config.json" "$BACKEND"
BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP_PATH/Info.plist")"
[ -n "$BUNDLE_ID" ] || die "Built app has no bundle identifier"

say "Installing and launching the verified bundle in the background"
if "$latest_dev"; then
  [ "$(git -C "$REPO_ROOT" rev-parse HEAD)" = "$source_head" ] && [ "$(dev_tip)" = "$base_head" ] ||
    die "Dev or the checkout changed during this build. The existing install is intact."
  if previous="$(xcrun simctl get_app_container "$UDID" "$BUNDLE_ID" app 2>/dev/null)"; then
    project_key='Print :PROJECT_ID'
    previous_project="$(/usr/libexec/PlistBuddy -c "$project_key" "$previous/GoogleService-Info.plist")"
    build_project="$(/usr/libexec/PlistBuddy -c "$project_key" "$APP_PATH/GoogleService-Info.plist")"
    [ "$previous_project" = "$build_project" ] || die "This simulator has a different environment installed. Select the Dev device."
  fi
  diff -qr "$WEBAPP/ios/App/App/public" "$APP_PATH/public" >/dev/null || die "Built web assets differ from Capacitor sync"
fi
xcrun simctl install "$UDID" "$APP_PATH"
if "$latest_dev"; then
  installed="$(xcrun simctl get_app_container "$UDID" "$BUNDLE_ID" app)"
  diff -qr "$APP_PATH/public" "$installed/public" >/dev/null || die "Installed web assets differ from the build"
  executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP_PATH/Info.plist")"
  cmp -s "$APP_PATH/$executable" "$installed/$executable" || die "Installed executable differs from the build"
  if [ -f "$APP_PATH/$executable.debug.dylib" ]; then
    cmp -s "$APP_PATH/$executable.debug.dylib" "$installed/$executable.debug.dylib" || die "Installed Debug library differs from the build"
  fi
  say "Verified installed source $source_head, Dev base $base_head, SDK $(/usr/libexec/PlistBuddy -c 'Print :DTSDKName' "$installed/Info.plist")"
fi
xcrun simctl launch "$UDID" "$BUNDLE_ID"
printf '\nApp launched on %s. Bundled backend verified; authenticated journeys remain separate.\n' "$UDID"
