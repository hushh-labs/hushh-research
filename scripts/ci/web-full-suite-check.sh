#!/usr/bin/env bash
set -euo pipefail

# The half of web-full that web-core does not already cover: the whole Vitest
# suite and the contract verifiers that ran only in Queue Validation.
#
# PR Validation runs this as its own lane ("Web Full Suite (Vitest)"), in
# parallel with web-core, so a pull request that touches the frontend cannot
# merge with a red unit test. Until 2026-09 the full suite ran only in the merge
# queue, which every maintainer bypasses, so ~9,600 tests gated nothing.
# web-full-check.sh is web-core-check.sh followed by this script.

REPO_ROOT="$(git rev-parse --show-toplevel)"
WEB_DIR="$REPO_ROOT/hushh-webapp"

# shellcheck source=scripts/ci/web-common.sh
source "$REPO_ROOT/scripts/ci/web-common.sh"

web_ci_preflight
web_ci_install

cd "$WEB_DIR"
# Preserve the pod branch's bounded worker envelope in the new owning lane.
WEB_TEST_MAX_WORKERS="${HUSHH_WEB_TEST_MAX_WORKERS:-2}"
[[ "$WEB_TEST_MAX_WORKERS" =~ ^[1-9][0-9]*$ ]] || {
  echo "HUSHH_WEB_TEST_MAX_WORKERS must be a positive integer" >&2
  exit 2
}
npm run verify:voice-gateway
npm run verify:capability-graph
npm run verify:surface-map
npm run verify:capacitor:static
# The tri-flow signature check: TypeScript registerPlugin interfaces against
# iOS CAPPluginMethod and Android @PluginMethod declarations, plus both
# registration sites. It is the only gate that actually catches a method
# implemented on one platform and not the other.
npm run verify:capacitor:plugins

# Fail on static/generated drift before spending time on the full suite.
# Its 41 One Voice files already run here (522 tests in run 36379443842);
# keep verify:one-voice available for focused local use.
npm run test:ci -- --maxWorkers="$WEB_TEST_MAX_WORKERS"
