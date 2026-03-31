#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
WEB_DIR="$REPO_ROOT/hushh-webapp"
PROFILE="${PROFILE:-local}"

bash "$REPO_ROOT/scripts/env/use_profile.sh" "$PROFILE"

cd "$WEB_DIR"

npm run verify:routes
npm run verify:parity
npm run verify:capacitor:config
npm run verify:native:browser-compat
npm run cap:build:mobile
npm run verify:capacitor:routes
