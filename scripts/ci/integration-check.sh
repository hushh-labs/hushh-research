#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
WEB_DIR="$REPO_ROOT/hushh-webapp"

bash "$REPO_ROOT/scripts/ci/no-ria-feature-flags.sh"
bash "$REPO_ROOT/scripts/ci/runtime-contract-check.sh"
cd "$WEB_DIR"

npm --version

# The integration lane only owns cross-surface checks.
# Frontend typecheck/test/build stay in the dedicated Web job.
if [ ! -d node_modules/vitest ] || [ ! -x node_modules/.bin/vitest ]; then
  npm ci --prefer-offline --no-audit --progress=false
fi

cd "$REPO_ROOT"
bash "$REPO_ROOT/scripts/ci/pkm-upgrade-gate.sh"
