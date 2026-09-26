#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
WEB_DIR="$REPO_ROOT/hushh-webapp"

"$REPO_ROOT/scripts/ci/web-core-check.sh"

cd "$WEB_DIR"
# Bound Vitest fan-out so local and hosted runs have a predictable resource
# envelope. A loaded developer host can use one worker without changing the gate.
WEB_TEST_MAX_WORKERS="${HUSHH_WEB_TEST_MAX_WORKERS:-2}"
[[ "$WEB_TEST_MAX_WORKERS" =~ ^[1-9][0-9]*$ ]] || {
  echo "HUSHH_WEB_TEST_MAX_WORKERS must be a positive integer" >&2
  exit 2
}
npm run test:ci -- --maxWorkers="$WEB_TEST_MAX_WORKERS"
npm run verify:voice-gateway
npm run verify:one-voice
npm run verify:surface-map
npm run verify:capacitor:static
# The tri-flow signature check: TypeScript registerPlugin interfaces against
# iOS CAPPluginMethod and Android @PluginMethod declarations, plus both
# registration sites. It is the only gate that actually catches a method
# implemented on one platform and not the other, and until now it ran in no CI
# script at all -- so web/iOS/Android drift was detectable and undetected.
npm run verify:capacitor:plugins
