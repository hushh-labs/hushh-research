#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
WEB_DIR="$REPO_ROOT/hushh-webapp"

bash "$REPO_ROOT/scripts/ci/no-ria-feature-flags.sh"
bash "$REPO_ROOT/scripts/ci/runtime-contract-check.sh"
cd "$WEB_DIR"

npm --version

# Integration runs on fresh CI runners as well as warm local worktrees.
# Install web deps when vitest isn't available so the PKM gate can load the local config.
if [ ! -d node_modules/vitest ] || [ ! -x node_modules/.bin/vitest ]; then
  npm ci --prefer-offline --no-audit --progress=false
fi

cd "$REPO_ROOT"
bash "$REPO_ROOT/scripts/ci/pkm-upgrade-gate.sh"

cd "$WEB_DIR"
npm run typecheck
npm run test:ci
npm run build
