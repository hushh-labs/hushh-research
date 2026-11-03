#!/usr/bin/env bash
set -euo pipefail

# Runs Vitest coverage and the contract verifiers not owned by web-core.
# CI supplies an exact changed-file plan and a focused/release level; local
# callers default to the historical full suite. Diagnostic shards retain the
# prior full-suite interface for explicit use.

REPO_ROOT="$(git rev-parse --show-toplevel)"
WEB_DIR="$REPO_ROOT/hushh-webapp"

# shellcheck source=scripts/ci/web-common.sh
source "$REPO_ROOT/scripts/ci/web-common.sh"

# WEB_FULL_SUITE_SHARD=<index>/<count> is retained for the historical full
# diagnostic suite. Focused/release selection runs only on shard 1; other
# selected shards exit before package preflight and install. Contract verifiers
# are non-Vitest checks and run once on shard 1. With no validation level, local
# callers run the full suite and every verifier.
# Guarded by hushh-webapp/scripts/testing/affected-tests.test.mjs.
SHARD="${WEB_FULL_SUITE_SHARD:-}"
RUN_VERIFIERS=1
SHARD_INDEX=""
if [ -n "$SHARD" ]; then
  if ! [[ "$SHARD" =~ ^([1-9][0-9]*)/([1-9][0-9]*)$ ]] \
    || [ "${BASH_REMATCH[1]}" -gt "${BASH_REMATCH[2]}" ]; then
    echo "WEB_FULL_SUITE_SHARD must be <index>/<count> with 1 <= index <= count, got '$SHARD'." >&2
    exit 2
  fi
  if [ "${BASH_REMATCH[1]}" != "1" ]; then
    RUN_VERIFIERS=0
  fi
  SHARD_INDEX="${BASH_REMATCH[1]}"
fi

# Resolve the exact test selection before dependency setup so non-owning matrix
# shards can exit without installing packages. If selection cannot be trusted,
# the helper emits diagnostic mode and every historical shard still runs.
ensure_ui_contract_parser() {
  if (cd "$WEB_DIR" && node -e "import('./scripts/architecture/ui-source-index.mjs')" >/dev/null 2>&1); then
    return 0
  fi

  echo "Installing the locked UI contract parser before resolving affected tests."
  (
    cd "$WEB_DIR/scripts/architecture/ui-contract-tools"
    npm ci --ignore-scripts --no-audit --progress=false
  )
}

ensure_ui_contract_parser

PLAN_FILE="$(mktemp "${TMPDIR:-/tmp}/hushh-web-vitest-plan.XXXXXX")"
trap 'rm -f "$PLAN_FILE"' EXIT
node "$WEB_DIR/scripts/testing/affected-tests.mjs" plan >"$PLAN_FILE"
EFFECTIVE_LEVEL="$(node -e 'try { const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(["focused", "release", "diagnostic"].includes(p.effectiveLevel) ? p.effectiveLevel : "diagnostic"); } catch { process.stdout.write("diagnostic"); }' "$PLAN_FILE")"
if [ -n "$SHARD_INDEX" ] && [ "$EFFECTIVE_LEVEL" != "diagnostic" ] && [ "$SHARD_INDEX" != "1" ]; then
  echo "Vitest selection is $EFFECTIVE_LEVEL; shard $SHARD is not scheduled for affected tests."
  exit 0
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
  # verify:voice-gateway already owns Siri. Preserve the standalone combined
  # capacitor command while running its remaining parity verifier exactly once.
  node ./scripts/native/verify-native-static-parity.mjs
  # The tri-flow signature check: TypeScript registerPlugin interfaces against
  # iOS CAPPluginMethod and Android @PluginMethod declarations, plus both
  # registration sites. It is the only gate that actually catches a method
  # implemented on one platform and not the other.
  npm run verify:capacitor:plugins
fi

# Fail on static/generated drift before spending time on the full suite.
# Its 41 One Voice files already run here (522 tests in run 36379443842);
# keep verify:one-voice available for focused local use.
RUN_ARGS=("--max-workers=$WEB_TEST_MAX_WORKERS")
if [ -n "$SHARD" ]; then RUN_ARGS+=("--shard=$SHARD"); fi
node ./scripts/testing/affected-tests.mjs run "$PLAN_FILE" "${RUN_ARGS[@]}"
