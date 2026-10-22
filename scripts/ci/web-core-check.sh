#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
WEB_DIR="$REPO_ROOT/hushh-webapp"

# shellcheck source=scripts/ci/web-common.sh
source "$REPO_ROOT/scripts/ci/web-common.sh"

web_ci_preflight
web_ci_install

# The standalone mail API's One sender is an authentication boundary.
(
  cd "$REPO_ROOT/deploy/mail-api"
  npm ci --ignore-scripts --no-audit --no-fund
  npm test
)

cd "$WEB_DIR"
if [ "${GITHUB_ACTIONS:-}" = true ]; then
  UI_CONTRACT_BASE_SHA="$(python3 "$REPO_ROOT/scripts/ci/resolve-ui-contract-base.py")"
  export UI_CONTRACT_BASE_SHA
fi
npm run verify:design-system
npm run verify:docs
# Keep the local core mirror authoritative too; this costs only a few seconds.
npm run verify:ui-contracts
npm run test:ui-contract-validators
npm run typecheck
npm run lint

web_ci_build
