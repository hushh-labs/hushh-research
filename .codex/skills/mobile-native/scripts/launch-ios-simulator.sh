#!/usr/bin/env bash
#
# Build the hushh One webapp, sync it into the native iOS shell, and launch it on
# an iPhone simulator with the selected native profile, without desktop focus.
#
# Usage: launch.sh [SIMULATOR_UDID]
#
set -euo pipefail

# --- config -----------------------------------------------------------------
# Resolve the simulator instead of pinning a UDID: Xcode updates retire device
# types, and a hardcoded UDID silently points at a simulator that no longer
# exists (the failure surfaces late, after a full web build). Prefer an already
# booted iPhone, else the newest available one.
pick_simulator() {
  xcrun simctl list devices available --json 2>/dev/null | python3 -c '
import json, sys
data = json.load(sys.stdin).get("devices", {})
phones = [d for runtime in data.values() for d in runtime if d.get("name", "").startswith("iPhone")]
if not phones:
    sys.exit(1)
booted = [d for d in phones if d.get("state") == "Booted"]
print((booted or phones)[-1]["udid"])
'
}

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

# --- 1. Node 22 (required for cap sync) -------------------------------------
say "Selecting Node 22"
if ! node -v | grep -q '^v22'; then
  # shellcheck disable=SC1090
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    source "$HOME/.nvm/nvm.sh"
    nvm use 22 >/dev/null || die "nvm: Node 22 not installed (run: nvm install 22)"
  fi
fi
node -v | grep -q '^v22' || die "Node 22 required, got $(node -v)"

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

say "Building web bundle (cap:build) for the selected profile"
export NEXT_PUBLIC_BACKEND_URL="$BACKEND"
NODE_OPTIONS=--max-old-space-size=8192 npm run cap:build

# --- 4. Sync into the native shell ------------------------------------------
say "Syncing web bundle + plugins into iOS (cap:sync:ios)"
npm run cap:sync:ios

# --- 5. Boot the simulator ---------------------------------------------------
say "Booting simulator $UDID"
simulator_state() {
  xcrun simctl list devices available --json | python3 -c '
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
  xcrun simctl boot "$UDID" || die "Simulator boot request failed"
fi
say "Waiting for simulator readiness in the background"
boot_deadline=$((SECONDS + 120))
until [ "$(simulator_state)" = "Booted" ]; do
  [ "$SECONDS" -lt "$boot_deadline" ] || die "Simulator boot timed out"
  sleep 2
done

# --- 6. Build the app for the simulator -------------------------------------
say "Building $SCHEME for iphonesimulator (DerivedData: $DERIVED_DATA)"
xcodebuild \
  -project "$PROJECT" \
  -scheme "$SCHEME" \
  -configuration Debug \
  -destination "id=$UDID" \
  -derivedDataPath "$DERIVED_DATA" \
  -sdk iphonesimulator \
  build

APP_PATH="$DERIVED_DATA/Build/Products/Debug-iphonesimulator/App.app"
[ -d "$APP_PATH" ] || die "Built app not found at $APP_PATH"

# --- 7. Verify the actual bundle before installing --------------------------
bash "$WEBAPP/scripts/native/verify-ios-bundled-backend.sh"   "$APP_PATH/capacitor.config.json" "$BACKEND"
BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP_PATH/Info.plist")"
[ -n "$BUNDLE_ID" ] || die "Built app has no bundle identifier"

say "Installing and launching the verified bundle in the background"
xcrun simctl install "$UDID" "$APP_PATH"
xcrun simctl launch "$UDID" "$BUNDLE_ID"
printf '\nApp launched on %s. Bundled backend verified; authenticated journeys remain separate.\n' "$UDID"
