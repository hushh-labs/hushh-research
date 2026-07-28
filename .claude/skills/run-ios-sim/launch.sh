#!/usr/bin/env bash
#
# Build the hushh One webapp, sync it into the native iOS shell, and launch it on
# an iPhone simulator against the UAT backend. See SKILL.md for the why.
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
BACKEND="https://consent-protocol-f2gsa4kfsq-uc.a.run.app"
BUNDLE_ID="com.hushh.app"
SCHEME="App"
DERIVED_DATA="/tmp/hushh-ios-dd"

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SKILL_DIR/../../.." && pwd)"
WEBAPP="$REPO_ROOT/hushh-webapp"
PROJECT="$WEBAPP/ios/App/App.xcodeproj"

say() { printf '\n\033[1;34m▸ %s\033[0m\n' "$1"; }
die() { printf '\n\033[1;31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

# --- 1. Node 22 (required for cap sync) -------------------------------------
say "Selecting Node 22 (nvm)"
# shellcheck disable=SC1090
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  source "$HOME/.nvm/nvm.sh"
  nvm use 22 >/dev/null || die "nvm: Node 22 not installed (run: nvm install 22)"
fi
node -v | grep -q '^v22' || die "Node 22 required, got $(node -v)"

# --- 2. UAT backend reachable? ----------------------------------------------
say "Checking UAT backend is reachable"
code="$(curl -s -o /dev/null -w '%{http_code}' "$BACKEND/" || true)"
[ "$code" = "200" ] || die "UAT backend not reachable (HTTP $code): $BACKEND"

# --- 3. Build the web bundle against UAT (NOT localhost) ---------------------
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

say "Building web bundle (cap:build) against UAT backend"
export NEXT_PUBLIC_BACKEND_URL="$BACKEND"   # GOTCHA #1: do NOT let localhost:8000 bake in
NODE_OPTIONS=--max-old-space-size=8192 npm run cap:build

# --- 4. Sync into the native shell ------------------------------------------
say "Syncing web bundle + plugins into iOS (cap:sync:ios)"
npm run cap:sync:ios

# --- 5. Boot the simulator ---------------------------------------------------
say "Booting simulator $UDID"
xcrun simctl list devices | grep -q "$UDID" || die "Simulator $UDID not found (xcrun simctl list devices)"
xcrun simctl boot "$UDID" 2>/dev/null || true   # already-booted is fine
open -a Simulator
say "Waiting for simulator to finish booting"
until xcrun simctl list devices | grep "$UDID" | grep -q "Booted"; do sleep 2; done

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

# --- 7. Install + launch -----------------------------------------------------
say "Installing and launching $BUNDLE_ID"
xcrun simctl install "$UDID" "$APP_PATH"
xcrun simctl launch "$UDID" "$BUNDLE_ID"

# --- 8. Confirm the correct backend is baked in ------------------------------
say "Verifying baked-in backend (expect 'consent-protocol', never '127.0.0.1:8000')"
sleep 6
baked="$(xcrun simctl spawn "$UDID" log show --last 25s --predicate 'process=="App"' 2>/dev/null | grep -oE 'consent-protocol|127\.0\.0\.1:8000' | head -1 || true)"
case "$baked" in
  consent-protocol) printf '\033[1;32m✓ Using UAT backend.\033[0m\n' ;;
  127.0.0.1:8000)   die "localhost baked in — GOTCHA #1 regressed. Rebuild with NEXT_PUBLIC_BACKEND_URL set." ;;
  *)                printf '\033[1;33m… backend not seen in log yet (app may still be starting).\033[0m\n' ;;
esac

printf '\n\033[1;32m✓ App launched on %s.\033[0m\n' "$UDID"
printf '  • Screenshot:  xcrun simctl io %s screenshot /tmp/onepoint-sim.png\n' "$UDID"
printf '  • Live log:    xcrun simctl spawn %s log show --last 120s --predicate '\''process == "App"'\''\n' "$UDID"
printf '  • Login is auth+vault gated (UAT test number + OTP 000000, then unlock vault).\n'
