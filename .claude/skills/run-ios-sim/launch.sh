#!/usr/bin/env bash
# Compatibility entrypoint. Native environment and execution remain owner-governed.
set -euo pipefail
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SKILL_DIR/../../.." && pwd)"
source "$REPO_ROOT/.codex/skills/mobile-native/scripts/native-node22.sh"
# Preserve the legacy UAT default; callers select dev explicitly for private audit.
export APP_RUNTIME_PROFILE="${APP_RUNTIME_PROFILE:-uat}"
exec node "$REPO_ROOT/hushh-webapp/scripts/native/with-ios-native-env.mjs"   bash "$REPO_ROOT/.codex/skills/mobile-native/scripts/launch-ios-simulator.sh" "$@"
