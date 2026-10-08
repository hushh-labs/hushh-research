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

# WEB_FULL_SUITE_SHARD=<index>/<count> runs one Vitest shard (`vitest --shard`,
# which splits the test files so every file lands in exactly one shard). PR
# Validation runs the lane as a matrix of shards because the whole suite took
# 7-13 minutes on one runner. The contract verifiers below are not Vitest files,
# so shard 1 runs them once. Unset, the script runs the whole suite and every
# verifier, exactly as before, which is what a local run does.
# Guarded by scripts/ci/test_web_ci_lane_partition.py.
SHARD="${WEB_FULL_SUITE_SHARD:-}"
RUN_VERIFIERS=1
if [ -n "$SHARD" ]; then
  if ! [[ "$SHARD" =~ ^([1-9][0-9]*)/([1-9][0-9]*)$ ]] \
    || [ "${BASH_REMATCH[1]}" -gt "${BASH_REMATCH[2]}" ]; then
    echo "WEB_FULL_SUITE_SHARD must be <index>/<count> with 1 <= index <= count, got '$SHARD'." >&2
    exit 2
  fi
  if [ "${BASH_REMATCH[1]}" != "1" ]; then
    RUN_VERIFIERS=0
  fi
fi

web_ci_preflight
web_ci_install

cd "$WEB_DIR"
# Preserve the pod branch's bounded worker envelope in the new owning lane.
WEB_TEST_MAX_WORKERS="${HUSHH_WEB_TEST_MAX_WORKERS:-2}"
[[ "$WEB_TEST_MAX_WORKERS" =~ ^[1-9][0-9]*$ ]] || {
  echo "HUSHH_WEB_TEST_MAX_WORKERS must be a positive integer" >&2
  exit 2
}
if [ "$RUN_VERIFIERS" -eq 1 ]; then
  npm run verify:voice-gateway
  npm run verify:capability-graph
  npm run verify:surface-map
  npm run verify:capacitor:static
  # The tri-flow signature check: TypeScript registerPlugin interfaces against
  # iOS CAPPluginMethod and Android @PluginMethod declarations, plus both
  # registration sites. It is the only gate that actually catches a method
  # implemented on one platform and not the other.
  npm run verify:capacitor:plugins
fi

# Fail on static/generated drift before spending time on the full suite.
# Its 41 One Voice files already run here (522 tests in run 36379443842);
# keep verify:one-voice available for focused local use.
if [ -n "$SHARD" ]; then
  echo "== Vitest shard $SHARD =="
  npm run test:ci -- --shard="$SHARD" --maxWorkers="$WEB_TEST_MAX_WORKERS"
else
  npm run test:ci -- --maxWorkers="$WEB_TEST_MAX_WORKERS"
fi
