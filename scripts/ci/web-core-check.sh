#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
WEB_DIR="$REPO_ROOT/hushh-webapp"
TOOLING_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"

# shellcheck source=scripts/ci/web-common.sh
source "$REPO_ROOT/scripts/ci/web-common.sh"

web_ci_preflight
web_ci_install
source "$TOOLING_ROOT/scripts/ci/validation-results.sh"

mail_result=0
# The standalone mail API's One sender is an authentication boundary.
(
  cd "$REPO_ROOT/deploy/mail-api" || exit 126
  npm ci --ignore-scripts --no-audit --no-fund || exit 126
  npm test
) || mail_result=$?
validation_record "Mail authentication" "$mail_result"

cd "$WEB_DIR"
if [ "${1:-}" = --recovery ]; then
  # Keep the snapshot's design and docs checks while using the reviewed UI
  # validator from Main. Its application inputs stay rooted at the sealed tree.
  : "${UI_CONTRACT_BASE_SHA:?Recovery requires its admitted comparison SHA}"
  validation_check "Design-system architecture" npm run verify:design-system
  validation_check "Documentation contracts" npm run verify:docs
  validation_check "verify:ui-contracts" node \
    "$TOOLING_ROOT/hushh-webapp/scripts/architecture/verify-ui-contracts.mjs" --source-root "$WEB_DIR"
else
  if [ "${GITHUB_ACTIONS:-}" = true ]; then
    UI_CONTRACT_BASE_SHA="$(python3 "$REPO_ROOT/scripts/ci/resolve-ui-contract-base.py")"
    export UI_CONTRACT_BASE_SHA
  fi
  validation_check "Design-system architecture" node scripts/architecture/verify-design-system.mjs --core
  validation_check "Input and runtime resources" node scripts/architecture/verify-render-performance.mjs --core
  validation_check "verify:ui-contracts" npm run verify:ui-contracts
fi
validation_check "typecheck" npm run typecheck
validation_check "lint" npm run lint

validation_check "Web build" bash -e -c 'source "$1"; web_ci_build' _ "$REPO_ROOT/scripts/ci/web-common.sh"
validation_finish
