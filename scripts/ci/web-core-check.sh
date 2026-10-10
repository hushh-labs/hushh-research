#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
WEB_DIR="$REPO_ROOT/hushh-webapp"

# shellcheck source=scripts/ci/web-common.sh
source "$REPO_ROOT/scripts/ci/web-common.sh"

web_ci_preflight
web_ci_install

cd "$WEB_DIR"
npm run verify:design-system
npm run verify:docs
# Keep the local core mirror authoritative too; this costs only a few seconds.
npm run verify:ui-contracts
npm run test:ui-contract-validators
npm run typecheck
npm run lint

web_ci_build
