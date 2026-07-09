#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
WEB_DIR="$REPO_ROOT/hushh-webapp"

"$REPO_ROOT/scripts/ci/web-core-check.sh"

cd "$WEB_DIR"
npm run test:ci
npm run verify:voice-gateway
npm run verify:surface-map
npm run verify:capacitor:static
