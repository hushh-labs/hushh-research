#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR/../../.." rev-parse --show-toplevel)"
WEB_DIR="$REPO_ROOT/hushh-webapp"

usage() {
  cat <<'USAGE'
Usage:
  hushh-webapp/scripts/native/run-profile.sh --platform <ios|android> [options]

Options:
  --mode <runtime-mode>         Runtime mode (default: uat)
  --profile <runtime-profile>   Compatibility alias for --mode
  --fresh                       Clean web and platform build artifacts first
  --sync-only                   Build + sync only, do not run the native app
  --target <device-id>          Pass through a Capacitor run target
  -h, --help                    Show this help
USAGE
}

PROFILE="uat"
PLATFORM=""
FRESH=false
SYNC_ONLY=false
TARGET=""

while [ "$#" -gt 0 ]; do
  case "${1:-}" in
    --profile)
      PROFILE="${2:-}"
      shift 2
      ;;
    --mode)
      PROFILE="${2:-}"
      shift 2
      ;;
    --platform)
      PLATFORM="${2:-}"
      shift 2
      ;;
    --fresh)
      FRESH=true
      shift
      ;;
    --sync-only)
      SYNC_ONLY=true
      shift
      ;;
    --target)
      TARGET="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ "$PLATFORM" != "ios" && "$PLATFORM" != "android" ]]; then
  echo "--platform must be ios or android" >&2
  exit 1
fi

bash "$REPO_ROOT/scripts/env/use_profile.sh" "$PROFILE"

if [ "$PROFILE" = "local" ]; then
  echo "local selected: make sure the backend is running locally (npm run backend)."
fi

cd "$WEB_DIR"

if [ "$FRESH" = "true" ]; then
  npm run cap:clean:web
  npm run "cap:clean:${PLATFORM}"
fi

if [[ "$PLATFORM" = "ios" ]]; then
  bash scripts/native/ensure-ios-signing.sh
fi

npm run cap:build:mobile
REQUIRE_LOCAL_MOBILE_SECRETS=1 \
bash scripts/native/with-local-mobile-secrets.sh npx cross-env CAPACITOR_PLATFORM="$PLATFORM" npx cap sync "$PLATFORM"

if [ "$SYNC_ONLY" = "true" ]; then
  exit 0
fi

run_args=("$PLATFORM")
if [ -n "$TARGET" ]; then
  run_args+=(--target "$TARGET")
fi
REQUIRE_LOCAL_MOBILE_SECRETS=1 \
bash scripts/native/with-local-mobile-secrets.sh npx cap run "${run_args[@]}"
