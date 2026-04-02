#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
WEB_DIR="$REPO_ROOT/hushh-webapp"
CI_NATIVE_PARITY_REQUIRED="${CI_NATIVE_PARITY_REQUIRED:-0}"
CI_DOCS_PARITY_REQUIRED="${CI_DOCS_PARITY_REQUIRED:-0}"

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

if [ -f scripts/verify-route-contracts.cjs ]; then
  npm run verify:routes
else
  echo "⚠ WARNING: verify-route-contracts.cjs not found, skipping"
fi

if [ -f scripts/verify-tri-flow-parity.cjs ]; then
  npm run verify:tri-flow
else
  echo "⚠ WARNING: verify-tri-flow-parity.cjs not found, skipping"
fi

if [ "$CI_NATIVE_PARITY_REQUIRED" = "1" ]; then
  if [ -f scripts/verify-native-parity.cjs ]; then
    npm run verify:parity
  else
    echo "⚠ WARNING: verify-native-parity.cjs not found, skipping"
  fi

  if [ -f scripts/verify-capacitor-runtime-config.cjs ]; then
    npm run verify:capacitor:config
  else
    echo "⚠ WARNING: verify-capacitor-runtime-config.cjs not found, skipping"
  fi

  if [ -f scripts/verify-capacitor-routes.cjs ]; then
    npm run verify:capacitor:routes
  else
    echo "⚠ WARNING: verify-capacitor-routes.cjs not found, skipping"
  fi

  if [ -f scripts/verify-native-browser-compat.cjs ]; then
    npm run verify:native:browser-compat
  else
    echo "⚠ WARNING: verify-native-browser-compat.cjs not found, skipping"
  fi
else
  echo "Skipping native parity checks in integration-check (CI_NATIVE_PARITY_REQUIRED=0)."
fi

if [ "$CI_DOCS_PARITY_REQUIRED" = "1" ]; then
  if node -e 'const pkg=require("./package.json"); process.exit(pkg.scripts && pkg.scripts["verify:docs"] ? 0 : 1)' >/dev/null 2>&1; then
    npm run verify:docs
  elif [ -f "$REPO_ROOT/scripts/verify-doc-links.cjs" ]; then
    node "$REPO_ROOT/scripts/verify-doc-links.cjs"
  else
    echo "⚠ WARNING: docs/runtime verifier not found, skipping"
  fi
else
  echo "Skipping docs link parity in integration-check (CI_DOCS_PARITY_REQUIRED=0)."
fi
